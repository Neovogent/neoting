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

/** A document the `trash` scope may or may not be allowed to move. */
interface Doc {
  id: string;
  businessId: string;
  deletedAt: Date | null;
}

function harness(rows: Row[], docs: Doc[] = []) {
  const map = new Map(rows.map((r) => [r.id, r]));
  const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const docUpdates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
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
    document: {
      updateMany: async (args: {
        where: { businessId: string; deletedAt: null };
        data: { deletedAt: Date };
      }) => {
        docUpdates.push(args);
        // The filter the executor sends, applied honestly: only rows of this
        // business that are not ALREADY in Trash.
        const hit = docs.filter((d) => d.businessId === args.where.businessId && d.deletedAt === null);
        for (const doc of hit) doc.deletedAt = args.data.deletedAt;
        return { count: hit.length };
      },
    },
  } as unknown as ScopedClient;
  return { db, map, updates, docs, docUpdates };
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
  // The flag AND the offboarding stamp the Removed clients panel counts from —
  // and NOT `erasureRequestedAt`, which only `mark-for-erasure` writes.
  expect(updates[0]?.data).toMatchObject({ isActive: false });
  expect(updates[0]?.data['offboardedAt']).toBeInstanceOf(Date);
  expect(updates[0]?.data).not.toHaveProperty('erasureRequestedAt');
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
    documentScope: 'keep',
    documentsTrashed: 0,
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

/* ── The deletion SCOPE (review item 67) ───────────────────────────────────
   The bug this closes is that offboarding used to say nothing about the
   client's documents, so they stayed live in the practice's queues. Every
   scope below is reversible; none of them deletes a row. */

test('the default scope is `keep`, and a caller who says nothing touches no document', async () => {
  const { db, docUpdates, docs } = harness(
    [{ id: 'biz_1', name: 'American Burger Ltd', isActive: true }],
    [{ id: 'doc_1', businessId: 'biz_1', deletedAt: null }],
  );
  const result = await run(db, { businessId: 'biz_1' });

  expect(docUpdates).toHaveLength(0);
  expect(docs[0]?.deletedAt).toBeNull();
  expect(result.detail).toMatchObject({ documentScope: 'keep', documentsTrashed: 0 });
});

test('`trash` moves the client\u2019s live documents to Trash and reports how many', async () => {
  const { db, docUpdates, docs } = harness(
    [{ id: 'biz_1', name: 'American Burger Ltd', isActive: true }],
    [
      { id: 'doc_1', businessId: 'biz_1', deletedAt: null },
      { id: 'doc_2', businessId: 'biz_1', deletedAt: null },
      { id: 'doc_3', businessId: 'biz_2', deletedAt: null },
    ],
  );
  const result = await run(db, { businessId: 'biz_1', documentScope: 'trash' });

  // Reversible: `deletedAt` stamped, the rows still there. `document.purge` is
  // the only irreversible act on a document and this is not it.
  expect(docs[0]?.deletedAt).toBeInstanceOf(Date);
  expect(docs[1]?.deletedAt).toBeInstanceOf(Date);
  // Another client's document is not this client's business.
  expect(docs[2]?.deletedAt).toBeNull();
  expect(docUpdates[0]?.where).toEqual({ businessId: 'biz_1', deletedAt: null });
  expect(result.detail).toMatchObject({ documentScope: 'trash', documentsTrashed: 2 });
});

test('`trash` leaves an ALREADY-trashed document\u2019s own deletion moment alone', async () => {
  const earlier = new Date('2026-08-01T00:00:00.000Z');
  const { db, docs } = harness(
    [{ id: 'biz_1', name: 'American Burger Ltd', isActive: true }],
    [
      { id: 'doc_1', businessId: 'biz_1', deletedAt: earlier },
      { id: 'doc_2', businessId: 'biz_1', deletedAt: null },
    ],
  );
  const result = await run(db, { businessId: 'biz_1', documentScope: 'trash' });

  // The retention window a document is already serving must not restart because
  // an offboard swept past it.
  expect(docs[0]?.deletedAt).toBe(earlier);
  expect(result.detail).toMatchObject({ documentsTrashed: 1 });
});

test('`mark-for-erasure` stamps the flag, erases nothing, and schedules nothing', async () => {
  const { db, updates, docs, docUpdates } = harness(
    [{ id: 'biz_1', name: 'American Burger Ltd', isActive: true }],
    [{ id: 'doc_1', businessId: 'biz_1', deletedAt: null }],
  );
  const result = await run(db, { businessId: 'biz_1', documentScope: 'mark-for-erasure' });

  expect(updates[0]?.data['erasureRequestedAt']).toBeInstanceOf(Date);
  // A flag, not a timer, and not a deletion: the documents are untouched.
  expect(docUpdates).toHaveLength(0);
  expect(docs[0]?.deletedAt).toBeNull();
  expect(result.detail).toMatchObject({ erasureRequested: true, erasureScheduled: false, documentsTrashed: 0 });
});

test('a REPLAY over an already-inactive client re-trashes nothing', async () => {
  const { db, docUpdates, docs } = harness(
    [{ id: 'biz_1', name: 'American Burger Ltd', isActive: false }],
    // Restored by hand since the first offboard — a second approval of the same
    // proposal must not undo that.
    [{ id: 'doc_1', businessId: 'biz_1', deletedAt: null }],
  );
  const result = await run(db, { businessId: 'biz_1', documentScope: 'trash' });

  expect(result.alreadyApplied).toBe(true);
  expect(docUpdates).toHaveLength(0);
  expect(docs[0]?.deletedAt).toBeNull();
  expect(result.detail).toMatchObject({ documentsTrashed: 0 });
});
