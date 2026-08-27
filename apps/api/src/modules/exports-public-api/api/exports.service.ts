import { createHash } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import type { z } from 'zod';

import type { Prisma, Export as ExportRow } from '@prisma/client';

import type { Export, ExportWarning, FileAccess, ProblemErrorsItem } from '@neoting/contracts/model';
import type { createExportBody, listExportsQueryParams } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../../common/idempotency/idempotency-store.js';
import {
  dateField,
  type Page,
  type PageRequest,
  pageQuery,
  type SortField,
  toPage,
} from '../../../common/pagination/cursor.js';
import { AppException } from '../../../common/problem/problem.js';
import type { DocumentStore } from '../../ingestion-routing/index.js';
import { type BundleDocument, buildSourceDocumentBundle } from '../bundle/source-document-bundle.js';
import type { CanonicalRow, CanonicalSourceLink } from '../canonical/canonical-row.js';
import { selectEmitter } from '../emitters/select-emitter.js';
import { DocumentLinkService, MAX_LINKS_PER_CALL } from '../links/document-link.service.js';

import { documentToCanonicalRow, type ExportableDocumentRow } from './document-to-canonical.js';
import {
  type ExportFiltersRecord,
  startOfNextUtcDay,
  startOfUtcDay,
  toExport,
} from './export-record.js';

/**
 * `GET /v1/exports` and `POST /v1/exports` — **the sole egress** (D42, SoT
 * §24.3), and stage A9's whole server side.
 *
 * ## ⚠ Nothing here transmits anything, and no string may say otherwise
 *
 * This service returns bytes and a link to them. There is no ledger client, no
 * outbound call and no vendor. *Published* is an INTERNAL state meaning approved
 * and released for export; the operation is **"Export for VT"**, never "send to
 * VT", "publish to VT" or "sync". The contract states it on the operation
 * itself, and a string implying transmission is a D42 defect rather than a copy
 * preference.
 *
 * ## The lifecycle is deliberately fake
 *
 * Generation is **synchronous in the request**. There is no `QUEUED` state on
 * this lane, no worker, no BullMQ job and no progress polling — `exports.state`
 * goes straight to `succeeded`, because in ID the whole feature is a download
 * button that works rather than an export pipeline. `apps/api/CLAUDE.md`'s async
 * spine ("every ingest/extract/publish/chase/export runs through BullMQ") is the
 * shape this returns to when a real queue is worth its cost; the price of doing
 * it now is a batch cap, and the cap is real, named, and reported.
 *
 * ## This operation READS. It changes the state of nothing
 *
 * `x-nt-side-effect: ingest` — one new `Export` record, and no document moves.
 * That is not an accident of implementation, it is the reason no
 * `ActionProposal` is involved: the human authorisation already happened at the
 * Ready → Published transition, which is the super-admin act (D44). **Nothing
 * below writes to `documents`, and in particular nothing archives them** —
 * launch stage A5 removed auto-archive on release precisely because ARCHIVED is
 * past the only state this query can see, so an export that archived its own
 * input would make the second export of the same month empty.
 *
 * ## Tenancy is RLS, with no second mechanism
 *
 * Every query runs inside `scopedDb`. The `businessId` in the request body is
 * resolved through a policed `findUnique` first, so a business the caller cannot
 * reach is a **404, never a 403** — a 403 would confirm the record exists
 * (`packages/contracts/CLAUDE.md`).
 */

/**
 * ⚠ **THE BATCH CAP, and it is deliberately the same number as A8's.**
 *
 * `document-link.service.ts` refuses more than `MAX_LINKS_PER_CALL` links in one
 * call with this same `NT-EXP-003`, and the contract caps `ExportRequest.
 * documentIds` at 500 as well. Three different ceilings would mean a request
 * that passes the body schema, passes this check and then fails inside the link
 * minter with a different message — so there is one number and it is imported
 * rather than restated.
 *
 * The cap exists because generation is synchronous (see above): 500 documents is
 * 500 objects read out of storage and zipped inside one HTTP request. Over it,
 * the answer is `NT-EXP-003` **naming the cap and the actual count**, never a
 * truncated file — a short export that looked complete is the failure this whole
 * surface is designed against (§24.3.4).
 */
export const MAX_EXPORT_DOCUMENTS = MAX_LINKS_PER_CALL;

/**
 * How long the two download URLs live.
 *
 * Ten minutes. `FileAccess.expiresAt` is contracted as "minutes away, not
 * hours", and the two competing failures are a URL that dies while the
 * accountant is still reading the warnings panel, and a URL that outlives the
 * session in browser history, a `Referer` and any proxy log on the way — it is
 * bearer authority over a client's whole month of financial records with no
 * session behind it. `GET /documents/{id}/original` uses 300 because it lands in
 * an `<img src>` that renders immediately; a download the human has to decide to
 * click gets twice that and no more.
 */
export const EXPORT_URL_TTL_SECONDS = 600;

/**
 * `exports.kind` and `exports.format` are `String` columns with no enum behind
 * them and nothing else in the repo writes an `exports` row, so these two values
 * are established here. `kind` says what was exported; `format` says what the
 * bytes are, and it is read off the emitter rather than hardcoded so a future
 * emitter writing XLSX does not have to remember to change a second place.
 */
const EXPORT_KIND = 'documents';

type ListQuery = z.infer<typeof listExportsQueryParams>;
export type CreateExportRequest = z.infer<typeof createExportBody>;

/** Newest first, and — as on `GET /publishes` — not a parameter: the contract declares no sort. */
const CREATED_AT: SortField<ExportRow> = dateField<ExportRow>('createdAt', (row) => row.createdAt, false);

/** The columns an export reads off a document. Selected once, shared by the row builder and the bundle. */
const EXPORTABLE_DOCUMENT_SELECT = {
  id: true,
  businessId: true,
  inbox: true,
  docType: true,
  supplierName: true,
  customerName: true,
  documentDate: true,
  totalPence: true,
  taxPence: true,
  reference: true,
  categoryCode: true,
  s3Key: true,
  mimeType: true,
  byteHash: true,
} as const;

type SelectedDocument = ExportableDocumentRow & {
  readonly s3Key: string;
  readonly mimeType: string;
  readonly byteHash: string;
};

export class ExportsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly store: DocumentStore,
    private readonly links: DocumentLinkService,
    private readonly idempotency: IdempotencyStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * `GET /exports` — export history, newest first, keyset-paginated.
   *
   * **`file` and `bundle` are null on every row**, and that is the honest
   * answer rather than a gap: the URLs are minutes-long by contract, so a row
   * from last week has none live. `toExport`'s own comment carries the
   * reasoning. There is no 404 on this surface at all — a `businessId` RLS
   * cannot reach matches no rows and returns an empty page, because the rows
   * were already invisible and any other answer confirms the business exists.
   */
  async listExports(ctx: ScopeContext, query: ListQuery): Promise<Page<Export>> {
    const request: PageRequest<ExportRow> = {
      sort: CREATED_AT,
      order: 'desc',
      limit: query.limit,
      cursor: query.cursor,
      // The parsed query MINUS the cursor — folding the caller's position into
      // the fingerprint makes page 1's own token unmatchable on the way back and
      // 400s every page-2 request. That regression has shipped twice in this
      // repo; see `publishes.service.ts`.
      query: { ...query, cursor: undefined },
    };
    const seek = pageQuery(request);
    const filters: Prisma.ExportWhereInput =
      query.businessId === undefined ? {} : { businessId: query.businessId };

    const rows = await scopedDb(this.prisma, ctx, async (db) =>
      db.export.findMany({
        where: seek.where === undefined ? filters : { AND: [filters, seek.where] },
        orderBy: seek.orderBy as Prisma.ExportOrderByWithRelationInput[],
        take: seek.take,
      }),
    );

    const page = toPage(rows, request);
    return { data: page.data.map((row) => toExport(row)), pageInfo: page.pageInfo };
  }

  /**
   * `POST /exports` — **Export for VT**. Produces the import file and the D43
   * bundle, records what was produced, and sends nothing anywhere.
   */
  async createExport(ctx: ScopeContext, request: CreateExportRequest, idempotencyKey: string): Promise<Export> {
    const replay = await this.replayed(request.businessId, idempotencyKey, request);
    if (replay !== null) return replay;

    if (request.periodEnd < request.periodStart) {
      throw new AppException(
        'NT-VAL-001',
        HttpStatus.BAD_REQUEST,
        'The period ends before it starts',
        `${request.periodStart} to ${request.periodEnd} is not a period. Both dates are inclusive.`,
      );
    }

    // 404 and never 403 — the business is resolved through RLS, so one the
    // caller cannot reach is indistinguishable from one that does not exist.
    await this.assertBusinessReachable(ctx, request.businessId);

    const documents = await this.selectDocuments(ctx, request);
    if (documents.length === 0) {
      throw new AppException(
        'NT-EXP-001',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Nothing to export',
        `No documents reached Published in ${ukDate(request.periodStart)} to ${ukDate(request.periodEnd)} for this client.`,
      );
    }
    if (documents.length > MAX_EXPORT_DOCUMENTS) {
      throw new AppException(
        'NT-EXP-003',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Export too large',
        `An export carries at most ${MAX_EXPORT_DOCUMENTS} documents at a time and this period has more. Narrow the period and export again.`,
      );
    }

    // A8's seam, called exactly once for the batch. A document the caller
    // cannot see, or one that is unrouted, is simply absent from the map — and
    // the emitter then raises `source-link-missing` for that row rather than
    // shipping a silently linkless file (D43).
    const linksByDocument = await this.links.linksFor(
      ctx,
      documents.map((document) => document.id),
    );

    const warnings: ExportWarning[] = [];
    const rows: CanonicalRow[] = [];
    const bundleDocuments: BundleDocument[] = [];

    for (const document of documents) {
      const link = linksByDocument.get(document.id) ?? null;
      const built = documentToCanonicalRow(document, link);
      if (!built.ok) {
        warnings.push({ documentId: document.id, code: built.code, message: built.message });
        continue;
      }
      rows.push(built.row);
      // A document with no link cannot be in the bundle — the archive is keyed
      // by capability code. It is not warned about twice: the emitter has
      // already raised `source-link-missing` for the same document.
      if (link !== null) bundleDocuments.push(toBundleDocument(document, link));
    }

    if (rows.length === 0) {
      throw new AppException(
        'NT-EXP-001',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Nothing to export',
        `${documents.length} Published document(s) were found for ${ukDate(request.periodStart)} to ${ukDate(request.periodEnd)}, but none of them could be exported. ${warnings[0]?.message ?? ''}`.trim(),
      );
    }

    const emitter = selectEmitter(request.target);
    const emitted = emitter.emit(rows);
    warnings.push(...emitted.warnings);

    const bundle = await buildSourceDocumentBundle({
      documents: bundleDocuments,
      // The structural port `bundle/source-document-bundle.ts` asks for, handed
      // the config-selected store. It wants "give me the bytes at this key" and
      // nothing else, so it gets exactly that.
      readBytes: { read: (key) => this.store.get(key) },
    });
    warnings.push(...bundle.warnings);

    const period = `${request.periodStart}-to-${request.periodEnd}`;
    const file = await this.storeArtefact(ctx, request.businessId, {
      bytes: emitted.bytes,
      contentType: emitter.contentType,
      filename: `${targetSlug(request.target)}-${period}.${emitter.fileExtension}`,
    });
    const bundleFile = await this.storeArtefact(ctx, request.businessId, {
      bytes: bundle.bytes,
      contentType: 'application/zip',
      filename: `source-documents-${period}.zip`,
    });

    const record: ExportFiltersRecord = {
      documentIds: request.documentIds ?? null,
      documentCount: bundle.documentCount,
      bundleS3Key: bundleFile.key,
      warnings,
    };

    const completedAt = this.now();
    const row = await scopedDb(this.prisma, ctx, async (db) =>
      db.export.create({
        data: {
          businessId: request.businessId,
          kind: EXPORT_KIND,
          format: emitter.fileExtension,
          target: request.target,
          periodStart: startOfUtcDay(request.periodStart),
          periodEnd: startOfUtcDay(request.periodEnd),
          rowCount: emitted.rowCount,
          filters: record as unknown as Prisma.InputJsonValue,
          s3Key: file.key,
          // No QUEUED. The bytes exist before this row does, so the row is never
          // a promise about work that has not happened.
          state: 'succeeded',
          createdByUserId: ctx.actorId,
          completedAt,
        },
      }),
    );

    const response = toExport(row, { file: file.access, bundle: bundleFile.access });
    await this.remember(request.businessId, idempotencyKey, request, response);
    return response;
  }

  /**
   * The documents this export covers.
   *
   * **Only `PUBLISHED`, always** — that is where the human authorisation lives
   * (D44), and it is the contract's own first rule for this operation. The state
   * clause is not a filter the caller can widen.
   */
  private async selectDocuments(ctx: ScopeContext, request: CreateExportRequest): Promise<SelectedDocument[]> {
    const periodWhere = {
      gte: startOfUtcDay(request.periodStart),
      lt: startOfNextUtcDay(request.periodEnd),
    };
    const where: Prisma.DocumentWhereInput = {
      businessId: request.businessId,
      state: 'PUBLISHED',
      documentDate: periodWhere,
      ...(request.documentIds === undefined ? {} : { id: { in: request.documentIds } }),
    };

    const rows = await scopedDb(this.prisma, ctx, async (db) =>
      db.document.findMany({
        where,
        select: EXPORTABLE_DOCUMENT_SELECT,
        orderBy: [{ documentDate: 'asc' }, { id: 'asc' }],
        // The probe row. Governance §5.1 forbids an unbounded load, and "one
        // export's worth" is not a bound — it is however many documents reached
        // Published. One over the cap is enough to answer NT-EXP-003 honestly.
        take: MAX_EXPORT_DOCUMENTS + 1,
      }),
    );

    if (request.documentIds !== undefined) this.assertEveryNamedIdSurvived(request.documentIds, rows, request);
    return rows;
  }

  /**
   * **A named id that is not exportable is refused, never silently skipped.**
   *
   * The contract is explicit: *"An id outside the period, outside the client, or
   * not yet Published is refused rather than silently skipped — a short export
   * file that looked complete is the failure this whole surface is designed
   * against."* The reasons are not distinguished in the message, because they
   * are the same three facts an unreachable document would produce and telling
   * them apart would answer "does this id exist somewhere else".
   */
  private assertEveryNamedIdSurvived(
    documentIds: readonly string[],
    found: readonly { readonly id: string }[],
    request: CreateExportRequest,
  ): void {
    const present = new Set(found.map((row) => row.id));
    const refused = [...new Set(documentIds)].filter((id) => !present.has(id));
    if (refused.length === 0) return;

    const errors: ProblemErrorsItem[] = refused.map((id) => ({
      field: `documentIds/${id}`,
      message: `Not exportable: it is not this client's, has not reached Published, or is not dated within ${ukDate(request.periodStart)} to ${ukDate(request.periodEnd)}.`,
    }));
    throw new AppException(
      'NT-VAL-001',
      HttpStatus.BAD_REQUEST,
      'Some of those documents cannot be exported',
      `${refused.length} of the ${documentIds.length} documents named cannot be exported, so nothing was written. A file missing rows the caller asked for would look complete.`,
      errors,
    );
  }

  /** The business, or 404. RLS decides; this turns an invisible row into the right status. */
  private async assertBusinessReachable(ctx: ScopeContext, businessId: string): Promise<void> {
    const business = await scopedDb(this.prisma, ctx, async (db) =>
      db.business.findUnique({ where: { id: businessId }, select: { id: true } }),
    );
    if (business === null) {
      throw new AppException(
        'NT-VAL-001',
        HttpStatus.NOT_FOUND,
        'No such client',
        'No client business with that id is reachable.',
      );
    }
  }

  /**
   * Bytes → an object in storage → a short-lived signed URL.
   *
   * ⚠ **The artefact lands under the business's `documents/` prefix**, because
   * `DocumentStore.put` derives the key itself (`w/<businessId>/documents/
   * <sha256>`) and has no `putAt(key, bytes)`. `storage/` is outside stage A9's
   * owned paths, so this is recorded rather than worked around: the key is still
   * under `w/` (the staging IAM policy grants nothing else), still names the
   * business (so "erase practice X" has an answer), and still content-addressed,
   * so re-exporting an unchanged month overwrites one object rather than growing
   * the bucket. A dedicated `exports/` prefix is on this module's TODO.
   */
  private async storeArtefact(
    ctx: ScopeContext,
    businessId: string,
    artefact: { readonly bytes: Buffer; readonly contentType: string; readonly filename: string },
  ): Promise<{ readonly key: string; readonly access: FileAccess }> {
    const sha256 = createHash('sha256').update(artefact.bytes).digest('hex');
    const stored = await this.store.put({
      bytes: artefact.bytes,
      sha256,
      contentType: artefact.contentType,
      workspaceId: businessId,
      practiceId: ctx.practiceId ?? null,
    });

    const signed = await this.store.presignGet({
      key: stored.key,
      expiresInSeconds: EXPORT_URL_TTL_SECONDS,
      contentType: artefact.contentType,
      filename: artefact.filename,
    });

    return {
      key: stored.key,
      access: {
        url: signed.url,
        expiresAt: signed.expiresAt.toISOString(),
        mimeType: artefact.contentType,
        byteSize: artefact.bytes.length,
        filename: artefact.filename,
      },
    };
  }

  /**
   * Replay namespace is the BUSINESS, not the caller — the same rule
   * `billing.service.ts` states: `Idempotency-Key` is a client-generated UUID
   * over one shared map, and two practices must never be able to collide into
   * each other's signed download URL.
   *
   * ⚠ A replay returns the ORIGINAL response, URLs included, which is what the
   * contract asks for ("Replays return the original result rather than acting
   * twice"). A replay arriving after `EXPORT_URL_TTL_SECONDS` therefore hands
   * back links that no longer sign. That is the right trade: doing the work
   * again would mint a second `Export` row for one logical operation, which is
   * precisely the double-record idempotency exists to prevent, and a fresh
   * download is a new key away.
   */
  private async replayed(businessId: string, idempotencyKey: string, request: unknown): Promise<Export | null> {
    const record = await this.idempotency.get(storeKey(businessId, idempotencyKey));
    if (record === null) return null;
    if (record.requestHash !== fingerprint(request)) {
      throw new AppException(
        'NT-IDM-001',
        HttpStatus.CONFLICT,
        'This Idempotency-Key was already used with a different payload',
      );
    }
    return record.response as Export;
  }

  private async remember(businessId: string, idempotencyKey: string, request: unknown, response: Export): Promise<void> {
    await this.idempotency.put(storeKey(businessId, idempotencyKey), {
      requestHash: fingerprint(request),
      response,
    });
  }
}

function storeKey(businessId: string, idempotencyKey: string): string {
  return `export:create:${businessId}:${idempotencyKey}`;
}

function toBundleDocument(document: SelectedDocument, link: CanonicalSourceLink): BundleDocument {
  return {
    documentId: document.id,
    link,
    s3Key: document.s3Key,
    mimeType: document.mimeType,
    byteHash: document.byteHash,
    supplierName: document.supplierName ?? document.customerName ?? '',
    documentDate: document.documentDate === null ? '' : document.documentDate.toISOString().slice(0, 10),
    reference: document.reference ?? '',
    totalPence: document.totalPence ?? 0,
  };
}

/** `VT_TRANSACTION_PLUS` → `vt-transaction-plus`, for a download filename. */
function targetSlug(target: string): string {
  return target.toLowerCase().replace(/_/g, '-');
}

/**
 * `YYYY-MM-DD` → `DD/MM/YYYY`, for a message a UK accountant reads (rule 8).
 * Three substrings rearranged; no `Date` is constructed, for the reason
 * `formatVtDate` gives.
 */
function ukDate(calendarDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calendarDate);
  return match === null ? calendarDate : `${match[3]}/${match[2]}/${match[1]}`;
}
