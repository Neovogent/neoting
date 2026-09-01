import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { AppException } from '../../common/problem/problem.js';
import { previewPublishBatch } from '../publishing/index.js';
import { buildExecutorRegistry, type PublishGateway } from '../validation-dedupe/index.js';
import { ActionProposalsService } from './action-proposals.service.js';

/**
 * **The release gate against a real database** — stage A12, D44, Governance
 * §11.2.
 *
 * The thing under test is not "does a function return false". It is: when a
 * member of the practice who is not its super admin approves a `publish.batch`,
 * does **anything at all** happen? The assertions are therefore about the
 * absence of effects — the document's state, the `publishes` table, the audit
 * chain and the proposal row itself — because a permission check that refuses
 * after its effect has run is not a permission check.
 *
 * Three people, one practice, and the difference between them is the whole point:
 *
 * | User | Membership | May release |
 * |---|---|---|
 * | `OWNER` | `PRACTICE_ADMIN`, `is_owner = true` | yes |
 * | `ADMIN` | `PRACTICE_ADMIN`, `is_owner = false` | **no** |
 * | `STAFF` | `PRACTICE_STANDARD` | no |
 *
 * `ADMIN` is the row that matters: it is the difference between reading D44 as
 * *"any admin"* and as *"the firm's super admin"*, and A11's `team-authority.ts`
 * handed that call to this stage explicitly.
 *
 * ⚠ Ids are prefixed **`a12g_`** and every table is torn down by EXPLICIT id
 * list, never `startsWith` — Prisma compiles `startsWith` to an unescaped
 * `LIKE 'a12g_%'`, whose `_` is a single-character wildcard that would reach
 * into a neighbouring suite's fixtures (the hazard `vitest.config.ts`
 * documents).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P_A = 'a12g-prac-a';
const P_B = 'a12g-prac-b';
const BIZ = 'a12g-biz';
const DOC_1 = 'a12g-doc-1';
const DOC_2 = 'a12g-doc-2';
const USER_OWNER = 'a12g-user-owner';
const USER_ADMIN = 'a12g-user-admin';
const USER_STAFF = 'a12g-user-staff';
const USER_OTHER = 'a12g-user-other';
const MEMBERSHIPS = ['a12g-mem-owner', 'a12g-mem-admin', 'a12g-mem-staff', 'a12g-mem-other'];
const USERS = [USER_OWNER, USER_ADMIN, USER_STAFF, USER_OTHER];
const DOCUMENTS = [DOC_1, DOC_2];

let owner: PrismaClient;
let app: PrismaClient;

const OWNER_CTX = ScopeContextSchema.parse({ actorId: USER_OWNER, practiceId: P_A });
const ADMIN_CTX = ScopeContextSchema.parse({ actorId: USER_ADMIN, practiceId: P_A });
const STAFF_CTX = ScopeContextSchema.parse({ actorId: USER_STAFF, practiceId: P_A });
const OTHER_CTX = ScopeContextSchema.parse({ actorId: USER_OTHER, practiceId: P_B });

/** D42: releasing for export reaches no ledger. The adapter is a tripwire. */
const PUBLISHING: PublishGateway = {
  ledger: {
    publishBill: async () => {
      throw new Error('D42: releasing a document for export must never reach a ledger');
    },
  },
  previewPublishBatch,
};

// chase.send composition config for tests — a real secret so signed links verify.
const TEST_CHASE_COMPOSE = { portalLinkSecret: 'test-portal-link-secret', appOrigin: 'https://app.test' };

function service(): ActionProposalsService {
  return new ActionProposalsService(
    app,
    buildExecutorRegistry({ publishing: PUBLISHING }),
    { detect: async () => ({ findings: [], candidatesTruncated: false }) },
    PUBLISHING,
    new InMemoryIdempotencyStore(),
    TEST_CHASE_COMPOSE,
  );
}

async function cleanup(): Promise<void> {
  // audit_events is append-only BY TRIGGER; the fixture reset is the one
  // statement allowed to lift it, on a test database only.
  await owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
  await owner.auditEvent.deleteMany({ where: { businessId: BIZ } });
  await owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
  await owner.publish.deleteMany({ where: { businessId: BIZ } });
  await owner.actionProposal.deleteMany({ where: { OR: [{ practiceId: { in: [P_A, P_B] } }, { businessId: BIZ }] } });
  await owner.documentEvent.deleteMany({ where: { documentId: { in: DOCUMENTS } } });
  await owner.document.deleteMany({ where: { id: { in: DOCUMENTS } } });
  await owner.membership.deleteMany({ where: { id: { in: MEMBERSHIPS } } });
  await owner.user.deleteMany({ where: { id: { in: USERS } } });
  await owner.business.deleteMany({ where: { id: BIZ } });
  await owner.practice.deleteMany({ where: { id: { in: [P_A, P_B] } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.createMany({ data: [{ id: P_A, name: 'A12G A' }, { id: P_B, name: 'A12G B' }] });
  await owner.business.create({ data: { id: BIZ, practiceId: P_A, name: 'A12G Client' } });
  await owner.user.createMany({
    data: [
      { id: USER_OWNER, email: 'a12g-owner@example.test' },
      { id: USER_ADMIN, email: 'a12g-admin@example.test' },
      { id: USER_STAFF, email: 'a12g-staff@example.test' },
      { id: USER_OTHER, email: 'a12g-other@example.test' },
    ],
  });
  await owner.membership.createMany({
    data: [
      // The firm's super admin — the row `practice-signup.service.ts` writes.
      { id: 'a12g-mem-owner', userId: USER_OWNER, practiceId: P_A, role: 'PRACTICE_ADMIN', isOwner: true },
      // A second practice admin, invited later. Composes and edits; does not release.
      { id: 'a12g-mem-admin', userId: USER_ADMIN, practiceId: P_A, role: 'PRACTICE_ADMIN', isOwner: false },
      { id: 'a12g-mem-staff', userId: USER_STAFF, practiceId: P_A, role: 'PRACTICE_STANDARD' },
      { id: 'a12g-mem-other', userId: USER_OTHER, practiceId: P_B, role: 'PRACTICE_ADMIN', isOwner: true },
    ],
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

async function seedDocument(id: string): Promise<void> {
  await owner.document.create({
    data: {
      id,
      practiceId: P_A,
      businessId: BIZ,
      s3Key: `w/${BIZ}/documents/${id}`,
      byteHash: `h-${id}`,
      mimeType: 'image/jpeg',
      byteSize: 4096,
      channel: 'WEB_UPLOAD',
      originalFilename: `${id}.jpg`,
      inbox: 'COSTS',
      state: 'READY',
      docType: 'INVOICE',
      currency: 'GBP',
      documentDate: new Date('2026-08-01T00:00:00.000Z'),
      supplierName: 'Bidfood Ltd',
      categoryCode: 'COST_OF_SALES',
      totalPence: 97_620,
      taxPence: 16_270,
    },
  });
}

const problem = async (p: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> => {
  try {
    await p;
    return { code: 'no-throw', status: 0 };
  } catch (e) {
    if (!(e instanceof AppException)) return { code: `unexpected:${String(e)}`, status: 0 };
    return { code: e.code, status: e.getStatus(), ...(e.publicDetail === undefined ? {} : { detail: e.publicDetail }) };
  }
};

describe.skipIf(!enabled)('the release gate against a real database (A12, D44)', () => {
  test('a practice admin who is NOT the owner is refused, and the release does not happen — at all', async () => {
    await seedDocument(DOC_1);
    const svc = service();

    // Composing is theirs: creating and reviewing the proposal is D44's first
    // half and neither is gated.
    const created = await svc.create(ADMIN_CTX, { kind: 'publish.batch', businessId: BIZ, payload: { documentIds: [DOC_1] } }, 'a12g-key-create');
    const review = await svc.review(ADMIN_CTX, created.id, 'a12g-key-review');
    expect(review.renderedSummary.title).toContain('Publish 1 document');

    const refused = await problem(svc.approve(ADMIN_CTX, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'a12g-key-approve'));
    expect(refused.code).toBe('NT-PRM-001');
    expect(refused.status).toBe(403);
    expect(refused.detail).toContain('super admin');
    // The refusal names the authority, never the record.
    expect(refused.detail).not.toContain(created.id);

    // NO EFFECT AT ALL. Every surface the executor would have touched:
    expect((await owner.document.findUnique({ where: { id: DOC_1 } }))?.state).toBe('READY');
    expect(await owner.publish.count({ where: { documentId: DOC_1 } })).toBe(0);
    expect(await owner.auditEvent.count({ where: { proposalId: created.id } })).toBe(0);
    // …and the proposal is NOT consumed, so the person who may release still can.
    const row = await owner.actionProposal.findUnique({ where: { id: created.id } });
    expect(row?.state).toBe('REVIEWED');
    expect(row?.executedAt).toBeNull();
    expect(row?.approvedByUserId).toBeNull();

    // The super admin approves the SAME proposal, and it releases.
    const executed = await svc.approve(OWNER_CTX, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'a12g-key-owner');
    expect(executed.state).toBe('EXECUTED');
    expect(executed.approvedByUserId).toBe(USER_OWNER);
    expect((await owner.document.findUnique({ where: { id: DOC_1 } }))?.state).toBe('PUBLISHED');

    // A5 left this stage its evidence: who released it is on the row.
    const publish = await owner.publish.findFirst({ where: { documentId: DOC_1 } });
    expect(publish?.state).toBe('SUCCEEDED');
    expect(publish?.publishedByUserId).toBe(USER_OWNER);
    expect(await owner.auditEvent.count({ where: { proposalId: created.id } })).toBe(1);
  });

  test('a standard member gets the same refusal — the gate is not about seniority, it is about D44', async () => {
    await seedDocument(DOC_2);
    const svc = service();
    const created = await svc.create(OWNER_CTX, { kind: 'publish.batch', businessId: BIZ, payload: { documentIds: [DOC_2] } }, 'a12g-key-create-2');
    const review = await svc.review(STAFF_CTX, created.id, 'a12g-key-review-2');

    const refused = await problem(svc.approve(STAFF_CTX, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'a12g-key-approve-2'));
    expect(refused.code).toBe('NT-PRM-001');
    expect((await owner.document.findUnique({ where: { id: DOC_2 } }))?.state).toBe('READY');
    expect(await owner.publish.count({ where: { documentId: DOC_2 } })).toBe(0);
  });

  test('visibility and authority are different refusals: another practice gets 404, never 403', async () => {
    const svc = service();
    const created = await svc.create(OWNER_CTX, { kind: 'publish.batch', businessId: BIZ, payload: { documentIds: [DOC_2] } }, 'a12g-key-rls');

    // RLS decides first, so the outsider never reaches the gate and the answer
    // never confirms the proposal exists.
    const invisible = await problem(svc.approve(OTHER_CTX, created.id, { renderedSummaryHash: 'f'.repeat(64) }, 'a12g-key-rls-approve'));
    expect(invisible.code).toBe('NT-VAL-001');
    expect(invisible.status).toBe(404);

    // The same call from inside the practice, without authority, is 403 — which
    // discloses nothing the caller could not already read on the proposal.
    const unauthorised = await problem(svc.approve(STAFF_CTX, created.id, { renderedSummaryHash: 'f'.repeat(64) }, 'a12g-key-rls-staff'));
    expect(unauthorised.code).toBe('NT-PRM-001');
    expect(unauthorised.status).toBe(403);
  });

  test('authority is decided before the review gate — an unreviewed release refuses NT-PRM-001, not NT-PRP-002', async () => {
    const svc = service();
    const created = await svc.create(OWNER_CTX, { kind: 'publish.batch', businessId: BIZ, payload: { documentIds: [DOC_2] } }, 'a12g-key-order');
    const early = await problem(svc.approve(ADMIN_CTX, created.id, { renderedSummaryHash: 'f'.repeat(64) }, 'a12g-key-order-approve'));
    expect(early.code).toBe('NT-PRM-001');
    // For the owner the same unreviewed call is the review gate, unchanged.
    const owned = await problem(svc.approve(OWNER_CTX, created.id, { renderedSummaryHash: 'f'.repeat(64) }, 'a12g-key-order-owner'));
    expect(owned.code).toBe('NT-PRP-002');
  });

  test('composing and editing stays open to everyone — a standard member archives without a murmur', async () => {
    const svc = service();
    const created = await svc.create(STAFF_CTX, { kind: 'document.archive', businessId: BIZ, payload: { documentIds: [DOC_2], archived: true } }, 'a12g-key-arch');
    const review = await svc.review(STAFF_CTX, created.id, 'a12g-key-arch-review');
    const executed = await svc.approve(STAFF_CTX, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'a12g-key-arch-approve');
    expect(executed.state).toBe('EXECUTED');
    expect((await owner.document.findUnique({ where: { id: DOC_2 } }))?.state).toBe('ARCHIVED');
  });
});
