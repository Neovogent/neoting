import { expect, test } from 'vitest';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { alreadyChasedTransactionIds, detectUnmatchedChases } from './detection.js';

interface TxnRow {
  id: string;
  businessId: string;
  amountPence: number;
  currency: string;
  bookedAt: Date;
  descriptionRaw: string;
  merchantName: string | null;
  matchState: string;
  chaseSuppressed: boolean;
}

function txn(over: Partial<TxnRow> & { id: string }): TxnRow {
  return {
    businessId: 'biz_1',
    amountPence: -100000,
    currency: 'GBP',
    bookedAt: new Date('2026-08-09T12:00:00.000Z'),
    descriptionRaw: 'CURRYS',
    merchantName: 'Currys',
    matchState: 'UNMATCHED',
    chaseSuppressed: false,
    ...over,
  };
}

/** A chase as the coverage read sees it: its grouped refs and its fallback column. */
interface ChaseCoverage {
  businessId: string;
  itemRefs: unknown;
  transactionId: string | null;
}

/** A recording fake — the query filters are asserted, then applied in memory. */
function harness(rows: TxnRow[], chases: ChaseCoverage[] = []) {
  let lastWhere: Record<string, unknown> | undefined;
  const db = {
    bankTransaction: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        lastWhere = where;
        return rows.filter(
          (r) =>
            r.businessId === where['businessId'] &&
            r.matchState === where['matchState'] &&
            r.chaseSuppressed === where['chaseSuppressed'],
        );
      },
    },
    chase: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        chases.filter((c) => c.businessId === where['businessId']),
    },
  } as unknown as ScopedClient;
  return { db, whereWas: () => lastWhere };
}

test('the read filters to this business, UNMATCHED, and the not-suppressed flag', async () => {
  const { db, whereWas } = harness([txn({ id: 't_currys' })]);
  await detectUnmatchedChases(db, 'biz_1');
  expect(whereWas()).toMatchObject({ businessId: 'biz_1', matchState: 'UNMATCHED', chaseSuppressed: false });
});

test('a matched or excluded transaction is not chased', async () => {
  const { db } = harness([
    txn({ id: 't_matched', matchState: 'CONFIRMED' }),
    txn({ id: 't_currys' }),
  ]);
  const result = await detectUnmatchedChases(db, 'biz_1');
  expect(result.map((r) => r.transactionId)).toEqual(['t_currys']);
});

test('a descriptor-suppressed line is excluded even when the stored flag missed it', async () => {
  const { db } = harness([
    txn({ id: 't_stripe', descriptionRaw: 'STRIPE PAYOUT 12 AUG' }),
    txn({ id: 't_charge', descriptionRaw: 'SERVICE CHARGE Q3' }),
    txn({ id: 't_currys', descriptionRaw: 'CURRYS 1234' }),
    txn({ id: 't_google', descriptionRaw: 'GOOGLE ADS' }),
  ]);
  const result = await detectUnmatchedChases(db, 'biz_1');
  // The seeded suppression lines are absent; the two real ones survive.
  expect(result.map((r) => r.transactionId).sort()).toEqual(['t_currys', 't_google']);
});

test('the mapped shape carries integer pence and the bank feed identity', async () => {
  const { db } = harness([
    txn({ id: 't_currys', amountPence: -129900, currency: 'GBP', descriptionRaw: 'CURRYS', merchantName: 'Currys' }),
  ]);
  const [row] = await detectUnmatchedChases(db, 'biz_1');
  expect(row).toEqual({
    transactionId: 't_currys',
    businessId: 'biz_1',
    amountPence: -129900,
    currency: 'GBP',
    bookedAt: new Date('2026-08-09T12:00:00.000Z'),
    descriptionRaw: 'CURRYS',
    merchantName: 'Currys',
  });
  expect(Number.isInteger(row?.amountPence)).toBe(true);
});

// ── Do not over-ask (launch stage A13) ─────────────────────────────────────

test('a transaction an OPEN chase already covers is not chased again', async () => {
  const { db } = harness(
    [txn({ id: 't_currys' }), txn({ id: 't_google', descriptionRaw: 'GOOGLE ADS' })],
    [{ businessId: 'biz_1', itemRefs: ['t_currys'], transactionId: 't_currys' }],
  );
  const result = await detectUnmatchedChases(db, 'biz_1');
  expect(result.map((r) => r.transactionId)).toEqual(['t_google']);
});

test('a transaction whose chase CLOSED because the document arrived is not chased again', async () => {
  // auto-close.ts stamps CLOSED_RECEIVED when an inbound document matched the
  // line. The line itself can still read UNMATCHED — the match row is a
  // separate, human-confirmed act — so without this gate the client is chased
  // for a receipt already sitting in the accountant's inbox.
  const { db } = harness(
    [txn({ id: 't_currys' })],
    [{ businessId: 'biz_1', itemRefs: ['t_currys'], transactionId: 't_currys' }],
  );
  expect(await detectUnmatchedChases(db, 'biz_1')).toEqual([]);
});

test('EVERY line of a grouped chase is covered, not just the convenience column', async () => {
  // One text, many receipts (SoT §8.2): `transactionId` holds only the first.
  // Keying coverage on it alone would re-chase every other line in the group.
  const { db } = harness(
    [txn({ id: 't_a' }), txn({ id: 't_b' }), txn({ id: 't_c' })],
    [{ businessId: 'biz_1', itemRefs: ['t_a', 't_b'], transactionId: 't_a' }],
  );
  const result = await detectUnmatchedChases(db, 'biz_1');
  expect(result.map((r) => r.transactionId)).toEqual(['t_c']);
});

test('another client’s chase does not suppress this one’s line', async () => {
  const { db } = harness(
    [txn({ id: 't_currys' })],
    [{ businessId: 'biz_2', itemRefs: ['t_currys'], transactionId: 't_currys' }],
  );
  expect((await detectUnmatchedChases(db, 'biz_1')).map((r) => r.transactionId)).toEqual(['t_currys']);
});

test('the coverage set is pure, and survives a malformed itemRefs column', async () => {
  // `item_refs` is a bare Prisma `Json`. A non-array, or an array with
  // non-strings in it, must not throw and must not lose the fallback column.
  expect([
    ...alreadyChasedTransactionIds([
      { itemRefs: ['t_a', 7, null], transactionId: 't_a' },
      { itemRefs: 'not-an-array', transactionId: 't_b' },
      { itemRefs: [], transactionId: null },
      { itemRefs: ['t_a'], transactionId: 't_a' },
    ] as never),
  ].sort()).toEqual(['t_a', 't_b']);
});
