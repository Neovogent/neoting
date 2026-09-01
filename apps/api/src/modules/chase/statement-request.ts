import type { ScopedClient } from '../../common/db/scoped-db.js';

/**
 * Just enough of Prisma for the statement-request reads and the close — a
 * structural type so the statement lane's narrow `StatementScopedClient` (and
 * its test fakes) satisfy it without importing the whole client. A real
 * `ScopedClient` satisfies it too.
 */
export interface StatementChaseClient {
  chase: {
    findMany(args: unknown): Promise<{ id: string; itemRefs: unknown }[]>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  chaseMessage: { create(args: unknown): Promise<unknown> };
  notification: { create(args: unknown): Promise<unknown> };
  statement: { findFirst(args: unknown): Promise<{ id: string } | null> };
}

/**
 * Statement-request chases (engine (c), `STATEMENT_PERIOD_GAP`) — Phase 5.
 *
 * A statement request is a chase with no transactions: its one item is the
 * month, carried on `itemRefs` as `statement:YYYY-MM` so `chaseItemRefs`
 * counts it (ChaseSummary.itemCount stays ≥ 1) without a schema change. This
 * file owns the tag format and everything that reads or settles it — one
 * definition, three readers (the executor, the portal context, the close).
 */
export const STATEMENT_ITEM_PREFIX = 'statement:';

export const statementItemRef = (period: string): string => `${STATEMENT_ITEM_PREFIX}${period}`;

/** The `YYYY-MM` a chase's itemRefs ask for, or null when it is not a statement request. */
export function statementPeriodOf(itemRefs: readonly string[]): string | null {
  const tag = itemRefs.find((ref) => ref.startsWith(STATEMENT_ITEM_PREFIX));
  const period = tag?.slice(STATEMENT_ITEM_PREFIX.length) ?? '';
  return /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(period) ? period : null;
}

/** The month's [start, end) as UTC instants — the overlap window `received` tests. */
export function periodWindow(period: string): { readonly start: Date; readonly end: Date } {
  const year = Number.parseInt(period.slice(0, 4), 10);
  const month = Number.parseInt(period.slice(5, 7), 10);
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

/**
 * Whether a statement covering the month exists — the ONE `received` predicate
 * for statement requests, shared by the portal context and the close so the
 * two can never disagree (the `toChaseItem` rule, applied to engine (c)). A
 * statement with no recorded period cannot prove coverage and counts for
 * nothing — D41's stance: what cannot be checked is not a pass.
 */
export async function statementCoversPeriod(db: Pick<StatementChaseClient, 'statement'> | ScopedClient, businessId: string, period: string): Promise<boolean> {
  const { start, end } = periodWindow(period);
  const row = await db.statement.findFirst({
    where: { businessId, periodStart: { lt: end, not: null }, periodEnd: { gte: start, not: null } },
    select: { id: true },
  });
  return row !== null;
}

export interface CloseStatementRequestsInput {
  readonly businessId: string;
  /** The ingested statement's own document, stamped as what closed the chase. */
  readonly documentId: string;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
}

/**
 * Close every OPEN statement-request chase the just-ingested statement covers.
 * Runs inside the statement step's own scoped transaction (the caller's `db`),
 * mirroring `auto-close.ts` semantics: compare-and-swap on the open states,
 * a `channel: 'event'` message as the audit surface, the accountant's
 * `chase.closed` notification, idempotent by the guarded update.
 */
export async function closeStatementRequestChases(db: StatementChaseClient | ScopedClient, input: CloseStatementRequestsInput): Promise<readonly string[]> {
  if (input.periodStart === null || input.periodEnd === null) return [];

  const open = await db.chase.findMany({
    where: { businessId: input.businessId, detectionEngine: 'STATEMENT_PERIOD_GAP', state: { in: ['SENT', 'REMINDED', 'ESCALATED'] } },
    select: { id: true, itemRefs: true },
  });

  const closed: string[] = [];
  for (const chase of open) {
    const refs = Array.isArray(chase.itemRefs) ? (chase.itemRefs as string[]) : [];
    const period = statementPeriodOf(refs);
    if (period === null) continue;
    const { start, end } = periodWindow(period);
    // Overlap, not containment: a mid-month-to-mid-month statement that covers
    // part of the asked month still answers it — the accountant sees what
    // arrived either way, and re-asking for a month partially in hand is the
    // over-chasing §24.2.3 forbids.
    if (!(input.periodStart < end && input.periodEnd >= start)) continue;

    const flipped = await db.chase.updateMany({
      where: { id: chase.id, state: { in: ['SENT', 'REMINDED', 'ESCALATED'] } },
      data: {
        state: 'CLOSED_RECEIVED',
        closedByDocumentId: input.documentId,
        closedReason: 'matched-inbound-statement',
        closedAt: new Date(),
      },
    });
    if (flipped.count !== 1) continue;

    await db.chaseMessage.create({
      data: {
        chaseId: chase.id,
        channel: 'event',
        body: `Closed: a bank statement covering ${period} arrived (document ${input.documentId}).`,
      },
    });
    await db.notification.create({
      data: {
        businessId: input.businessId,
        event: 'chase.closed',
        payload: { chaseId: chase.id, documentId: input.documentId, reason: 'matched-inbound-statement', period },
        channels: [],
      },
    });
    closed.push(chase.id);
  }
  return closed;
}
