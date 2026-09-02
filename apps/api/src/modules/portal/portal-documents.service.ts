import type { Prisma, Document as DocumentRow } from '@prisma/client';
import type { z } from 'zod';

import type { PortalDocument } from '@neoting/contracts/model';
import type { listPortalDocumentsQueryParams } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { notDeleted } from '../../common/documents/deleted-documents.js';
import { dateField, type Page, type PageRequest, pageQuery, toPage } from '../../common/pagination/cursor.js';
import { PORTAL_HIDDEN_DOCUMENT_STATE, portalDocumentStatus } from './portal-document-status.js';
import { type PortalSessionFacts, systemScopeFor } from './portal-session-context.js';

type ListQuery = z.infer<typeof listPortalDocumentsQueryParams>;

/**
 * `GET /v1/portal/documents` — what this client has sent, in their own words
 * (D49: the home tab's "Recently sent" and the upload tab's "Sent from this
 * portal", which are one list at two levels of detail).
 *
 * Until this existed the client's own side of the pipeline was a single
 * integer: `PortalSummary.documentsSent`. A client could be told they had sent
 * forty-one documents and nothing whatever about any of them — not whether the
 * receipt they photographed in a car park an hour ago had been read, not
 * whether the one their accountant asked twice for had arrived. This is that
 * list.
 *
 * ## ⚠ TENANCY: the boundary here is the QUERY, not SQL — read this before changing anything
 *
 * This read runs under `systemScopeFor(facts)`, the practice SYSTEM context,
 * for exactly the reason `portal-context.service.ts` gives for every fact it
 * returns: `prisma/sql/rls.sql` has TWO delegated branches and both key on
 * GRANTED DOCUMENT IDS (`documents_delegated_upload`,
 * `extractions_delegated_upload`). A session's grant is the documents it sent
 * ITSELF — so under the delegated context this list could only ever show the
 * client their own portal uploads, and never the email, WhatsApp or
 * accountant-uploaded documents that make up most of their file. There is no
 * RLS branch that means "this client's whole business", and inventing one is a
 * schema change and a stop-and-ask (root `CLAUDE.md`).
 *
 * So the SYSTEM context can see the whole practice, and the ONLY thing
 * narrowing it to one client is the `businessId` on the `where` below. That is
 * an **application guarantee**, not a database one, and this file says so
 * rather than overclaiming — the same honest division
 * `portal-session-context.ts` states in full.
 *
 * What makes it safe to rely on is that the filter **cannot be omitted or
 * influenced**:
 *
 * - It is resolved from `facts.businessId` — the `otp_sessions` row the server
 *   wrote when it opened the session, re-read and re-checked by the resolver on
 *   every request. Nothing on this path is derived from anything the caller
 *   sent except the bearer.
 * - `listDocuments` takes **no `businessId` parameter**, and the contract
 *   declares none on the operation. There is no argument to forget to pass and
 *   none for a caller to supply — the same move `PortalUploadRequest` makes by
 *   having no `businessId` field at all.
 * - `whereFor(facts)` is the single expression that builds it, and every query
 *   in this class goes through it.
 *
 * ## What is NOT projected, and why the shape is small
 *
 * `PortalDocument`, never `DocumentSummary`. `apps/web/src/api/onboarding.ts`
 * already draws this line for the summary: a client has no business seeing how
 * many of their documents sit in the practice's review queue or what its
 * approval backlog looks like. The same applies per row — no `state`, no
 * `inbox`, no `categoryCode`, no `failureCode`, no `retryable`. The client's
 * question is "what happened to my receipt", and `status` is the whole answer.
 *
 * Money is the integer pence the extraction recorded, straight through: no
 * arithmetic, no coercion, no float (R5).
 */
export class PortalDocumentsService {
  constructor(private readonly prisma: PrismaClient) {}

  async listDocuments(facts: PortalSessionFacts, query: ListQuery): Promise<Page<PortalDocument>> {
    const filters = whereFor(facts);
    const request: PageRequest<DocumentRow> = {
      // Newest first, and no other sort. The contract offers none: a client
      // reading "what happened to my receipt" wants the receipt they just sent,
      // and every extra sort is another index this table does not have.
      sort: RECEIVED_AT,
      order: 'desc',
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      // The cursor fingerprint covers the SESSION'S BUSINESS as well as the
      // page size, so a cursor minted against one client's list is refused
      // rather than mis-seeked against another's. `cursor: undefined` is
      // deliberate and load-bearing — the fingerprint must cover what
      // identifies the LIST, never the caller's position in it, or every page-2
      // request 400s (see `common/pagination/cursor.ts`).
      query: { businessId: facts.businessId, limit: query.limit, cursor: undefined },
    };
    const seek = pageQuery(request);

    const rows = await scopedDb(this.prisma, systemScopeFor(facts), (db) =>
      db.document.findMany({
        where: seek.where === undefined ? filters : { AND: [filters, seek.where] },
        orderBy: seek.orderBy as Prisma.DocumentOrderByWithRelationInput[],
        take: seek.take,
      }),
    );

    const page = toPage(rows, request);
    return { data: page.data.map(toPortalDocument), pageInfo: page.pageInfo };
  }
}

/** `receivedAt` is NOT NULL on `documents`, so it is the non-nullable sort field — see `SortField.nullable`. */
const RECEIVED_AT = dateField<DocumentRow>('receivedAt', (row) => row.receivedAt, false);

/**
 * The one place this endpoint's `where` is built — the whole of its tenancy,
 * and the whole of its state filter.
 *
 * `businessId` is the application guarantee described in the class header. It
 * is written here once so there is no second query on this surface that could
 * be written without it.
 *
 * `ARCHIVED` is excluded because archiving is the practice's own housekeeping
 * and none of the five client-facing words is true of an archived document —
 * see `portal-document-status.ts`. It matches `GET /documents`'s own contracted
 * default ("Omitted means every state except ARCHIVED"), so the client and the
 * accountant are looking at the same set of rows.
 *
 * ⚠ **`notDeleted()` for the same reason, one step stronger.** Archiving sets a
 * document aside; DELETING it is the practice saying it should not be in this
 * client's file at all — and this is the one surface where the person reading
 * the list is not the person who deleted it. A client who can still see a
 * document their accountant removed will re-ask about it, re-send it, or act on
 * a figure the firm has retracted. The predicate is the shared
 * `common/documents/deleted-documents.ts` one rather than an inline
 * `deletedAt: null`, so this list and `PortalSummary.documentsSent` cannot come
 * to disagree about what "sent" means.
 */
function whereFor(facts: PortalSessionFacts): Prisma.DocumentWhereInput {
  return { businessId: facts.businessId, state: { not: PORTAL_HIDDEN_DOCUMENT_STATE }, ...notDeleted() };
}

/**
 * Row → the client-facing projection.
 *
 * **`totalPence` and `currency` travel as a PAIR, or not at all.** Both columns
 * are independently nullable, and an amount with no currency code is not money
 * — it is a number a screen would render with whichever symbol it felt like.
 * A document carrying one without the other therefore reports neither, which is
 * "we have not read a total off this yet" and is true.
 *
 * `supplierName` is passed through unchanged and is **untrusted content**: it
 * comes off a scanned document. It is data on its way to a text node, never an
 * instruction, and nothing here interprets it.
 */
function toPortalDocument(row: DocumentRow): PortalDocument {
  const hasMoney = row.totalPence !== null && row.currency !== null;
  return {
    id: row.id,
    supplierName: row.supplierName,
    // A calendar date, not an instant — the same projection `toDocumentSummary`
    // makes, because it is the same column meaning the same thing.
    documentDate: row.documentDate === null ? null : row.documentDate.toISOString().slice(0, 10),
    totalPence: hasMoney ? row.totalPence : null,
    currency: hasMoney ? row.currency : null,
    channel: row.channel,
    status: portalDocumentStatus(row.state),
    receivedAt: row.receivedAt.toISOString(),
  };
}
