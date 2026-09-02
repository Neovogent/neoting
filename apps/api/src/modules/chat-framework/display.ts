import type { ChatDisplayBlock } from '@neoting/contracts/model';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { notDeleted } from '../../common/documents/deleted-documents.js';

/**
 * Display blocks (§9.4 applied to pictures): the model asked for a SHAPE — a
 * kind and a subject — and this module fills it from the client's own
 * RLS-scoped rows, the `drafts.ts` posture applied to rendering. The model
 * never sees these values and never writes one; a figure that is not in the
 * records is a block that is not in the response.
 *
 * Two rules the shapes encode, both from the contract's own description:
 *
 * - **Cells travel as strings, typed by their column.** A `pence` cell is the
 *   signed integer pence in decimal digits; the WEB's one money boundary turns
 *   it into pounds. An empty string is "unknown" and renders as such — never a
 *   zero that looks like a fact.
 * - **Bars carry counts only, never money.** A chart of summed money is on the
 *   road to the financial statement §9.4 forbids this surface from assembling;
 *   counts of pipeline states are the same facts `BusinessSummary` already
 *   publishes.
 */

export interface DisplayRequest {
  readonly kind: 'table' | 'barChart';
  readonly subject: 'documents' | 'bankTransactions' | 'chases';
}

/** Recent-first and capped, the `retrieveRecords` discipline (§9.5). */
const ROW_LIMIT = 40;

const day = (value: Date | null): string => (value === null ? '' : value.toISOString().slice(0, 10));
const pence = (value: number | null): string => (value === null ? '' : String(value));

/**
 * Tally rows into bars, insertion-ordered by first appearance so the chart is
 * stable across polls of the same data.
 */
function tally(labels: readonly string[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}

/**
 * Returns the composed block, or `null` when the subject has no rows — the
 * words then stand alone, which is honest, where an empty table would read as
 * "there is nothing" with more confidence than an absence deserves.
 */
export async function composeDisplay(
  db: ScopedClient,
  businessId: string,
  request: DisplayRequest,
): Promise<ChatDisplayBlock | null> {
  if (request.subject === 'documents') {
    // `notDeleted()` alongside `archivedAt: null`, and it matters more here
    // than the row count suggests: the "Documents by state" bar chart is a
    // TALLY, so a deleted document does not appear as a row a reader could
    // dismiss — it silently inflates a bar, and the chart disagrees with the
    // documents list the same screen offers with no way to see why.
    const rows = await db.document.findMany({
      where: { businessId, archivedAt: null, ...notDeleted() },
      orderBy: { receivedAt: 'desc' },
      take: ROW_LIMIT,
      select: { supplierName: true, totalPence: true, documentDate: true, state: true, categoryCode: true },
    });
    if (rows.length === 0) return null;
    if (request.kind === 'barChart') {
      return { kind: 'barChart', title: 'Documents by state', bars: tally(rows.map((r) => r.state)) };
    }
    return {
      kind: 'table',
      title: 'Recent documents',
      columns: [
        { name: 'Supplier', cellType: 'text' },
        { name: 'Date', cellType: 'date' },
        { name: 'Total', cellType: 'pence' },
        { name: 'State', cellType: 'text' },
        { name: 'Category', cellType: 'text' },
      ],
      rows: rows.map((r) => [
        r.supplierName ?? '',
        day(r.documentDate),
        pence(r.totalPence),
        r.state,
        r.categoryCode ?? '',
      ]),
    };
  }

  if (request.subject === 'bankTransactions') {
    const rows = await db.bankTransaction.findMany({
      where: { businessId },
      orderBy: { bookedAt: 'desc' },
      take: ROW_LIMIT,
      select: { descriptionRaw: true, merchantName: true, amountPence: true, bookedAt: true, matchState: true },
    });
    if (rows.length === 0) return null;
    if (request.kind === 'barChart') {
      return { kind: 'barChart', title: 'Transactions by match state', bars: tally(rows.map((r) => r.matchState)) };
    }
    return {
      kind: 'table',
      title: 'Recent bank transactions',
      columns: [
        { name: 'Description', cellType: 'text' },
        { name: 'Booked', cellType: 'date' },
        { name: 'Amount', cellType: 'pence' },
        { name: 'Match', cellType: 'text' },
      ],
      rows: rows.map((r) => [r.merchantName ?? r.descriptionRaw, day(r.bookedAt), pence(r.amountPence), r.matchState]),
    };
  }

  const rows = await db.chase.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    take: ROW_LIMIT,
    select: { state: true, createdAt: true, detectionEngine: true },
  });
  if (rows.length === 0) return null;
  if (request.kind === 'barChart') {
    return { kind: 'barChart', title: 'Chases by state', bars: tally(rows.map((r) => r.state)) };
  }
  return {
    kind: 'table',
    title: 'Recent chases',
    columns: [
      { name: 'State', cellType: 'text' },
      { name: 'Opened', cellType: 'date' },
      { name: 'Detected by', cellType: 'text' },
    ],
    rows: rows.map((r) => [r.state, day(r.createdAt), r.detectionEngine]),
  };
}
