import { HttpStatus } from '@nestjs/common';
import type { z } from 'zod';

import type { Prisma, Document as DocumentRow } from '@prisma/client';

import type { Document, DocumentEvent, DocumentSummary, Extraction, FileAccess } from '@neoting/contracts/model';
import type {
  listDocumentEventsQueryParams,
  listDocumentExtractionsQueryParams,
  listDocumentsQueryParams,
} from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import {
  toDocumentEvent,
  toDocumentResponse,
  toDocumentSummary,
  toExtraction,
} from '../../common/documents/document-response.js';
import {
  dateField,
  type Page,
  type PageRequest,
  pageQuery,
  scalarField,
  type SortField,
  toPage,
} from '../../common/pagination/cursor.js';
import { AppException } from '../../common/problem/problem.js';
import type { DocumentStore } from '../ingestion-routing/storage/document-store.js';

type ListQuery = z.infer<typeof listDocumentsQueryParams>;
type EventsQuery = z.infer<typeof listDocumentEventsQueryParams>;
type ExtractionsQuery = z.infer<typeof listDocumentExtractionsQueryParams>;

/**
 * How long a presigned link to an original stays valid.
 *
 * Short on purpose. The URL is **bearer authority** — anyone holding it can
 * fetch the bytes, with no session and no RLS behind it — and it goes into an
 * `<img src>`, so it lands in browser history, in a `Referer` if the page ever
 * links out, and in any proxy log on the way. Five minutes is long enough to
 * open a document and short enough that a leaked URL is worthless by the time
 * anyone finds it. The contract says the same thing in prose: *"Minutes away,
 * not hours. Re-request rather than caching it."*
 */
const ORIGINAL_URL_TTL_SECONDS = 300;

/**
 * The sortable columns, exactly the four the contract's `sort` enum allows.
 *
 * `nullable` is not cosmetic — Prisma rejects `orderBy: { col: { sort, nulls } }`
 * on a required column, so `receivedAt` (required, and the default sort) must be
 * described differently from the three optional ones. Getting it wrong 500s the
 * most common request in the API. See `common/pagination/cursor.ts`.
 */
const SORT_FIELDS = {
  receivedAt: dateField<DocumentRow>('receivedAt', (r) => r.receivedAt, false),
  documentDate: dateField<DocumentRow>('documentDate', (r) => r.documentDate, true),
  totalPence: scalarField<DocumentRow>('totalPence', (r) => r.totalPence, true),
  supplierName: scalarField<DocumentRow>('supplierName', (r) => r.supplierName, true),
} satisfies Record<ListQuery['sort'], SortField<DocumentRow>>;

/**
 * The documents read surface (issue #77, SoT §4 Stage 5).
 *
 * Five GETs and nothing else. **No method here changes state**, and that is
 * structural rather than a promise: there is no write on this service, so there
 * is no side-effect path outside Review → Approve for one to hide in
 * (Governance §10). A retry is a `document.reprocess` proposal and belongs to
 * that spine, not to a `POST /documents/{id}/retry` on this class.
 *
 * **Tenancy is RLS, everywhere, with no second mechanism.** Every query runs
 * inside `scopedDb`, which sets the GUCs the policies read; nothing here adds a
 * manual `practiceId`/`businessId` filter to *enforce* scope, because a
 * hand-written filter that disagreed with a policy would be the more permissive
 * of the two exactly when it mattered. The one `businessId` clause below is a
 * user-facing **filter** applied on top of an already-scoped set, not a guard.
 *
 * **404, never 403.** A document outside the caller's scope is invisible to
 * `findUnique` — RLS removes it before Prisma sees it — so it returns `null` and
 * these methods raise 404. There is deliberately no ownership check that could
 * raise 403, because a 403 confirms the record exists and that is the leak
 * (`packages/contracts/CLAUDE.md`).
 */
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly store: DocumentStore,
  ) {}

  /** `GET /documents` — the queue lists, keyset-paginated. */
  async listDocuments(ctx: ScopeContext, query: ListQuery): Promise<Page<DocumentSummary>> {
    const request: PageRequest<DocumentRow> = {
      sort: SORT_FIELDS[query.sort],
      order: query.order,
      limit: query.limit,
      cursor: query.cursor,
      // The parsed query MINUS the cursor, so a cursor minted for one filter set
      // is refused rather than mis-seeked against another.
      //
      // `cursor: undefined` is the load-bearing part, not tidiness. `query` is
      // the whole parsed `ListQuery`, and `cursor` is one of its fields. On page
      // 1 it is undefined and `stableStringify` drops it; on page 2 it is the
      // token the client just sent back, which `stableStringify` folds into the
      // digest — so the fingerprint stored inside the cursor could never match
      // the one recomputed when that cursor came back, and EVERY page-2 request
      // 400'd with "issued for a different set of filters". The fingerprint has
      // to cover what identifies the list, and the caller's position in it is
      // not part of that. `listChildren` had it right; this did not.
      query: { ...query, cursor: undefined },
    };
    const seek = pageQuery(request);
    const filters = buildFilters(query);

    const rows = await scopedDb(this.prisma, ctx, async (db) =>
      db.document.findMany({
        where: seek.where === undefined ? filters : { AND: [filters, seek.where] },
        orderBy: seek.orderBy as Prisma.DocumentOrderByWithRelationInput[],
        take: seek.take,
      }),
    );

    const page = toPage(rows, request);
    return { data: page.data.map(toDocumentSummary), pageInfo: page.pageInfo };
  }

  /** `GET /documents/{documentId}` — the full record, plus its accepted extraction. */
  async getDocument(ctx: ScopeContext, documentId: string): Promise<Document> {
    const row = await scopedDb(this.prisma, ctx, async (db) =>
      db.document.findUnique({
        where: { id: documentId },
        include: { extractions: { where: { isAccepted: true }, take: 1 } },
      }),
    );
    if (row === null) throw notFound();

    const accepted = row.extractions[0];
    return {
      ...toDocumentResponse(row),
      acceptedExtraction: accepted === undefined ? null : toExtraction(accepted),
    };
  }

  /** `GET /documents/{documentId}/original` — a short-lived link to the bytes, never the bytes. */
  async getDocumentOriginal(ctx: ScopeContext, documentId: string): Promise<FileAccess> {
    // Read inside the scope, presign outside it: signing is a pure local
    // computation over the key, and holding a database transaction open across
    // it would pin a connection for no reason (Governance §5.1).
    const row = await scopedDb(this.prisma, ctx, async (db) =>
      db.document.findUnique({
        where: { id: documentId },
        select: { s3Key: true, mimeType: true, byteSize: true, originalFilename: true },
      }),
    );
    if (row === null) throw notFound();

    const signed = await this.store.presignGet({
      key: row.s3Key,
      expiresInSeconds: ORIGINAL_URL_TTL_SECONDS,
      // The STORED mime type, which is magic-byte-authoritative after
      // sanitisation — not the uploader's declared one. Pinning it on the
      // response is what stops a browser sniffing the bytes and deciding an
      // uploaded file is something executable.
      contentType: row.mimeType,
      filename: row.originalFilename,
    });

    return {
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      filename: row.originalFilename,
    };
  }

  /** `GET /documents/{documentId}/events` — the per-document processing log. */
  async listDocumentEvents(
    ctx: ScopeContext,
    documentId: string,
    query: EventsQuery,
  ): Promise<Page<DocumentEvent>> {
    const page = await this.listChildren(ctx, documentId, query, EVENT_SORT, (db, where, seek) =>
      db.documentEvent.findMany({
        where,
        orderBy: seek.orderBy as Prisma.DocumentEventOrderByWithRelationInput[],
        take: seek.take,
      }),
    );
    return { data: page.data.map(toDocumentEvent), pageInfo: page.pageInfo };
  }

  /** `GET /documents/{documentId}/extractions` — every rung of the ladder that ran. */
  async listDocumentExtractions(
    ctx: ScopeContext,
    documentId: string,
    query: ExtractionsQuery,
  ): Promise<Page<Extraction>> {
    const page = await this.listChildren(ctx, documentId, query, EXTRACTION_SORT, (db, where, seek) =>
      db.extraction.findMany({
        where,
        orderBy: seek.orderBy as Prisma.ExtractionOrderByWithRelationInput[],
        take: seek.take,
      }),
    );
    return { data: page.data.map(toExtraction), pageInfo: page.pageInfo };
  }

  /**
   * Events and extractions are the same query with a different table: prove the
   * parent is reachable, then page its children.
   *
   * **The parent check is the tenancy check, and it must share this transaction.**
   * `document_events` and `extractions` have no tenant column of their own — they
   * hang off `document_id` — so the only thing standing between a caller and
   * another practice's processing log is that the parent `findUnique` came back
   * null under RLS. Running it in a separate `scopedDb` call would be two
   * transactions and two chances for the GUCs to differ; running it here means
   * one transaction, one scope, and a child query that cannot outlive the check
   * that authorised it.
   */
  private async listChildren<Row extends { id: string }>(
    ctx: ScopeContext,
    documentId: string,
    query: { cursor?: string | undefined; limit: number },
    sort: SortField<Row>,
    find: (
      db: Parameters<Parameters<typeof scopedDb<Row[]>>[2]>[0],
      where: Record<string, unknown>,
      seek: ReturnType<typeof pageQuery>,
    ) => Promise<Row[]>,
  ): Promise<Page<Row>> {
    const request: PageRequest<Row> = {
      sort,
      order: 'asc',
      limit: query.limit,
      cursor: query.cursor,
      // `documentId` is part of the identity of this list, so a cursor from one
      // document's log cannot be replayed against another's.
      query: { documentId, cursor: undefined, limit: query.limit },
    };
    const seek = pageQuery(request);

    const rows = await scopedDb(this.prisma, ctx, async (db) => {
      const parent = await db.document.findUnique({ where: { id: documentId }, select: { id: true } });
      if (parent === null) throw notFound();
      return find(db, seek.where === undefined ? { documentId } : { AND: [{ documentId }, seek.where] }, seek);
    });

    return toPage(rows, request);
  }
}

/**
 * Both child lists read **forward in time**. They are append-only histories of
 * one document: the processing log is only legible in the order it happened, and
 * the extraction ladder's story is "Textract tried, then the workhorse, then
 * judgment" — newest-first would tell it backwards.
 */
const EVENT_SORT = dateField<{ id: string; createdAt: Date }>('createdAt', (r) => r.createdAt, false);
const EXTRACTION_SORT = dateField<{ id: string; createdAt: Date }>('createdAt', (r) => r.createdAt, false);

/**
 * The user-facing filters, applied ON TOP of what RLS already narrowed to.
 *
 * Read that twice before adding anything here: nothing in this function is a
 * security boundary, including `businessId`. A caller passing a `businessId`
 * they cannot reach gets an **empty page**, not a 404 and not a 403 — the rows
 * were already invisible, and the filter simply matches none of them. That is
 * what the contract's parameter description asks for, and it is also the only
 * answer that does not confirm whether the business exists.
 */
function buildFilters(query: ListQuery): Prisma.DocumentWhereInput {
  return {
    ...(query.businessId !== undefined ? { businessId: query.businessId } : {}),
    ...(query.inbox !== undefined && query.inbox.length > 0 ? { inbox: { in: query.inbox } } : {}),
    ...(query.state !== undefined && query.state.length > 0 ? { state: { in: query.state } } : {}),
    ...(query.docType !== undefined && query.docType.length > 0 ? { docType: { in: query.docType } } : {}),
    ...(query.channel !== undefined && query.channel.length > 0 ? { channel: { in: query.channel } } : {}),
    ...(query.supplierName !== undefined
      ? { supplierName: { equals: query.supplierName, mode: 'insensitive' as const } }
      : {}),
    ...(query.parentDocumentId !== undefined ? { parentDocumentId: query.parentDocumentId } : {}),
    ...(query.receivedFrom !== undefined || query.receivedTo !== undefined
      ? {
          receivedAt: {
            // `gte` and `lt`, and the asymmetry is the contract's, not a typo:
            // `receivedFrom` is documented "Inclusive lower bound" and
            // `receivedTo` "Exclusive upper bound" (`openapi.yaml`). Half-open
            // is what makes day-by-day paging work — yesterday's `receivedTo`
            // is today's `receivedFrom`, and a document landing exactly on
            // midnight belongs to exactly one of those days rather than both.
            ...(query.receivedFrom !== undefined ? { gte: new Date(query.receivedFrom) } : {}),
            ...(query.receivedTo !== undefined ? { lt: new Date(query.receivedTo) } : {}),
          },
        }
      : {}),
    ...(query.q !== undefined
      ? {
          // `contains` is ILIKE '%q%' — deliberately a substring match and not a
          // full-text index. Real FTS needs a `tsvector` column, which is a
          // `prisma/` change and therefore a contract-change issue (G7), not
          // something to slip in here.
          //
          // ⚠ This SEQUENTIALLY SCANS every row RLS leaves visible, on every
          // search, at every needle length. A leading-wildcard ILIKE cannot use
          // a B-tree index — the contract's 2-char minimum on `q` bounds how
          // wide the *result* is, and does nothing whatever to the plan. An
          // earlier version of this comment claimed the minimum kept this off a
          // full scan; that was false, and believing it is what would stop the
          // next reader adding the `pg_trgm` GIN index this actually needs.
          OR: [
            { supplierName: { contains: query.q, mode: 'insensitive' as const } },
            { originalFilename: { contains: query.q, mode: 'insensitive' as const } },
            { reference: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };
}

/**
 * The only failure this surface raises for a row it cannot see.
 *
 * `NT-VAL-001` and not `NT-NOT-001`: **the latter does not exist.** The
 * `ErrorCode` enum in `openapi.yaml` has no dedicated not-found code, and
 * `NT-VAL-001` is the house fallback for an otherwise-uncoded 4xx
 * (`ProblemFilter.CODE_BY_STATUS`) — the same choice web-upload made for an
 * unreachable business. Inventing a code the generated client has no branch for
 * would be worse than reusing the documented fallback.
 *
 * The detail says nothing about *why*. "No document with that id, for you"
 * covers both "it does not exist" and "it is not yours", and a caller must not
 * be able to tell those apart.
 */
function notFound(): AppException {
  return new AppException(
    'NT-VAL-001',
    HttpStatus.NOT_FOUND,
    'Document not found',
    'No document with that id.',
  );
}
