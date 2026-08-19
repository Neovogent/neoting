import { expect, test } from 'vitest';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { detectUnmatchedChases } from './detection.js';

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

/** A recording fake — the query filters are asserted, then applied in memory. */
function harness(rows: TxnRow[]) {
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
