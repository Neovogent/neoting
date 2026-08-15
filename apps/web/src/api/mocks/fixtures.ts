import { seedClients, seedDocuments, seedDuplicateCopies, seedExpenseDocuments } from '../../lib/seed';
import type { DocumentSummary } from '@neoting/contracts/model';
import { DocumentChannel, DocumentState, DocumentType, Inbox } from '@neoting/contracts/model';
import type { Document as LocalDocument } from '../../lib/types';

/**
 * The demo dataset, expressed in the contract's shapes.
 *
 * orval's generated handler returns the one worked example from the spec,
 * which proves the wire format and nothing else — a single Bidfood row is not
 * an inbox to look at. These map the seed data the app already ships so the
 * mocked API answers with the same documents the screens have always shown.
 *
 * It is also the sharpest test of the mapping in both directions: every field
 * conversion the real integration will need — pence, enum casing, ISO dates —
 * happens here first, against data we can eyeball.
 */

/** Money is integer pence in the contract; the local seed is in pounds. */
export const toPence = (pounds: number): number => Math.round(pounds * 100);

const STATE: Record<LocalDocument['status'], DocumentState> = {
  processing: DocumentState.PROCESSING,
  review: DocumentState.TO_REVIEW,
  ready: DocumentState.READY,
  published: DocumentState.PUBLISHED,
  rejected: DocumentState.REJECTED,
};

const CHANNEL: Record<string, DocumentChannel> = {
  email: DocumentChannel.EMAIL,
  whatsapp: DocumentChannel.WHATSAPP,
  web: DocumentChannel.WEB_UPLOAD,
  'sms-link': DocumentChannel.SMS_PORTAL,
  chat: DocumentChannel.CHAT_UPLOAD,
  csv: DocumentChannel.STRUCTURED_IMPORT,
  portal: DocumentChannel.SMS_PORTAL,
};

/** "10 Aug 2026" → "2026-08-10". A calendar date, never an instant. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function toIsoDate(display: string): string | null {
  const m = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(display.trim());
  if (!m) return null;
  // Every group in the pattern is mandatory, so a match fills all three; the
  // guard restates that rather than asserting past it.
  const [, day, mon, year] = m;
  if (!day || !mon || !year) return null;
  const month = MONTHS.indexOf(mon);
  if (month < 0) return null;
  return `${year}-${String(month + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** Businesses are ids in the contract; the seed uses '1' and '2'. */
const businessId = (clientId: string) => `biz_${clientId}`;

/**
 * The reason a failed document failed, as the contract requires it.
 *
 * `failureCode` and `failureMessage` are documented as never null in REJECTED
 * or FAILED, so the mapping derives them rather than leaving the hole the spec
 * calls a bug.
 */
function failure(doc: LocalDocument): { failureCode: string | null; failureMessage: string | null; retryable: boolean } {
  if (doc.status !== 'rejected') return { failureCode: null, failureMessage: null, retryable: false };
  const note = doc.statusNote ?? 'Processing failed';
  const extraction = doc.fields.length === 0;
  return {
    failureCode: extraction ? 'NT-ING-004' : 'NT-PUB-002',
    failureMessage: note,
    // A locked file read again is the same locked file; a refused publish is
    // worth another attempt once the mapping is fixed.
    retryable: !extraction,
  };
}

export function toDocumentSummary(doc: LocalDocument): DocumentSummary {
  const { failureCode, failureMessage, retryable } = failure(doc);
  const isSales = doc.kind === 'sales';

  return {
    id: doc.id,
    businessId: businessId(doc.clientId),
    inbox: isSales ? Inbox.SALES : Inbox.COSTS,
    state: STATE[doc.status] ?? DocumentState.RECEIVED,
    docType: isSales ? DocumentType.INVOICE : DocumentType.RECEIPT,
    channel: CHANNEL[doc.source] ?? DocumentChannel.WEB_UPLOAD,
    originalFilename: doc.splitFrom ?? `${doc.supplier.toLowerCase().replace(/\s+/g, '-')}.pdf`,
    receivedAt: `${toIsoDate(doc.date) ?? '2026-08-01'}T09:00:00Z`,
    supplierName: isSales ? null : doc.supplier,
    customerName: isSales ? doc.supplier : null,
    documentDate: toIsoDate(doc.date),
    dueDate: null,
    currency: doc.currency ?? 'GBP',
    totalPence: toPence(doc.total),
    taxPence: doc.fields.find((f) => f.label.toLowerCase().includes('tax'))
      ? toPence(Number(String(doc.fields.find((f) => f.label.toLowerCase().includes('tax'))!.value).replace(/[^0-9.]/g, '')) || 0)
      : null,
    reference: doc.fields.find((f) => f.label === 'Invoice number')?.value ?? null,
    categoryCode: doc.category === '—' ? null : doc.category,
    description: doc.clientNote ?? null,
    projectRef: null,
    parentDocumentId: null,
    failureCode,
    failureMessage,
    retryable,
    archivedAt: null,
  };
}

/** Every seeded document, in contract shape, newest first. */
export const documentFixtures: DocumentSummary[] = [
  ...seedDocuments,
  ...seedExpenseDocuments,
  ...seedDuplicateCopies,
]
  .map(toDocumentSummary)
  .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

/** So a mocked response can be filtered exactly as the contract describes. */
export const businessIdsInFixtures = seedClients.map((c) => businessId(c.id));
