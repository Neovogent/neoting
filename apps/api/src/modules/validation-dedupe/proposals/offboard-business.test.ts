import type { BusinessOffboardPayload } from '@neoting/contracts/model';
import { expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { offboardBusinessExecutor } from './offboard-business.js';
import { ProposalExecutionRefused } from './proposal-executor.js';

/**
 * `business.offboard` against a recording fake — the assertions are on the
 * writes that reach the database, and on the refusals. The RLS half (a foreign
 * practice's context cannot offboard, the approving practice's UPDATE lands)
 * is proven live in `offboard-business.integration.test.ts`.
 */

const CTX = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });

interface Row {
  id: string;
  name: string;
  isActive: boolean;
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
  } as unknown as ScopedClient;
  return { db, map, updates };
}

const run = (db: ScopedClient, payload: BusinessOffboardPayload) =>
  offboardBusinessExecutor.execute(db, { proposalId: 'prop_1', payload, ctx: CTX, traceId: 'trace-ob' });

test('offboarding flips isActive off and nothing else — one guarded UPDATE, no delete', async () => {
  const { db, map, updates } = harness([{ id: 'biz_1', name: 'American Burger Ltd', isActive: true }]);
  const result = await run(db, { businessId: 'biz_1', reason: 'Client moved to another practice' });

  expect(map.get('biz_1')?.isActive).toBe(false);
  // The one write: guarded on isActive (compare-and-swap), setting only the flag.
  expect(updates).toHaveLength(1);
  expect(updates[0]?.where).toEqual({ id: 'biz_1', isActive: true });
  expect(updates[0]?.data).toEqual({ isActive: false });
  // The row still exists — retention is the point (D12).
  expect(map.has('biz_1')).toBe(true);

  expect(result.alreadyApplied).toBe(false);
  expect(result.changed).toEqual([{ entity: 'business', id: 'biz_1' }]);
  expect(result.followUps).toEqual([]);
});

test('the reason lands VERBATIM in the detail, beside an honest account of the effect', async () => {
  const { db } = harness([{ id: 'biz_1', name: 'American Burger Ltd', isActive: true }]);
  const result = await run(db, { businessId: 'biz_1', reason: 'Client moved to another practice' });

  expect(result.detail).toEqual({
    offboarded: true,
    alreadyInactive: false,
    businessName: 'American Burger Ltd',
    booksRetained: true,
    reason: 'Client moved to another practice',
  });
});

test('no reason means no reason key — an absent answer is not an empty string', async () => {
  const { db } = harness([{ id: 'biz_1', name: 'American Burger Ltd', isActive: true }]);
  const result = await run(db, { businessId: 'biz_1' });
  expect(result.detail).not.toHaveProperty('reason');
});

test('an unreachable business refuses — an invisible id and an absent one are the same answer', async () => {
  const { db, updates } = harness([]);
  await expect(run(db, { businessId: 'biz_ghost' })).rejects.toThrow(ProposalExecutionRefused);
  await expect(run(db, { businessId: 'biz_ghost' })).rejects.toThrow('no reachable business');
  expect(updates).toHaveLength(0);
});

test('an already-inactive workspace is an idempotent replay: no write, alreadyApplied', async () => {
  const { db, updates } = harness([{ id: 'biz_1', name: 'American Burger Ltd', isActive: false }]);
  const result = await run(db, { businessId: 'biz_1', reason: 'Second approval of the same intent' });

  expect(updates).toHaveLength(0);
  expect(result.alreadyApplied).toBe(true);
  expect(result.changed).toEqual([{ entity: 'business', id: 'biz_1' }]);
  expect(result.detail).toMatchObject({ offboarded: true, alreadyInactive: true, booksRetained: true });
});

test('a lost race on the guarded write reports a replay, never a second effect', async () => {
  // The row reads active but goes inactive before the write — the count-0
  // branch. A concurrent approval already applied the effect.
  const db = {
    business: {
      findUnique: async () => ({ id: 'biz_1', name: 'American Burger Ltd', isActive: true }),
      updateMany: async () => ({ count: 0 }),
    },
  } as unknown as ScopedClient;
  const result = await run(db, { businessId: 'biz_1' });
  expect(result.alreadyApplied).toBe(true);
  expect(result.detail).toMatchObject({ offboarded: true, alreadyInactive: true });
});
