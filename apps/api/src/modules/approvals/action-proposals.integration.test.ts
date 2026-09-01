import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { approveActionProposalResponse } from '@neoting/contracts/zod';

import { ScopeContextSchema } from '../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { AppException } from '../../common/problem/problem.js';
import { previewPublishBatch } from '../publishing/index.js';
import { buildExecutorRegistry, type PublishGateway } from '../validation-dedupe/index.js';
import { ActionProposalsService } from './action-proposals.service.js';
import { canonicalStringify, sha256Hex } from './canonical-hash.js';

/**
 * The REAL preview (it is pure), a stub ledger (this file proposes no publish
 * batches). `publish-batch.integration.test.ts` is where the real adapter runs.
 */
const PUBLISHING: PublishGateway = {
  ledger: { publishBill: async () => ({ ok: true, externalRef: 'STUB', attachmentSent: false }) },
  previewPublishBatch,
};

/**
 * The METH S3 acceptance (issue #122), against a REAL database as `nt_app`:
 *
 * - create → review → approve a `document.archive` proposal on a seeded
 *   document → the document is ARCHIVED and the audit row chains;
 * - approve WITHOUT review → refused — by the service with `NT-PRP-002`, and
 *   by the DATABASE GUARD when the service is bypassed entirely, which is the
 *   demo talking point: the constitution holds against code that has never
 *   read §10;
 * - double-approve → exactly-once (replayed key returns the original outcome;
 *   a fresh key gets `NT-PRP-005`);
 * - the approver's RLS context is the boundary: another practice's staff see
 *   404, never 403.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P_A = 'p122_prac_a';
const P_B = 'p122_prac_b';
const BIZ = 'p122_biz';

let owner: PrismaClient;
let app: PrismaClient;

const STAFF_A = ScopeContextSchema.parse({ actorId: 'p122_user_a', practiceId: P_A });
const STAFF_B = ScopeContextSchema.parse({ actorId: 'p122_user_b', practiceId: P_B });

// chase.send composition config for tests — a real secret so signed links verify.
const TEST_CHASE_COMPOSE = { portalLinkSecret: 'test-portal-link-secret', appOrigin: 'https://app.test' };

function service(): ActionProposalsService {
  return new ActionProposalsService(
    app,
    buildExecutorRegistry({ publishing: PUBLISHING }),
    // No route proposals here, so no follow-up ever runs; a stub keeps the
    // test independent of the detector's SYSTEM-actor seeding.
    { detect: async () => ({ findings: [], candidatesTruncated: false }) },
    PUBLISHING,
    new InMemoryIdempotencyStore(),
    TEST_CHASE_COMPOSE,
  );
}

async function cleanup(): Promise<void> {
  // audit_events is append-only BY TRIGGER, on purpose — the trigger fires for
  // every role, so test cleanup has to lift it for the one statement that
  // resets the fixture world. Test database only; the guarantee under test is
  // re-proven on every run.
  await owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
  await owner.auditEvent.deleteMany({ where: { OR: [{ businessId: BIZ }, { proposalId: { startsWith: 'p122_' } }] } });
  await owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
  await owner.actionProposal.deleteMany({ where: { OR: [{ practiceId: { in: [P_A, P_B] } }, { businessId: BIZ }] } });
  await owner.extraction.deleteMany({ where: { documentId: { startsWith: 'p122_' } } });
  await owner.documentEvent.deleteMany({ where: { documentId: { startsWith: 'p122_' } } });
  await owner.document.deleteMany({ where: { OR: [{ practiceId: { in: [P_A, P_B] } }, { businessId: BIZ }] } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 'p122_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 'p122_' } } });
  await owner.business.deleteMany({ where: { id: BIZ } });
  await owner.practice.deleteMany({ where: { id: { in: [P_A, P_B] } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.createMany({ data: [{ id: P_A, name: 'P122 A' }, { id: P_B, name: 'P122 B' }] });
  await owner.business.create({ data: { id: BIZ, practiceId: P_A, name: 'P122 Client' } });
  await owner.user.createMany({
    data: [
      { id: 'p122_user_a', email: 'p122a@example.test' },
      { id: 'p122_user_b', email: 'p122b@example.test' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 'p122_mem_a', userId: 'p122_user_a', practiceId: P_A, role: 'PRACTICE_ADMIN' },
      { id: 'p122_mem_b', userId: 'p122_user_b', practiceId: P_B, role: 'PRACTICE_ADMIN' },
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
      businessId: BIZ,
      s3Key: `w/${BIZ}/documents/${id}`,
      byteHash: `h-${id}`,
      mimeType: 'image/jpeg',
      byteSize: 10,
      channel: 'WEB_UPLOAD',
      originalFilename: 'currys-receipt.jpg',
      inbox: 'COSTS',
      state: 'READY',
      supplierName: 'Currys',
      totalPence: 129_900,
      categoryCode: 'OFFICE_EQUIPMENT',
      ...over,
    },
  });
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'no-throw';
  } catch (e) {
    return e instanceof AppException ? e.code : `unexpected:${String(e)}`;
  }
};

describe.skipIf(!enabled)('the Review → Approve engine against a real database', () => {
  test('create → review → approve archives the document, exactly once, with a chaining audit row', async () => {
    await seedDocument('p122_doc_1');
    const svc = service();

    const created = await svc.create(
      STAFF_A,
      { kind: 'document.archive', businessId: BIZ, payload: { documentIds: ['p122_doc_1'], archived: true } },
      'p122-key-create',
    );
    expect(created.state).toBe('CREATED');
    expect(created.reviewedAt).toBeNull();

    // Approve before review: the service refuses, and the document is untouched.
    expect(await code(svc.approve(STAFF_A, created.id, { renderedSummaryHash: 'f'.repeat(64) }, 'p122-key-early'))).toBe('NT-PRP-002');

    const review = await svc.review(STAFF_A, created.id, 'p122-key-review');
    expect(review.renderedSummary.title).toBe('Archive 1 document');

    // A stale rendered hash is refused before anything executes.
    expect(await code(svc.approve(STAFF_A, created.id, { renderedSummaryHash: 'a'.repeat(64) }, 'p122-key-stale'))).toBe('NT-PRP-004');

    const executed = await svc.approve(STAFF_A, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'p122-key-approve');
    expect(executed.state).toBe('EXECUTED');
    expect(executed.approvedByUserId).toBe('p122_user_a');
    expect(executed.outcome).toMatchObject({ alreadyApplied: false });
    // The response is contract-shaped — parsed by the generated strict schema.
    expect(approveActionProposalResponse.safeParse(executed).success).toBe(true);

    const document = await owner.document.findUnique({ where: { id: 'p122_doc_1' } });
    expect(document?.state).toBe('ARCHIVED');
    expect(document?.archivedAt).not.toBeNull();

    // The audit row chains: recompute the hash from the row's own claims.
    const audit = await owner.auditEvent.findFirst({ where: { proposalId: created.id } });
    expect(audit).not.toBeNull();
    expect(audit?.previousHash ?? null).toBeNull();
    expect(audit?.seq).toBe(1n);
    const recomputed = sha256Hex(
      '' +
        canonicalStringify({
          businessId: BIZ,
          seq: '1',
          event: 'action_proposal.executed',
          proposalId: created.id,
          payloadHash: executed.payloadHash,
          renderedSummaryHash: review.renderedSummaryHash,
          outcome: audit?.outcome,
        }),
    );
    expect(audit?.hash).toBe(recomputed);

    // Exactly-once: the replayed Idempotency-Key returns the ORIGINAL outcome
    // and executes nothing; a fresh key is refused NT-PRP-005.
    const replay = await svc.approve(STAFF_A, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'p122-key-approve');
    expect(replay).toEqual(executed);
    expect(await code(svc.approve(STAFF_A, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'p122-key-again'))).toBe('NT-PRP-005');
    expect(await owner.auditEvent.count({ where: { proposalId: created.id } })).toBe(1);
  });

  test('the DATABASE guard refuses approve-without-review and executed-row mutation — no service in the loop', async () => {
    const svc = service();
    const created = await svc.create(
      STAFF_A,
      { kind: 'document.archive', businessId: BIZ, payload: { documentIds: ['p122_doc_1'], archived: false } },
      'p122-key-guard',
    );

    // Bypass the service entirely: a raw UPDATE claiming approval with no
    // review. The trigger — not code — is what says no.
    await expect(
      owner.actionProposal.update({ where: { id: created.id }, data: { approvedAt: new Date(), approvedByUserId: 'p122_user_a' } }),
    ).rejects.toThrow(/approved without review/);

    // payload_hash is immutable after creation, same trigger.
    await expect(
      owner.actionProposal.update({ where: { id: created.id }, data: { payloadHash: 'a'.repeat(64) } }),
    ).rejects.toThrow(/payload changed after creation/);

    // And an executed proposal is terminal for ANY update.
    const executedRow = await owner.actionProposal.findFirst({ where: { state: 'EXECUTED', practiceId: P_A } });
    expect(executedRow).not.toBeNull();
    await expect(
      owner.actionProposal.update({ where: { id: executedRow?.id ?? '' }, data: { outcome: { tampered: true } } }),
    ).rejects.toThrow(/already executed/);
  });

  test('update-coding: approve applies field edits, records HUMAN_CONFIRMED extraction, and the audit chain links', async () => {
    await seedDocument('p122_doc_2', { state: 'TO_REVIEW', categoryCode: null, supplierName: 'CURRYS PLC' });
    const svc = service();

    const created = await svc.create(
      STAFF_A,
      {
        kind: 'document.update-coding',
        businessId: BIZ,
        payload: { documentId: 'p122_doc_2', fields: { supplierName: 'Currys', categoryCode: 'OFFICE_EQUIPMENT' } },
      },
      'p122-key-coding',
    );
    const review = await svc.review(STAFF_A, created.id, 'p122-key-coding-review');
    expect(review.renderedSummary.title).toBe('Update coding — supplierName, categoryCode');
    await svc.approve(STAFF_A, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'p122-key-coding-approve');

    const document = await owner.document.findUnique({ where: { id: 'p122_doc_2' } });
    expect(document?.supplierName).toBe('Currys');
    expect(document?.categoryCode).toBe('OFFICE_EQUIPMENT');
    expect(document?.state).toBe('READY'); // the correction supplied the last mandatory field

    const extraction = await owner.extraction.findFirst({ where: { documentId: 'p122_doc_2', isAccepted: true } });
    expect(extraction?.extractorKind).toBe('human');
    expect(extraction?.keyedByUserId).toBe('p122_user_a');
    expect((extraction?.fields as Record<string, Record<string, unknown>>)['supplierName']).toMatchObject({
      value: 'Currys',
      provenance: 'HUMAN_CONFIRMED',
      wasCorrected: true,
    });

    // Chain: this business's second audit row links back to the first.
    const rows = await owner.auditEvent.findMany({ where: { businessId: BIZ }, orderBy: { seq: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[1]?.seq).toBe(2n);
    expect(rows[1]?.previousHash).toBe(rows[0]?.hash);
  });

  test("RLS is the boundary: another practice's staff get 404 for get, review and approve — never 403", async () => {
    const svc = service();
    const created = await svc.create(
      STAFF_A,
      { kind: 'document.archive', businessId: BIZ, payload: { documentIds: ['p122_doc_1'], archived: false } },
      'p122-key-rls',
    );
    expect(await code(svc.get(STAFF_B, created.id))).toBe('NT-VAL-001');
    expect(await code(svc.review(STAFF_B, created.id, 'p122-b-review'))).toBe('NT-VAL-001');
    expect(await code(svc.approve(STAFF_B, created.id, { renderedSummaryHash: 'f'.repeat(64) }, 'p122-b-approve'))).toBe('NT-VAL-001');
    // And the proposal is untouched for its own practice.
    const still = await svc.get(STAFF_A, created.id);
    expect(still.state).toBe('CREATED');
  });

  test('the list (METH S12) serves the queue under RLS: own practice sees pending, the other sees an empty page', async () => {
    const svc = service();
    const created = await svc.create(
      STAFF_A,
      { kind: 'document.archive', businessId: BIZ, payload: { documentIds: ['p122_doc_1'], archived: false } },
      'p122-key-list',
    );

    const mine = await svc.list(STAFF_A, { state: ['CREATED', 'REVIEWED'], limit: 50 } as never);
    expect(mine.data.map((p) => p.id)).toContain(created.id);
    // Reading the queue is not reviewing — the row is untouched.
    expect(mine.data.find((p) => p.id === created.id)?.reviewedAt).toBeNull();

    const theirs = await svc.list(STAFF_B, { limit: 50 } as never);
    expect(theirs.data.map((p) => p.id)).not.toContain(created.id);
  });
});
