import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { PrismaDuplicateDetector } from '../../ingestion-routing/queue/duplicate-detector.js';
import { transitionDocument } from '../document-state.js';
import { findStaleDedupeFollowUps, runDedupeFollowUp } from './dedupe-follow-up.js';
import { ProposalExecutionRefused } from './proposal-executor.js';
import { archiveDocumentExecutor } from './archive-document.js';
import { routeDocumentExecutor } from './route-document.js';

/**
 * The #81 acceptance, against a REAL database:
 *
 * - routing moves the tenancy anchor and `documents_tenant_anchor` holds
 *   (asserted directly, not through the constraint — it is an at-least-one
 *   OR, so it cannot be the oracle; see #103);
 * - a repeated execution changes nothing;
 * - routing triggers duplicate detection for the new business, composed the
 *   way the engine will: executor returns the follow-up, the runner drives
 *   the REAL `PrismaDuplicateDetector`, and the deferral/completion events
 *   make the whole thing sweepable;
 * - the approver's RLS context is the boundary: another practice's staff
 *   cannot execute against this practice's document.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P_A = 'p81_prac_a';
const P_B = 'p81_prac_b';
const BIZ_A = 'p81_biz_a';

let owner: PrismaClient;
let app: PrismaClient;

const STAFF_A = ScopeContextSchema.parse({ actorId: 'p81_user_a', practiceId: P_A });
const STAFF_B = ScopeContextSchema.parse({ actorId: 'p81_user_b', practiceId: P_B });

async function cleanup(): Promise<void> {
  await owner.duplicate.deleteMany({ where: { businessId: BIZ_A } });
  await owner.document.deleteMany({ where: { OR: [{ practiceId: { in: [P_A, P_B] } }, { businessId: BIZ_A }] } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 'p81_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 'p81_' } } });
  await owner.business.deleteMany({ where: { id: BIZ_A } });
  await owner.practice.deleteMany({ where: { id: { in: [P_A, P_B] } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.createMany({ data: [{ id: P_A, name: 'P81 A' }, { id: P_B, name: 'P81 B' }] });
  await owner.business.create({ data: { id: BIZ_A, practiceId: P_A, name: 'P81 Client A' } });
  await owner.user.createMany({
    data: [
      { id: 'p81_user_a', email: 'p81a@example.test' },
      { id: 'p81_user_b', email: 'p81b@example.test' },
      { id: 'p81_sys_a', kind: 'SYSTEM' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 'p81_mem_a', userId: 'p81_user_a', practiceId: P_A, role: 'PRACTICE_ADMIN' },
      { id: 'p81_mem_b', userId: 'p81_user_b', practiceId: P_B, role: 'PRACTICE_ADMIN' },
      { id: 'p81_mem_sys', userId: 'p81_sys_a', practiceId: P_A, role: 'PRACTICE_STANDARD' },
    ],
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

async function seedDocument(id: string, over: Record<string, unknown> = {}): Promise<void> {
  await owner.document.create({
    data: {
      id,
      practiceId: P_A,
      businessId: null,
      s3Key: `w/_unrouted/${P_A}/documents/${id}`,
      byteHash: `h-${id}`,
      mimeType: 'application/pdf',
      byteSize: 10,
      channel: 'EMAIL',
      originalFilename: 'receipt.pdf',
      inbox: 'UNROUTED',
      state: 'RECEIVED',
      ...over,
    },
  });
}

const input = <P,>(payload: P) => ({ proposalId: 'p81_prop', payload, ctx: STAFF_A, traceId: 'trace-81' });

describe.skipIf(!enabled)('proposal executors against a real database', () => {
  test('route moves the anchor, the row satisfies the CHECK, and the replay is a no-op', async () => {
    await seedDocument('p81_doc_route');

    const first = await scopedDb(app, STAFF_A, (db) =>
      routeDocumentExecutor.execute(db, input({ documentId: 'p81_doc_route', inbox: 'COSTS', toBusinessId: BIZ_A })),
    );
    expect(first.alreadyApplied).toBe(false);
    expect(first.followUps).toHaveLength(1);

    const row = await owner.document.findUnique({ where: { id: 'p81_doc_route' } });
    // The transition documents_tenant_anchor guards, asserted DIRECTLY: the
    // business is set, the practice anchor is KEPT (decision 4 on #81), so
    // both-set — the normal routed case (#103), and trivially at-least-one.
    expect(row?.businessId).toBe(BIZ_A);
    expect(row?.practiceId).toBe(P_A);
    expect(row?.inbox).toBe('COSTS');

    // Idempotent: the engine retrying after a crash between effect and record
    // finds the effect applied and does nothing — no event, no follow-up.
    const replay = await scopedDb(app, STAFF_A, (db) =>
      routeDocumentExecutor.execute(db, input({ documentId: 'p81_doc_route', inbox: 'COSTS', toBusinessId: BIZ_A })),
    );
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.followUps).toHaveLength(0);
    const routeEvents = await owner.documentEvent.findMany({ where: { documentId: 'p81_doc_route', stage: 'route' } });
    expect(routeEvents).toHaveLength(1);
  });

  test('routing triggers duplicate detection for the new business — the full deferred chain', async () => {
    // The twin: already routed into BIZ_A with the same bytes the unrouted
    // document carries. This is the pair dedupe-on-route exists to catch.
    await seedDocument('p81_doc_twin', { businessId: BIZ_A, inbox: 'COSTS', byteHash: 'h-same' });
    await seedDocument('p81_doc_new', { byteHash: 'h-same' });

    const result = await scopedDb(app, STAFF_A, (db) =>
      routeDocumentExecutor.execute(db, input({ documentId: 'p81_doc_new', inbox: 'COSTS', toBusinessId: BIZ_A })),
    );
    const followUp = result.followUps[0];
    expect(followUp).toEqual({ kind: 'dedupe', documentId: 'p81_doc_new', businessId: BIZ_A, practiceId: P_A });

    // Committed with the route: the deferral is durable intent, so a crash
    // right here loses nothing — the sweep sees it.
    const stale = await scopedDb(app, STAFF_A, (db) => findStaleDedupeFollowUps(db));
    expect(stale.some((s) => s.documentId === 'p81_doc_new')).toBe(true);

    // What the engine does post-commit, with the REAL detector.
    if (followUp === undefined) throw new Error('unreachable');
    await runDedupeFollowUp(app, STAFF_A, followUp, new PrismaDuplicateDetector(app), 'trace-81');

    const pairs = await owner.duplicate.findMany({ where: { businessId: BIZ_A } });
    expect(pairs).toHaveLength(1);
    expect([pairs[0]?.documentAId, pairs[0]?.documentBId].sort()).toEqual(['p81_doc_new', 'p81_doc_twin']);

    // Completed → no longer sweepable.
    const after = await scopedDb(app, STAFF_A, (db) => findStaleDedupeFollowUps(db));
    expect(after.some((s) => s.documentId === 'p81_doc_new')).toBe(false);
  });

  test("another practice's staff cannot execute against this practice's document", async () => {
    await seedDocument('p81_doc_foreign');
    await expect(
      scopedDb(app, STAFF_B, (db) =>
        routeDocumentExecutor.execute(db, {
          proposalId: 'p81_prop_b',
          payload: { documentId: 'p81_doc_foreign', inbox: 'COSTS', toBusinessId: BIZ_A },
          ctx: STAFF_B,
          traceId: 't',
        }),
      ),
    ).rejects.toThrow(ProposalExecutionRefused);
    const row = await owner.document.findUnique({ where: { id: 'p81_doc_foreign' } });
    expect(row?.businessId).toBeNull(); // nothing moved
  });

  test('archive → unarchive round-trips through the machine and restores the pre-archive state', async () => {
    await seedDocument('p81_doc_arch', { businessId: BIZ_A, inbox: 'COSTS' });
    // Walk it to PUBLISHED through the one transition function.
    await scopedDb(app, STAFF_A, async (db) => {
      await transitionDocument(db, { id: 'p81_doc_arch', state: 'RECEIVED' }, { to: 'PROCESSING', traceId: 't' });
      await transitionDocument(db, { id: 'p81_doc_arch', state: 'PROCESSING' }, { to: 'READY', traceId: 't' });
      await transitionDocument(db, { id: 'p81_doc_arch', state: 'READY' }, { to: 'PUBLISHED', traceId: 't' });
    });

    await scopedDb(app, STAFF_A, (db) =>
      archiveDocumentExecutor.execute(db, input({ documentIds: ['p81_doc_arch'], archived: true })),
    );
    const archived = await owner.document.findUnique({ where: { id: 'p81_doc_arch' } });
    expect(archived?.state).toBe('ARCHIVED');
    expect(archived?.archivedAt).not.toBeNull();

    await scopedDb(app, STAFF_A, (db) =>
      archiveDocumentExecutor.execute(db, input({ documentIds: ['p81_doc_arch'], archived: false })),
    );
    const restored = await owner.document.findUnique({ where: { id: 'p81_doc_arch' } });
    expect(restored?.state).toBe('PUBLISHED'); // from the archive event's own detail.from
    expect(restored?.archivedAt).toBeNull();
  });
});
