import type { BusinessReactivatePayload } from '@neoting/contracts/model';
import { expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { ProposalExecutionRefused } from './proposal-executor.js';
import { reactivateBusinessExecutor } from './reactivate-business.js';

/**
 * `business.reactivate` against a recording fake — offboard's own test shape,
 * because this is offboard's mirror. The assertions worth having are the two
 * that could silently rot: that both offboarding stamps are cleared, and that
 * **no document is touched**, which is the limit the review card promises a
 * reviewer.
 */

const CTX = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });

interface Row {
  id: string;
  name: string;
  isActive: boolean;
  erasureRequestedAt: Date | null;
}

function harness(rows: Row[]) {
  const map = new Map(rows.map((r) => [r.id, r]));
  const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const db = {
    business: {
      findUnique: async ({ where }: { where: { id: string } }) => map.get(where.id) ?? null,
      updateMany: async (args: { where: { id: string; isActive: boolean }; data: Record<string, unknown> }) => {
        const row = map.get(args.where.id);
        if (row === undefined || row.isActive !== args.where.isActive) return { count: 0 };
        updates.push(args);
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
    // Deliberately present and deliberately explosive. The one thing this
    // executor must never do is touch a document; a fake that simply omitted
    // the model would fail with a confusing `undefined is not a function`,
    // whereas this fails by name.
    document: {
      updateMany: async () => {
        throw new Error('business.reactivate must not touch documents');
      },
    },
  } as unknown as ScopedClient;
  return { db, map, updates };
}

const run = (db: ScopedClient, payload: BusinessReactivatePayload) =>
  reactivateBusinessExecutor.execute(db, { proposalId: 'prop_1', payload, ctx: CTX, traceId: 'trace-rb' });

test('reactivating flips isActive back and clears BOTH offboarding stamps', async () => {
  const { db, map, updates } = harness([
    { id: 'biz_1', name: 'American Burger Ltd', isActive: false, erasureRequestedAt: null },
  ]);
  const result = await run(db, { businessId: 'biz_1' });

  expect(map.get('biz_1')?.isActive).toBe(true);
  // One write, compare-and-swap shaped on the OPPOSITE guard from offboard's.
  expect(updates).toHaveLength(1);
  expect(updates[0]?.where).toEqual({ id: 'biz_1', isActive: false });
  expect(updates[0]?.data).toEqual({ isActive: true, offboardedAt: null, erasureRequestedAt: null });

  expect(result.alreadyApplied).toBe(false);
  expect(result.changed).toEqual([{ entity: 'business', id: 'biz_1' }]);
  expect(result.followUps).toEqual([]);
});

test('it restores NO document — the limit the review card promises', async () => {
  // The `document.updateMany` fake throws, so reaching for one fails this test
  // by name rather than by an incidental type error.
  const { db } = harness([{ id: 'biz_1', name: 'American Burger Ltd', isActive: false, erasureRequestedAt: null }]);
  const result = await run(db, { businessId: 'biz_1' });

  expect(result.detail).toMatchObject({ documentsRestored: false });
});

test('a live workspace is an idempotent replay — no write, no second audit noise', async () => {
  const { db, updates } = harness([
    { id: 'biz_1', name: 'American Burger Ltd', isActive: true, erasureRequestedAt: null },
  ]);
  const result = await run(db, { businessId: 'biz_1' });

  expect(updates).toHaveLength(0);
  expect(result.alreadyApplied).toBe(true);
  expect(result.detail).toMatchObject({ reactivated: true, alreadyActive: true });
});

test('a standing erasure request is withdrawn, and the outcome says so', async () => {
  const { db, map } = harness([
    {
      id: 'biz_1',
      name: 'American Burger Ltd',
      isActive: false,
      erasureRequestedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  ]);
  const result = await run(db, { businessId: 'biz_1' });

  // A live client left marked for erasure is exactly what a later erasure
  // surface must never find.
  expect(map.get('biz_1')?.erasureRequestedAt).toBeNull();
  expect(result.detail).toMatchObject({ erasureRequestCleared: true });
});

test('the reason lands VERBATIM in the detail, and an absent one writes no key', async () => {
  const { db } = harness([{ id: 'biz_1', name: 'American Burger Ltd', isActive: false, erasureRequestedAt: null }]);
  const withReason = await run(db, { businessId: 'biz_1', reason: 'The client came back' });
  expect(withReason.detail).toMatchObject({ reason: 'The client came back', businessName: 'American Burger Ltd' });

  const { db: db2 } = harness([
    { id: 'biz_2', name: 'Zeplow Ltd', isActive: false, erasureRequestedAt: null },
  ]);
  const without = await run(db2, { businessId: 'biz_2' });
  expect(without.detail).not.toHaveProperty('reason');
});

test('an unreachable business refuses — absent and foreign are indistinguishable', async () => {
  const { db } = harness([]);
  await expect(run(db, { businessId: 'biz_missing' })).rejects.toBeInstanceOf(ProposalExecutionRefused);
});
