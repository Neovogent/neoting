import type { Document as DocumentRow } from '@prisma/client';

import type { Document } from '@neoting/contracts/model';

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
    id: row.id,
    businessId: row.businessId ?? '', // web-upload documents are always business-anchored
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
    totalPence: row.totalPence,
    taxPence: row.taxPence,
    reference: row.reference,
    categoryCode: row.categoryCode,
    description: row.description,
    projectRef: row.projectRef,
    parentDocumentId: row.parentDocumentId,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    retryable: row.state === 'REJECTED' || row.state === 'FAILED',
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
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
    acceptedExtraction: null, // populated by the extraction surface, not here
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
