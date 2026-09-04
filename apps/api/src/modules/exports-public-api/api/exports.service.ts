import { createHash } from 'node:crypto';

import { HttpStatus, Logger } from '@nestjs/common';
import type { z } from 'zod';

import type { Prisma, Export as ExportRow } from '@prisma/client';

import type { Export, ExportWarning, FileAccess, ProblemErrorsItem } from '@neoting/contracts/model';
import type { createExportBody, listExportsQueryParams } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { notDeleted } from '../../../common/documents/deleted-documents.js';
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

import { type AnalysisAccountChart, analysisAccountChart } from './analysis-account-chart.js';
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

/**
 * What this service needs from `rules-suggestions` — **the client's chart of
 * accounts, and nothing else**.
 *
 * Structural, the way `buildSourceDocumentBundle` takes `{ read }` rather than a
 * `DocumentStore`: `ChartOfAccountsService` satisfies it without knowing this
 * interface exists, the unit harness satisfies it with an object literal, and
 * `exports.module.ts` is the only place the two modules are named together —
 * through `rules-suggestions/index.ts`, its public seam.
 *
 * ⚠ **`categories` is already the emittable form.** `name` is
 * `Cost of sales: Purchases`, produced by `analysisAccount()` in
 * `rules-suggestions/chart-of-accounts/account.ts`, which is the ONE place that
 * join happens. Nothing here splits it, re-cases it or rebuilds it: VT's
 * Converter saves the accountant's mapping against the exact string it was
 * given, so a second producer of that string is a second import going manual
 * months later.
 */
export interface ChartOfAccountsReader {
  getChartOfAccounts(
    ctx: ScopeContext,
    businessId: string,
  ): Promise<{ readonly categories: readonly { readonly code: string; readonly name: string }[] }>;
}

export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly store: DocumentStore,
    private readonly links: DocumentLinkService,
    private readonly idempotency: IdempotencyStore,
    private readonly now: () => Date = () => new Date(),
    /**
     * Optional, and absence degrades to the pre-2 Sep 2026 behaviour rather than
     * to a failure: every row carries its bare `category_code` and every one of
     * them raises `analysis-account-unprefixed`. That is loud, and it is
     * recoverable; refusing to export a client's month because a picklist could
     * not be read would not be.
     */
    private readonly charts: ChartOfAccountsReader | null = null,
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
    if (documents.length === 0) throw await this.nothingToExport(ctx, request);
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

    // Once for the batch, before a single row is built. `Analysis account` is
    // resolved HERE — where a scoped read is legal — and never inside the
    // emitter, which stays a pure function over rows.
    const chart = await this.chartFor(ctx, request.businessId);

    const warnings: ExportWarning[] = [];
    const rows: CanonicalRow[] = [];
    const bundleDocuments: BundleDocument[] = [];

    for (const document of documents) {
      const link = linksByDocument.get(document.id) ?? null;
      const built = documentToCanonicalRow(document, link, chart);
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
   * `NT-EXP-001`, with the fact that turns it from a dead end into an
   * instruction.
   *
   * ## The problem this exists to fix, reported from the live app
   *
   * A practice had exactly one Published document — dated **12 May 2025** — and
   * the export screen, defaulting to last month, answered *"No documents reached
   * Published in 01/08/2026 to 31/08/2026 for this client."* The accountant read
   * that as *published, but it will not export*, and concluded the feature was
   * broken. **The code was right and the product was unhelpful**: the period
   * selects on the document's own date (see {@link selectDocuments}), May 2025
   * is genuinely outside an August 2026 window, and the refusal gave the one
   * person who could fix it nothing to act on.
   *
   * So the refusal now answers the question it provokes — *"then where ARE my
   * documents?"* — with a count and the dates they actually sit on.
   *
   * ## Why the count comes from HERE and not from the browser
   *
   * The export is the only thing that knows its own predicate. A second query in
   * the web could disagree with it — a different state clause, a different date
   * column, a `documentIds` narrowing it did not know about — and would be a
   * second read of a client's records written by someone who was not looking at
   * this file. **It runs through the same `scopedDb` as the export**, over the
   * same `PUBLISHED` predicate and the same `businessId`, with the date clause
   * and nothing else dropped. So it cannot report a document the export would
   * have refused, and it cannot cross a practice boundary: RLS decides both
   * reads identically because it is the same read.
   *
   * ## What it deliberately does not say
   *
   * Nothing when the count is zero — a client with no Published documents at all
   * gets the plain refusal, because "0 documents outside the period" is noise,
   * and because a named `documentIds` set that matched nothing must not become a
   * way to probe for documents by id. The count is capped at the export's own
   * ceiling rather than counted without bound (Governance §5.1).
   */
  private async nothingToExport(ctx: ScopeContext, request: CreateExportRequest): Promise<AppException> {
    const period = `${ukDate(request.periodStart)} to ${ukDate(request.periodEnd)}`;
    const outside = await this.publishedOutsidePeriod(ctx, request);

    if (outside === null) {
      return new AppException(
        'NT-EXP-001',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Nothing to export',
        `No document dated ${period} has reached Published for this client, and this client has no Published documents outside that period either. A document is exportable once it has been released for export.`,
      );
    }

    const range =
      outside.earliestDocumentDate === outside.latestDocumentDate
        ? `dated ${ukDate(outside.earliestDocumentDate)}`
        : `dated between ${ukDate(outside.earliestDocumentDate)} and ${ukDate(outside.latestDocumentDate)}`;

    return new AppException(
      'NT-EXP-001',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'Nothing to export in that period',
      `No document dated ${period} has reached Published for this client. ${
        outside.count === 1 ? 'There is 1 Published document' : `There are ${outside.count} Published documents`
      } outside that period, ${range} — the export selects on the document's own date, not on when it was released. Widen the period to include ${outside.count === 1 ? 'it' : 'them'}.`,
      undefined,
      { publishedOutsidePeriod: outside },
    );
  }

  /**
   * How many Published documents this client has whose date is outside the
   * requested period, and the span they cover — or `null` when there are none.
   *
   * One aggregate, same scope, same predicate minus the date clause. `_min` and
   * `_max` are the narrowest period that would include every one of them, which
   * is exactly what a "try this period instead" affordance needs.
   */
  private async publishedOutsidePeriod(
    ctx: ScopeContext,
    request: CreateExportRequest,
  ): Promise<{ count: number; earliestDocumentDate: string; latestDocumentDate: string } | null> {
    const where: Prisma.DocumentWhereInput = {
      ...this.publishedWhere(request),
      // Everything Published for this client that the period clause excluded —
      // including a document with NO date at all, which cannot be in any period
      // and would otherwise be invisible on both sides of this answer.
      NOT: { documentDate: this.periodWhere(request) },
    };

    const aggregate = await scopedDb(this.prisma, ctx, async (db) =>
      db.document.aggregate({
        where,
        _count: { _all: true },
        _min: { documentDate: true },
        _max: { documentDate: true },
      }),
    );

    const count = aggregate._count._all;
    const earliest = aggregate._min.documentDate;
    const latest = aggregate._max.documentDate;
    // A count with no dates means every one of them is undated — real, and not
    // a period any widening would reach. The plain refusal is the honest answer.
    if (count === 0 || earliest === null || latest === null) return null;

    return {
      count: Math.min(count, MAX_EXPORT_DOCUMENTS),
      earliestDocumentDate: calendarDate(earliest),
      latestDocumentDate: calendarDate(latest),
    };
  }

  /**
   * The documents this export covers.
   *
   * **Only `PUBLISHED`, always** — that is where the human authorisation lives
   * (D44), and it is the contract's own first rule for this operation. The state
   * clause is not a filter the caller can widen.
   *
   * ⚠ **The period selects on `documentDate` — the document's own date — and
   * NOT on when it reached Published.** That is the accounting answer (an
   * invoice belongs to the period it is dated in), it is what makes a re-export
   * of a closed month reproducible, and the VT journal import needs it because
   * VT applies one date to a whole file (§24.3.1). The contract states it on
   * `ExportRequest.periodStart`. The cost is that a client whose Published
   * documents are all dated outside the chosen period gets an empty export that
   * is correct and reads as broken — which is what {@link nothingToExport}
   * exists to answer.
   */
  private async selectDocuments(ctx: ScopeContext, request: CreateExportRequest): Promise<SelectedDocument[]> {
    const where: Prisma.DocumentWhereInput = {
      ...this.publishedWhere(request),
      documentDate: this.periodWhere(request),
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
   * Everything the export's predicate says EXCEPT the date, written once so the
   * refusal's count and the export's own selection cannot drift apart. The
   * `documentIds` narrowing is included deliberately: when a caller named ids,
   * "outside the period" means outside it *among the ids they named*, never a
   * count over documents they did not ask about.
   *
   * ⚠ **`notDeleted()` belongs HERE and not in `selectDocuments`, and that is
   * the whole point of this function existing.** Two callers read it and they
   * must count the same set:
   *
   * - {@link selectDocuments} — the export's actual selection. A trashed
   *   document must not reach a file an accountant hands to a client, and
   *   `PUBLISHED` does not save us: deletion is a timestamp, not a state, so a
   *   Published document keeps its state when it is deleted.
   * - {@link publishedOutsidePeriod} — the `NT-EXP-001` diagnostic's count AND
   *   its `_min`/`_max` period-widening bounds. Filtering only the selection
   *   would make this the worse bug rather than fixing one: the refusal would
   *   say *"there are 3 Published documents outside that period, widen it to
   *   include them"*, the accountant would widen it exactly as instructed, and
   *   the export would come back empty again — with the suggested bounds having
   *   been derived from a document that can never be selected. A diagnostic that
   *   counts a set its own selection cannot reach is advice that cannot be
   *   followed.
   *
   * `assertEveryNamedIdSurvived` inherits it too, which is right: a caller who
   * names a deleted document's id is refused with the existing "not
   * exportable" message rather than having it silently dropped from a file that
   * would then look complete.
   */
  private publishedWhere(request: CreateExportRequest): Prisma.DocumentWhereInput {
    return {
      businessId: request.businessId,
      state: 'PUBLISHED',
      ...notDeleted(),
      ...(request.documentIds === undefined ? {} : { id: { in: request.documentIds } }),
    };
  }

  /** The half-open day range the inclusive period means. */
  private periodWhere(request: CreateExportRequest): Prisma.DateTimeFilter {
    return { gte: startOfUtcDay(request.periodStart), lt: startOfNextUtcDay(request.periodEnd) };
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
   * The client's chart of accounts, as the `Analysis account` lookup — or
   * `null`.
   *
   * ## This is the defect the export shipped with until 2 Sep 2026
   *
   * `documents.category_code` holds a code (`SUBSCRIPTIONS`); VT Transaction+
   * wants an account name with its ledger prefix (`Cost of sales: Purchases`).
   * `document-to-canonical.ts` passed the column straight into the column, so
   * every import file carried the code — and VT type-guesses a bare cell, so a
   * numeric one arrives as a *number* rather than an account (§24.3.1).
   * `rules-suggestions/index.ts` has named this consumer on its seam since A6:
   * *"read the ready-made `{ code, name }` pairs off
   * `ChartOfAccountsService.getChartOfAccounts(...).categories`, where `name` is
   * already in that form."* This is that call.
   *
   * ## Why a failure here is a warning and not a 500
   *
   * The chart is a picklist. It is not the client's money, it is not the
   * document, and the export is ID's ONLY egress (D42) — an accountant's month
   * must not become unexportable because a reference list could not be read.
   * Losing it costs the prefix on every row, and every one of those rows then
   * raises `analysis-account-unprefixed`, which lands on the export's warnings
   * panel and on the publish review card. Loud, per document, and recoverable in
   * VT's Converter. Silence is the thing that is not available.
   *
   * ⚠ **It never substitutes a chart from somewhere else.** Not the platform's
   * generic profile, not another client's, not the accounts a code "looks like"
   * — `getChartOfAccounts` seeds this client's own on first read (it is
   * idempotent and never overwrites), and if that cannot be reached the answer
   * is `null`, which resolves nothing.
   */
  private async chartFor(ctx: ScopeContext, businessId: string): Promise<AnalysisAccountChart | null> {
    if (this.charts === null) return null;
    try {
      const chart = await this.charts.getChartOfAccounts(ctx, businessId);
      return analysisAccountChart(chart.categories);
    } catch (error) {
      this.logger.warn(
        `chart of accounts unavailable for business ${businessId} — the export will carry bare category codes and warn on each: ${String(error)}`,
      );
      return null;
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
function ukDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return match === null ? isoDate : `${match[3]}/${match[2]}/${match[1]}`;
}

/**
 * A stored instant → the calendar date it is, read in **UTC**.
 *
 * The same read `document-to-canonical.ts` makes, and for the same reason: a
 * document date was a calendar date before the column widened it into a
 * `timestamptz`, and re-interpreting midnight UTC in Europe/London during BST
 * turns 12 May into 11 May in the sentence an accountant is asked to act on.
 */
function calendarDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}
