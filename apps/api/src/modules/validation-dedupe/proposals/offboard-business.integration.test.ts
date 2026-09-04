import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { InMemoryIdempotencyStore } from '../../../common/idempotency/idempotency-store.js';
import { ActionProposalsService } from '../../approvals/action-proposals.service.js';
import { BusinessesService } from '../../auth-tenancy/businesses.service.js';
import { offboardBusinessExecutor } from './offboard-business.js';
import { ProposalExecutionRefused } from './proposal-executor.js';
import type { PublishGateway } from './publish-batch.js';
import { buildExecutorRegistry } from './registry.js';

/**
 * `business.offboard` end to end through the REAL Review → Approve engine
 * against a real database as `nt_app`:
 *
 * - create → review (the card says books are retained, and the reason
 *   verbatim) → approve → `businesses.is_active` is false — which is also the
 *   live proof that `businesses_tenant` lets the approving practice's context
 *   UPDATE the row through RLS;
 * - the offboarded workspace leaves `GET /businesses` (the Clients list /
 *   switcher read) while its still-active sibling stays;
 * - a second approval over the already-inactive workspace is an idempotent
 *   replay (`alreadyApplied`), not a second effect;
 * - another practice's context cannot offboard it — executor-level, the
 *   `executors.integration.test.ts` tenancy arrangement;
 * - nothing was deleted: the business row and its document survive.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable. Id namespace `pob_`, disjoint from
 * every other suite, torn down in full here.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P_A = 'pob_prac_a';
const P_B = 'pob_prac_b';
const BIZ = 'pob_biz';
const BIZ_LIVE = 'pob_biz_live';

let owner: PrismaClient;
let app: PrismaClient;

const STAFF_A = ScopeContextSchema.parse({ actorId: 'pob_user_a', practiceId: P_A });
const STAFF_B = ScopeContextSchema.parse({ actorId: 'pob_user_b', practiceId: P_B });

// Publish is not in frame: the stub satisfies the registry's required dep and
// nothing more (its real suites exercise it).
const STUB_PUBLISHING: PublishGateway = {
  ledger: { publishBill: async () => ({ ok: true, externalRef: 'STUB', attachmentSent: false }) },
  previewPublishBatch: () => ({ ok: true, preview: { itemCount: 0, grossPence: 0, vatPence: 0, currency: null } }),
};

// chase.send composition config for tests — a real secret so signed links verify.
const TEST_CHASE_COMPOSE = { portalLinkSecret: 'test-portal-link-secret', appOrigin: 'https://app.test' };

function service(): ActionProposalsService {
  return new ActionProposalsService(
    app,
    buildExecutorRegistry({ publishing: STUB_PUBLISHING }),
    { detect: async () => ({ findings: [], candidatesTruncated: false }) },
    STUB_PUBLISHING,
    new InMemoryIdempotencyStore(),
    TEST_CHASE_COMPOSE,
  );
}

async function cleanup(): Promise<void> {
  await owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
  await owner.auditEvent.deleteMany({ where: { businessId: { in: [BIZ, BIZ_LIVE] } } });
  await owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
  await owner.actionProposal.deleteMany({ where: { OR: [{ practiceId: { in: [P_A, P_B] } }, { businessId: { in: [BIZ, BIZ_LIVE] } }] } });
  await owner.document.deleteMany({ where: { practiceId: { in: [P_A, P_B] } } });
  // Explicit ids, not `startsWith` — Prisma's LIKE leaves `_` a wildcard (the
  // p4/p40 collision recorded in extraction-pipeline.integration.test.ts).
  await owner.membership.deleteMany({ where: { id: { in: ['pob_mem_a', 'pob_mem_b'] } } });
  await owner.user.deleteMany({ where: { id: { in: ['pob_user_a', 'pob_user_b'] } } });
  await owner.business.deleteMany({ where: { id: { in: [BIZ, BIZ_LIVE] } } });
  await owner.practice.deleteMany({ where: { id: { in: [P_A, P_B] } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.createMany({ data: [{ id: P_A, name: 'POB A' }, { id: P_B, name: 'POB B' }] });
  await owner.business.createMany({
    data: [
      { id: BIZ, practiceId: P_A, name: 'POB Departing Client' },
      { id: BIZ_LIVE, practiceId: P_A, name: 'POB Staying Client' },
    ],
  });
  await owner.user.createMany({
    data: [
      { id: 'pob_user_a', email: 'poba@example.test' },
      { id: 'pob_user_b', email: 'pobb@example.test' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 'pob_mem_a', userId: 'pob_user_a', practiceId: P_A, role: 'PRACTICE_ADMIN' },
      { id: 'pob_mem_b', userId: 'pob_user_b', practiceId: P_B, role: 'PRACTICE_ADMIN' },
    ],
  });
  // A document in the departing workspace — the retention assertion's witness.
  await owner.document.create({
    data: {
      id: 'pob_doc',
      practiceId: P_A,
      businessId: BIZ,
      s3Key: `w/${BIZ}/documents/pob_doc`,
      byteHash: 'h-pob_doc',
      mimeType: 'application/pdf',
      byteSize: 10,
      channel: 'EMAIL',
      originalFilename: 'receipt.pdf',
      inbox: 'COSTS',
      state: 'READY',
    },
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('business.offboard end to end through the engine', () => {
  test("another practice's context cannot offboard this practice's client — RLS is the boundary", async () => {
    await expect(
      scopedDb(app, STAFF_B, (db) =>
        offboardBusinessExecutor.execute(db, {
          proposalId: 'pob_prop_foreign',
          payload: { businessId: BIZ },
          ctx: STAFF_B,
          traceId: 't-pob',
        }),
      ),
    ).rejects.toThrow(ProposalExecutionRefused);
    const row = await owner.business.findUnique({ where: { id: BIZ } });
    expect(row?.isActive).toBe(true); // nothing moved
  });

  test('create → review (books retained, reason verbatim) → approve → isActive false through RLS', async () => {
    const svc = service();
    const created = await svc.create(
      STAFF_A,
      {
        kind: 'business.offboard',
        businessId: BIZ,
        payload: { businessId: BIZ, reason: 'Client moved to another practice' },
      },
      'pob-key-create',
    );
    expect(created.state).toBe('CREATED');

    const review = await svc.review(STAFF_A, created.id, 'pob-key-review');
    const summary = review.renderedSummary as {
      title: string;
      sections: { heading: string; entries: { label: string; value: string }[] }[];
    };
    // The truthful line: the act, and what does NOT happen to the books.
    expect(summary.title).toBe(`Offboard client workspace ${BIZ} — books retained`);
    const entries = summary.sections[0]?.entries ?? [];
    expect(entries).toContainEqual({
      label: 'Reason, exactly as it will be recorded',
      value: 'Client moved to another practice',
    });
    expect(entries.some((e) => e.label === 'Deletes books, documents or the audit trail' && e.value.startsWith('No'))).toBe(true);

    const executed = await svc.approve(STAFF_A, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'pob-key-approve');
    expect(executed.state).toBe('EXECUTED');
    expect(executed.outcome).toMatchObject({
      alreadyApplied: false,
      changed: [{ entity: 'business', id: BIZ }],
      detail: {
        offboarded: true,
        alreadyInactive: false,
        businessName: 'POB Departing Client',
        booksRetained: true,
        reason: 'Client moved to another practice',
      },
    });

    // The RLS-scoped UPDATE landed: the engine ran the executor under
    // STAFF_A's scoped transaction, and the owner connection reads the flip.
    const row = await owner.business.findUnique({ where: { id: BIZ } });
    expect(row?.isActive).toBe(false);

    // Retention (D12): the row exists, its document exists, nothing deleted.
    const doc = await owner.document.findUnique({ where: { id: 'pob_doc' } });
    expect(doc?.businessId).toBe(BIZ);
  });

  test('the offboarded workspace leaves GET /businesses; its active sibling stays', async () => {
    const businesses = new BusinessesService(app);
    const page = await businesses.listBusinesses(STAFF_A, { limit: 50 });
    const ids = page.data.map((b) => b.id);
    expect(ids).toContain(BIZ_LIVE);
    expect(ids).not.toContain(BIZ);
  });

  test('a second approval over the already-inactive workspace is a replay, not a second effect', async () => {
    const svc = service();
    const created = await svc.create(
      STAFF_A,
      { kind: 'business.offboard', businessId: BIZ, payload: { businessId: BIZ } },
      'pob-key-create-2',
    );
    const review = await svc.review(STAFF_A, created.id, 'pob-key-review-2');
    const executed = await svc.approve(STAFF_A, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'pob-key-approve-2');

    expect(executed.outcome).toMatchObject({ alreadyApplied: true });
    const row = await owner.business.findUnique({ where: { id: BIZ } });
    expect(row?.isActive).toBe(false); // still exactly one flip, still soft
  });
});
