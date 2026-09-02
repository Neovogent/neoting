import type {
  DocumentEvent as DocumentEventRow,
  Document as DocumentRow,
  Extraction as ExtractionRow,
} from '@prisma/client';

import type { Document, DocumentEvent, DocumentSummary, Extraction } from '@neoting/contracts/model';

import { CODING_SUGGESTION_KEY, readStoredCodingSuggestion } from './coding-suggestion.js';

/**
 * Prisma row → contract shape, for every document read surface (#76 wrote the
 * first one, #77 reads through all of them).
 *
 * It lives in `common/` rather than inside either module because **two** modules
 * now project the same row onto the same contract type, and a module may not
 * reach into another's internals (`apps/api/CLAUDE.md`). The alternative — a
 * second copy under `modules/documents/` — is how the write surface and the read
 * surface start disagreeing about what a `Document` is, which is exactly the
 * drift the generated contract exists to prevent.
 */

/**
 * A Prisma `Json` column holds any JSON value. Every place the contract types
 * one as an object, this is what decides whether it really is one — `typeof
 * null === 'object'` and arrays are objects too, so both have to be excluded
 * explicitly.
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `YYYY-MM-DD` for a calendar date; the instant is dropped deliberately (it was never known). */
function toDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/**
 * Project a Prisma `Document` row onto the contract `Document` shape (#76, reused
 * by the read surface in #77). Header fields (supplier, totals, dates) are a
 * projection of the accepted extraction and are null until extraction runs — a
 * freshly RECEIVED upload has none of them yet.
 *
 * `retryable` is derived, not stored: a retry is offered only for a document the
 * Rejected/Failed view shows, and retrying is itself a `document.reprocess`
 * proposal.
 */
export function toDocumentResponse(row: DocumentRow): Document {
  return {
    ...toDocumentSummary(row),
    // ---- detail (DocumentAllOf) ----
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    byteHash: row.byteHash,
    perceptualHash: row.perceptualHash,
    submitterUserId: row.submitterUserId,
    submitterLabel: row.submitterLabel,
    receivedLocal: row.receivedLocal,
    routingDecision: (row.routingDecision as Record<string, unknown> | null) ?? null,
    routingConfidence: row.routingConfidence,
    pageRange: row.pageRange,
    acceptedExtraction: null, // set by the caller that fetched it — see `withAcceptedExtraction`
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The list shape (`DocumentSummary`). Deliberately the exact subset `Document`
 * is built from above, so a field cannot be present in one and missing from the
 * other.
 */
export function toDocumentSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    // ⚠ CONTRACT DIVERGENCE, not an oversight. `DocumentSummary.businessId` is
    // REQUIRED and non-nullable, but an UNROUTED document has `business_id =
    // null` in the database by design — "we do not yet know whose this is" is a
    // real, visible state and the Unrouted queue is a first-class surface this
    // very endpoint has to list (SoT Stage 1). So the two cannot both be
    // honoured, and `''` is the least-bad projection until the contract admits
    // null. Raised on #76; `openapi.yaml` is LAW (G7) and cannot be fixed here.
    // Callers must not treat `''` as a business id.
    businessId: row.businessId ?? '',
    inbox: row.inbox,
    state: row.state,
    docType: row.docType,
    channel: row.channel,
    originalFilename: row.originalFilename,
    receivedAt: row.receivedAt.toISOString(),
    supplierName: row.supplierName,
    customerName: row.customerName,
    documentDate: toDate(row.documentDate),
    dueDate: toDate(row.dueDate),
    currency: row.currency,
    // Pence, straight through as the integers Prisma typed them. No arithmetic,
    // no coercion — the one thing that must never happen to money on this path.
    totalPence: row.totalPence,
    taxPence: row.taxPence,
    reference: row.reference,
    categoryCode: row.categoryCode,
    description: row.description,
    projectRef: row.projectRef,
    parentDocumentId: row.parentDocumentId,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    // Derived, not stored: a retry is offered only where the Rejected/Failed
    // view shows one, and the retry itself is a `document.reprocess` proposal —
    // never a side-effect endpoint on this read surface (Governance §10).
    retryable: row.state === 'REJECTED' || row.state === 'FAILED',
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    // Trash (2 Sep 2026). It sits on the SUMMARY rather than only on the detail
    // shape deliberately: the Trash listing is `GET /documents?deleted=true`,
    // which returns summaries, and a Trash row that could not say when it was
    // deleted would be a list with nothing to sort or explain itself by.
    //
    // Null for a live document, so `deletedAt !== null` is the client-side test
    // for "this is in Trash" — the same shape as `archivedAt` one line up, and
    // for the same reason both are timestamps rather than `DocumentState`
    // members.
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
  };
}

/** One stage of the processing log. Note the contract omits `documentId` — the caller supplied it in the path. */
export function toDocumentEvent(row: DocumentEventRow): DocumentEvent {
  return {
    id: row.id,
    stage: row.stage,
    outcome: row.outcome,
    durationMs: row.durationMs,
    traceId: row.traceId,
    // The contract says `detail` is "redacted for callers without admin rights".
    // NOT IMPLEMENTED HERE, and said out loud rather than left to be assumed:
    // `ScopeContext` carries no role today, so there is nothing to branch on.
    // Every caller who can see the document sees its full detail. Tracked as a
    // follow-up — see modules/documents/CLAUDE.md.
    //
    // Guarded like `fields` below rather than cast: the contract types this as
    // an object-or-null, the column is bare `Json`, and every writer today
    // happens to store an object — "happens to" being the operative words for a
    // read surface that has to survive whatever the next writer does.
    detail: isJsonObject(row.detail) ? row.detail : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toExtraction(row: ExtractionRow): Extraction {
  // `fields` is `Json` in Prisma — which includes arrays and scalars — while
  // the contract promises an object of `ExtractedField`. The compiler is right
  // that those do not overlap, so the narrowing is done rather than asserted:
  // a non-object lands as `{}` instead of an array being served where a client
  // generated from the spec expects a map, which would fail in the browser at
  // the point it is least debuggable. The extraction lane (#79) owns the shape
  // on write; this is the read surface refusing to pass on a broken one.
  //
  // `lineItems` rides INSIDE that jsonb on write (METH S4 stores it there under
  // the no-schema-change rule; METH S3's update-coding executor copies it
  // forward) — but the contract types `fields` as a map of `ExtractedField` and
  // the generated client parses it STRICTLY, so an array left under that key
  // fails every `GET /documents/{id}` in the browser the moment a document has
  // been extracted. The contract also already has the honest home for it:
  // `Extraction.lineItems`, optional. So the smuggled key is separated here —
  // surfaced as the contracted array when it holds one, omitted (never nulled)
  // otherwise, and stripped from `fields` either way (METH S7, #137).
  //
  // `codingSuggestion` rides in the same jsonb for the same reason and is
  // separated here for the same one — see `coding-suggestion.ts`. Parsed, not
  // cast: the column is `Json`, so a payload an older release wrote (or a hand
  // edit made) degrades to "no suggestion" and the Category row falls back to
  // what it showed before, rather than half-rendering an opinion.
  const raw: Record<string, unknown> = isJsonObject(row.fields) ? row.fields : {};
  const { lineItems, [CODING_SUGGESTION_KEY]: rawCoding, ...fields } = raw;
  const codingSuggestion = readStoredCodingSuggestion(rawCoding);

  return {
    id: row.id,
    documentId: row.documentId,
    fields: fields as unknown as Extraction['fields'],
    ...(Array.isArray(lineItems) ? { lineItems: lineItems as unknown as NonNullable<Extraction['lineItems']> } : {}),
    extractorKind: row.extractorKind,
    ladderRung: row.ladderRung,
    modelVersion: row.modelVersion,
    promptVersion: row.promptVersion,
    overallConfidence: row.overallConfidence,
    // OMITTED, not nulled, when absent. `validatorResults` is an *optional*
    // property in the contract, and under `exactOptionalPropertyTypes` those are
    // two different things: the key being missing means "no validators have run
    // on this extraction", which is the truth before #79 exists. Writing an
    // explicit `null` would claim they ran and found nothing.
    ...(isJsonObject(row.validatorResults)
      ? { validatorResults: row.validatorResults as unknown as NonNullable<Extraction['validatorResults']> }
      : {}),
    isAccepted: row.isAccepted,
    keyedByUserId: row.keyedByUserId,
    createdAt: row.createdAt.toISOString(),
    // OMITTED, not nulled, when absent — the same distinction
    // `validatorResults` makes above, and for the same reason: the key being
    // missing means the coding ladder was not consulted for this read, which is
    // different from it having been consulted and having nothing to say.
    ...(codingSuggestion === null ? {} : { codingSuggestion }),
  };
}
