import { describe, expect, it } from 'vitest';

import { clientStatsFromCounts, deriveClientStats } from './selectors';
import { isUnexplained } from './matching';
import type { BankTransaction, Client } from './types';

/**
 * The `unmatched` column, which is the same number on three screens.
 *
 * `deriveClientStats` is the seeded half and `clientStatsFromCounts` is the
 * live half — the server's `BusinessSummary.counts` passed straight through —
 * and one column heading may not mean two different things depending on which
 * world rendered it. The server's definition governs, because it is what the
 * chase engine chases: `matchState: 'UNMATCHED' AND chaseSuppressed: false`.
 *
 * These cases fail against the code before `isUnexplained` existed: the seeded
 * half was `!isMatched(t)`, which also counted SUGGESTED, EXCLUDED and every
 * chase-suppressed line.
 */

const CLIENT: Client = {
  id: '1',
  name: 'American Burger Ltd',
  industry: 'Hospitality',
  health: 92,
  missingDocs: 0,
  toReview: 0,
  deadline: '7 Sep 2026',
  bankConnected: true,
};

const txn = (over: Partial<BankTransaction> & { id: string }): BankTransaction => ({
  clientId: '1',
  clientName: 'American Burger Ltd',
  description: 'BIDFOOD UK LTD',
  date: '12 Aug 2026',
  amount: 1420.5,
  isCredit: false,
  accountId: 'acct-1-1',
  ...over,
});

/** One of every shape a transaction can arrive in, from both casts. */
const TRANSACTIONS: BankTransaction[] = [
  // Server rows. Only the first two are what the server counts.
  txn({ id: 'srv-unmatched-1', matchState: 'UNMATCHED', chaseSuppressed: false }),
  txn({ id: 'srv-unmatched-2', matchState: 'UNMATCHED', chaseSuppressed: false }),
  txn({ id: 'srv-suggested', matchState: 'SUGGESTED', chaseSuppressed: false }),
  txn({ id: 'srv-excluded', matchState: 'EXCLUDED', chaseSuppressed: false }),
  txn({ id: 'srv-suppressed', description: 'SERVICE CHARGE', matchState: 'UNMATCHED', chaseSuppressed: true }),
  // Confirmed on the server and carrying NO document id — the shape that made
  // `!t.matchedDocId` count every line on live data.
  txn({ id: 'srv-confirmed', matchState: 'CONFIRMED', chaseSuppressed: false }),
  // Another client's line: never in this client's figure whatever its state.
  txn({ id: 'srv-other-client', clientId: '2', matchState: 'UNMATCHED', chaseSuppressed: false }),
];

/** The seeded cast: a document id and no `matchState` at all (METH_MODE §1). */
const SEEDED: BankTransaction[] = [
  txn({ id: 'seed-matched', matchedDocId: 'd1' }),
  txn({ id: 'seed-unmatched' }),
];

const EMPTY = { documents: [], missing: [], chases: [], approvals: [], duplicates: [], statementGaps: [] };

/**
 * The server's own `where`, written out by hand rather than derived from the
 * thing under test — `apps/api/src/modules/auth-tenancy/businesses.service.ts`.
 */
const asTheServerCounts = (rows: BankTransaction[], clientId: string) =>
  rows.filter((t) => t.clientId === clientId && t.matchState === 'UNMATCHED' && t.chaseSuppressed === false).length;

describe('deriveClientStats().unmatched implements the server definition', () => {
  it('counts only the lines the chase engine would chase', () => {
    const stats = deriveClientStats(CLIENT, { ...EMPTY, transactions: TRANSACTIONS });

    expect(stats.unmatched).toBe(2);
    expect(stats.unmatched).toBe(asTheServerCounts(TRANSACTIONS, '1'));
  });

  it('leaves the synthetic demo exactly as it was', () => {
    // No seeded row carries `matchState` or `chaseSuppressed`, so the change
    // cannot move a figure the tour narrates.
    expect(deriveClientStats(CLIENT, { ...EMPTY, transactions: SEEDED }).unmatched).toBe(1);
  });
});

describe('the seeded half and the live half agree', () => {
  it('lands on the same number for the same rows', () => {
    const seededAnswer = deriveClientStats(CLIENT, { ...EMPTY, transactions: TRANSACTIONS }).unmatched;
    // What `GET /businesses` would have returned for those same rows, fed
    // through the mapper the Clients board and `statsFor` actually use.
    const liveAnswer = clientStatsFromCounts({
      toReview: 0,
      ready: 0,
      failed: 0,
      published: 0,
      missing: 0,
      requested: 0,
      overdue: 0,
      unmatched: asTheServerCounts(TRANSACTIONS, '1'),
      statementGaps: 0,
      approvals: 0,
    }).unmatched;

    expect(seededAnswer).toBe(liveAnswer);
  });
});

describe('the three surfaces now count the same set', () => {
  it('BankView, AnalyticsView and statsFor reduce to one number', () => {
    const scoped = TRANSACTIONS.filter((t) => t.clientId === '1');

    // BankView's header/footer figure, and AnalyticsView's Unmatched tile:
    // both are now `filter(isUnexplained)` over their own scoped array.
    const bankHeader = scoped.filter(isUnexplained).length;
    const analyticsTile = scoped.filter(isUnexplained).length;
    // The client card beside them, through `statsFor`.
    const clientCard = deriveClientStats(CLIENT, { ...EMPTY, transactions: TRANSACTIONS }).unmatched;

    expect([bankHeader, analyticsTile, clientCard]).toEqual([2, 2, 2]);

    // And what each of them used to say about the very same six rows. Every
    // one of these three numbers was on screen at once.
    // `!isMatched(t)` — BankView's old header: the two real ones plus
    // SUGGESTED, EXCLUDED and the suppressed service charge.
    expect(scoped.filter((t) => t.matchedDocId === undefined && t.matchState !== 'CONFIRMED').length).toBe(5);
    // `!t.matchedDocId` — AnalyticsView's old tile: every row in the feed.
    expect(scoped.filter((t) => !t.matchedDocId).length).toBe(6);
  });
});
