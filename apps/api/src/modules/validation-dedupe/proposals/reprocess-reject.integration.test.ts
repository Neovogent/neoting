import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../../common/idempotency/idempotency-store.js';
import { AppException } from '../../../common/problem/problem.js';
import { ActionProposalsService } from '../../approvals/action-proposals.service.js';
import { previewPublishBatch } from '../../publishing/index.js';
import { type PublishGateway } from './publish-batch.js';
import { buildExecutorRegistry } from './registry.js';
import { HUMAN_REJECTION_CODE } from './reject-document.js';

/**
 * `document.reject` and `document.reprocess` end to end through the REAL engine
 * against a real database (stage A12) — the two things an accountant tries on
 * day one and which threw `ProposalNotImplementedError` until this stage.
 *
 * What is proven here rather than reasoned:
 *
 * - rejecting drives the state machine, records the reason **verbatim** on the
 *   row, and leaves a gapless `document_events` log;
 * - reprocessing CLEARS that reason and returns the document to the queue a
 *   human works — reject → reprocess is a clean round trip;
 * - a document that FAILED extraction with nothing extracted comes back as
 *   TO_REVIEW, not as a released or ready one;
 * - neither is a release: a `PRACTICE_STANDARD` member approves both, because
 *   D44's first half is that the team composes and edits;
 * - RLS is the boundary — another practice's staff cannot reject a document
 *   they cannot see, and the refusal never confirms it exists.
 *
 * ⚠ Ids are prefixed **`a12x_`**, and every table is torn down by EXPLICIT id
 * list rather than `startsWith` (Prisma compiles that to an unescaped `LIKE`
 * whose `_` is a wildcard into a neighbouring suite).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P_A = 'a12x-prac-a';
const P_B = 'a12x-prac-b';
const BIZ = 'a12x-biz';
const DOC_CODED = 'a12x-doc-coded';
const DOC_FAILED = 'a12x-doc-failed';
const DOC_PUBLISHED = 'a12x-doc-published';
const DOCUMENTS = [DOC_CODED, DOC_FAILED, DOC_PUBLISHED];
const USER_A = 'a12x-user-a';
const USER_B = 'a12x-user-b';
const USERS = [USER_A, USER_B];
const MEMBERSHIPS = ['a12x-mem-a', 'a12x-mem-b'];

let owner: PrismaClient;
let app: PrismaClient;

/** Deliberately a STANDARD member: neither kind is a release (A12's `RELEASE_KINDS`). */
const STAFF_A = ScopeContextSchema.parse({ actorId: USER_A, practiceId: P_A });
const STAFF_B = ScopeContextSchema.parse({ actorId: USER_B, practiceId: P_B });

const PUBLISHING: PublishGateway = {
  ledger: {
    publishBill: async () => {
      throw new Error('no proposal in this suite reaches a ledger');
    },
  },
  previewPublishBatch,
};

function service(): ActionProposalsService {
  return new ActionProposalsService(
    app,
    buildExecutorRegistry({ publishing: PUBLISHING }),
    { detect: async () => ({ findings: [], candidatesTruncated: false }) },
    PUBLISHING,
    new InMemoryIdempotencyStore(),
  );
}

async function cleanup(): Promise<void> {
  await owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
  await owner.auditEvent.deleteMany({ where: { businessId: BIZ } });
  await owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
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
  await owner.practice.createMany({ data: [{ id: P_A, name: 'A12X A' }, { id: P_B, name: 'A12X B' }] });
  await owner.business.create({ data: { id: BIZ, practiceId: P_A, name: 'A12X Client' } });
  await owner.user.createMany({
    data: [
      { id: USER_A, email: 'a12x-a@example.test' },
      { id: USER_B, email: 'a12x-b@example.test' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 'a12x-mem-a', userId: USER_A, practiceId: P_A, role: 'PRACTICE_STANDARD' },
      { id: 'a12x-mem-b', userId: USER_B, practiceId: P_B, role: 'PRACTICE_STANDARD' },
    ],
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

interface Fixture {
  readonly state?: 'READY' | 'FAILED' | 'PUBLISHED';
  readonly supplierName?: string | null;
  readonly categoryCode?: string | null;
  readonly totalPence?: number | null;
  readonly failureCode?: string;
  readonly failureMessage?: string;
}

async function seedDocument(id: string, over: Fixture = {}): Promise<void> {
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
      state: over.state ?? 'READY',
      docType: 'INVOICE',
      currency: 'GBP',
      supplierName: over.supplierName === undefined ? 'Bidfood Ltd' : over.supplierName,
      categoryCode: over.categoryCode === undefined ? 'COST_OF_SALES' : over.categoryCode,
      totalPence: over.totalPence === undefined ? 97_620 : over.totalPence,
      ...(over.failureCode === undefined ? {} : { failureCode: over.failureCode, failureMessage: over.failureMessage }),
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

/** create → review → approve, the whole constitutional path, in one call. */
async function drive(
  svc: ActionProposalsService,
  kind: 'document.reject' | 'document.reprocess',
  payload: Record<string, unknown>,
  keyPrefix: string,
  ctx = STAFF_A,
): Promise<{ id: string; title: string }> {
  const created = await svc.create(ctx, { kind, businessId: BIZ, payload }, `${keyPrefix}-create`);
  const review = await svc.review(ctx, created.id, `${keyPrefix}-review`);
  await svc.approve(ctx, created.id, { renderedSummaryHash: review.renderedSummaryHash }, `${keyPrefix}-approve`);
  return { id: created.id, title: review.renderedSummary.title };
}

describe.skipIf(!enabled)('reject and reprocess through the real engine (A12)', () => {
  test('reject records the reason verbatim; reprocess clears it and hands the document back', async () => {
    await seedDocument(DOC_CODED);
    const svc = service();

    const rejected = await drive(
      svc,
      'document.reject',
      { documentIds: [DOC_CODED], reason: 'Personal receipt — not a business cost' },
      'a12x-reject',
    );
    expect(rejected.title).toBe('Reject 1 document');

    const afterReject = await owner.document.findUnique({ where: { id: DOC_CODED } });
    expect(afterReject?.state).toBe('REJECTED');
    expect(afterReject?.failureCode).toBe(HUMAN_REJECTION_CODE);
    expect(afterReject?.failureMessage).toBe('Personal receipt — not a business cost');

    // Now the undo. The document was fully coded, so readiness returns it to READY.
    const retried = await drive(svc, 'document.reprocess', { documentIds: [DOC_CODED] }, 'a12x-retry');
    expect(retried.title).toBe('Retry 1 document');

    const afterRetry = await owner.document.findUnique({ where: { id: DOC_CODED } });
    expect(afterRetry?.state).toBe('READY');
    // The retried document does not still carry why it failed.
    expect(afterRetry?.failureCode).toBeNull();
    expect(afterRetry?.failureMessage).toBeNull();

    // The processing log has no gap: REJECTED, then PROCESSING, then READY.
    const events = await owner.documentEvent.findMany({
      where: { documentId: DOC_CODED, stage: 'state' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.outcome)).toEqual(['REJECTED', 'PROCESSING', 'READY']);
    expect(events[1]?.detail).toMatchObject({ from: 'REJECTED', to: 'PROCESSING', via: 'reprocess' });

    // Two approvals, two audit rows, chained.
    const audits = await owner.auditEvent.findMany({ where: { businessId: BIZ }, orderBy: { seq: 'asc' } });
    expect(audits).toHaveLength(2);
    expect(audits[1]?.previousHash).toBe(audits[0]?.hash);
  });

  test('a failed extraction comes back to TO_REVIEW — in front of a human, not stuck on the failed surface', async () => {
    await seedDocument(DOC_FAILED, {
      state: 'FAILED',
      supplierName: null,
      categoryCode: null,
      totalPence: null,
      failureCode: 'NT-EXT-001',
      failureMessage: 'We could not read this document',
    });
    const svc = service();

    const retried = await drive(svc, 'document.reprocess', { documentIds: [DOC_FAILED], fromStage: 'extract' }, 'a12x-failed');
    // The review card states the limit a human is agreeing to.
    expect(retried.title).toBe('Retry 1 document');

    const row = await owner.document.findUnique({ where: { id: DOC_FAILED } });
    expect(row?.state).toBe('TO_REVIEW');
    expect(row?.failureCode).toBeNull();

    // The outcome says what happened, in the words that are true of it.
    const proposal = await owner.actionProposal.findUnique({ where: { id: retried.id } });
    expect(proposal?.outcome).toMatchObject({ detail: { retried: 1, toReview: 1, extractionRerun: false, fromStage: 'extract' } });
  });

  test('a PUBLISHED document is refused by both, and stays exactly where it was', async () => {
    await seedDocument(DOC_PUBLISHED, { state: 'PUBLISHED' });
    const svc = service();

    const reject = await svc.create(STAFF_A, { kind: 'document.reject', businessId: BIZ, payload: { documentIds: [DOC_PUBLISHED], reason: 'no' } }, 'a12x-pub-create');
    const rejectReview = await svc.review(STAFF_A, reject.id, 'a12x-pub-review');
    expect(await code(svc.approve(STAFF_A, reject.id, { renderedSummaryHash: rejectReview.renderedSummaryHash }, 'a12x-pub-approve'))).toBe('NT-PRP-006');

    const retry = await svc.create(STAFF_A, { kind: 'document.reprocess', businessId: BIZ, payload: { documentIds: [DOC_PUBLISHED] } }, 'a12x-pub2-create');
    const retryReview = await svc.review(STAFF_A, retry.id, 'a12x-pub2-review');
    expect(await code(svc.approve(STAFF_A, retry.id, { renderedSummaryHash: retryReview.renderedSummaryHash }, 'a12x-pub2-approve'))).toBe('NT-PRP-006');

    expect((await owner.document.findUnique({ where: { id: DOC_PUBLISHED } }))?.state).toBe('PUBLISHED');
    expect(await owner.documentEvent.count({ where: { documentId: DOC_PUBLISHED } })).toBe(0);
  });

  test("RLS is the boundary: another practice cannot reject a document it cannot see, and is told nothing", async () => {
    const svc = service();
    // The proposal itself is refused at creation — the business is invisible, and
    // an unreachable business and an absent one are the same answer.
    expect(
      await code(
        svc.create(STAFF_B, { kind: 'document.reject', businessId: BIZ, payload: { documentIds: [DOC_CODED], reason: 'no' } }, 'a12x-rls'),
      ),
    ).toBe('NT-PRP-006');
    expect((await owner.document.findUnique({ where: { id: DOC_CODED } }))?.state).toBe('READY');
  });
});
