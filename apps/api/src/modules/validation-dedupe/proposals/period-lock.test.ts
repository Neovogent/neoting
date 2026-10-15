import { expect, test } from 'vitest';

import { monthBounds } from '../../../common/banking/periods.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { assertPeriodsOpen } from './period-lock.js';
import { ProposalExecutionRefused } from './proposal-executor.js';

function fakeDb(periods: string[]): { db: ScopedClient; queries: unknown[] } {
  const queries: unknown[] = [];
  const db = {
    periodLock: {
      findMany: async (args: unknown) => {
        queries.push(args);
        return periods.map((p) => {
          const { start, end } = monthBounds(p);
          return { periodStart: start, periodEnd: end };
        });
      },
    },
  } as unknown as ScopedClient;
  return { db, queries };
}

test('a date inside a closed month refuses, naming the month', async () => {
  const { db } = fakeDb(['2026-08']);
  await expect(assertPeriodsOpen(db, 'bank.confirm-match', 'biz_1', [new Date('2026-08-14T00:00:00Z')])).rejects.toThrow(
    ProposalExecutionRefused,
  );
  await expect(assertPeriodsOpen(db, 'bank.confirm-match', 'biz_1', [new Date('2026-08-14T00:00:00Z')])).rejects.toThrow(/August 2026/);
});

test('dates outside every closed month pass, and the lookup is scoped to the business', async () => {
  const { db, queries } = fakeDb(['2026-08']);
  await expect(
    assertPeriodsOpen(db, 'publish.batch', 'biz_1', [new Date('2026-09-01T00:00:00Z'), new Date('2026-07-31T23:59:59Z'), null]),
  ).resolves.toBeUndefined();
  expect(queries[0]).toMatchObject({ where: { businessId: 'biz_1' } });
});

test('no business or only null dates never queries', async () => {
  const { db, queries } = fakeDb(['2026-08']);
  await assertPeriodsOpen(db, 'publish.batch', null, [new Date('2026-08-14T00:00:00Z')]);
  await assertPeriodsOpen(db, 'publish.batch', 'biz_1', [null, undefined]);
  expect(queries).toHaveLength(0);
});
