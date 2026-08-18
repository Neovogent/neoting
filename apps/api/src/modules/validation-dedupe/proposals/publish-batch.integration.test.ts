import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { PublishBatchPayload } from '@neoting/contracts/model';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { InMemoryIdempotencyStore } from '../../../common/idempotency/idempotency-store.js';
import { ActionProposalsService } from '../../approvals/action-proposals.service.js';
import { DemoXeroAdapter, demoExternalRef } from '../../publishing/demo-xero-adapter.js';
import { LEDGER_REJECTED, previewPublishBatch } from '../../publishing/index.js';
import { ProposalExecutionRefused } from './proposal-executor.js';
import { createPublishBatchExecutor, type PublishGateway } from './publish-batch.js';
import { runPublishFollowUp } from './publish-follow-up.js';
import { buildExecutorRegistry } from './registry.js';

/**
 * The METH Stage 10 acceptance, against a REAL database:
 *
 * - a Ready document publishes → external ref on the `publishes` row, the
 *   document LOCKS (PUBLISHED) and then auto-archives, via the archive
 *   executor rather than a second implementation of archiving;
 * - the scripted failure lands with a REASON on both the `publishes` row and
 *   the document, and the document is findable on the Rejected/Failed surface;
 * - the RETRY — a new proposal over the failed item, never a replay of the old
 *   attempt — succeeds, and the failed attempt is still there, untouched;
 * - an item missing Category refuses the whole batch with `NT-PUB-001`, and
 *   nothing is written;
 * - a replay of the same proposal is `alreadyApplied`: no second row, no
 *   second follow-up, therefore no second vendor call;
 * - the full engine flow, create → review → approve, drives all of it.
 *
 * ⚠ Ids are prefixed `s10_`, not `p10_`. `publishing/publishes.integration.test.ts`
 * (the read lane of this same stage) already owns `p10_`, and the collision
 * would not have been a name clash — Prisma compiles `startsWith: 'p10_'` to
 * `LIKE 'p10_%'` WITHOUT escaping the `_`, so that file's teardown
 * single-char-wildcards its way through any `p10?_…` prefix and deletes another
 * file's fixtures mid-run (the hazard `vitest.config.ts` documents). `s10_`
 * shares no three-character stem with any prefix in the suite, in either
 * direction.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P_A = 's10_prac_a';
const P_B = 's10_prac_b';
const BIZ = 's10_biz';
/** Same practice, no ledger connected — the refusal `biz_dental` shows in the seed. */
const BIZ_BARE = 's10_biz_bare';
const INT = 's10_int';

let owner: PrismaClient;
let app: PrismaClient;

const STAFF_A = ScopeContextSchema.parse({ actorId: 's10_user_a', practiceId: P_A });
const STAFF_B = ScopeContextSchema.parse({ actorId: 's10_user_b', practiceId: P_B });

/** Zero delay: the latency is real product behaviour, and a test must never buy it. */
const ledger = new DemoXeroAdapter({ perItemDelayMs: 0 });
/** The REAL preview — it is pure — behind the real adapter. */
const PUBLISHING: PublishGateway = { ledger, previewPublishBatch };
const executor = createPublishBatchExecutor(PUBLISHING);

async function cleanup(): Promise<void> {
  await owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
  await owner.auditEvent.deleteMany({ where: { OR: [{ businessId: { in: [BIZ, BIZ_BARE] } }, { proposalId: { startsWith: 's10_' } }] } });
  await owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
  await owner.publish.deleteMany({ where: { businessId: { in: [BIZ, BIZ_BARE] } } });
  await owner.actionProposal.deleteMany({ where: { OR: [{ practiceId: { in: [P_A, P_B] } }, { businessId: { in: [BIZ, BIZ_BARE] } }] } });
  await owner.documentEvent.deleteMany({ where: { documentId: { startsWith: 's10_' } } });
  await owner.document.deleteMany({ where: { OR: [{ practiceId: { in: [P_A, P_B] } }, { businessId: { in: [BIZ, BIZ_BARE] } }] } });
  await owner.integration.deleteMany({ where: { businessId: { in: [BIZ, BIZ_BARE] } } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 's10_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 's10_' } } });
  await owner.business.deleteMany({ where: { id: { in: [BIZ, BIZ_BARE] } } });
  await owner.practice.deleteMany({ where: { id: { in: [P_A, P_B] } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.createMany({ data: [{ id: P_A, name: 'S10 A' }, { id: P_B, name: 'S10 B' }] });
  await owner.business.createMany({
    data: [
      { id: BIZ, practiceId: P_A, name: 'S10 Client' },
      { id: BIZ_BARE, practiceId: P_A, name: 'S10 Client Without Xero' },
    ],
  });
  await owner.user.createMany({
    data: [
      { id: 's10_user_a', email: 's10a@example.test' },
      { id: 's10_user_b', email: 's10b@example.test' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 's10_mem_a', userId: 's10_user_a', practiceId: P_A, role: 'PRACTICE_ADMIN' },
      { id: 's10_mem_b', userId: 's10_user_b', practiceId: P_B, role: 'PRACTICE_ADMIN' },
    ],
  });
  await owner.integration.create({
    data: { id: INT, businessId: BIZ, kind: 'XERO', orgRef: 's10-org', health: 'healthy', isActive: true },
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

interface DocumentFixture {
  readonly supplierName?: string | null;
  readonly categoryCode?: string | null;
  readonly totalPence?: number | null;
  readonly taxPence?: number | null;
  readonly businessId?: string;
}

async function seedDocument(id: string, over: DocumentFixture = {}): Promise<void> {
  await owner.document.create({
    data: {
      id,
      practiceId: P_A,
      businessId: over.businessId ?? BIZ,
      s3Key: `w/${over.businessId ?? BIZ}/documents/${id}`,
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
      reference: `REF-${id}`,
      supplierName: over.supplierName === undefined ? 'Bidfood Ltd' : over.supplierName,
      categoryCode: over.categoryCode === undefined ? 'COST_OF_SALES' : over.categoryCode,
      totalPence: over.totalPence === undefined ? 97_620 : over.totalPence,
      taxPence: over.taxPence === undefined ? 16_270 : over.taxPence,
    },
  });
}

/** The server-computed preview, from the same function the proposal path uses. */
async function previewOf(ids: readonly string[]): Promise<PublishBatchPayload['preview']> {
  const rows = await owner.document.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, totalPence: true, taxPence: true, supplierName: true, categoryCode: true },
  });
  const outcome = previewPublishBatch(rows);
  if (!outcome.ok) throw new Error('fixture is not publishable');
  return outcome.preview;
}

const input = (proposalId: string, payload: PublishBatchPayload, ctx = STAFF_A) => ({
  proposalId,
  payload,
  ctx,
  traceId: `trace-${proposalId}`,
});

/** Execute the effect, then run the post-commit follow-up the way the engine does. */
async function executeAndPublish(proposalId: string, payload: PublishBatchPayload): Promise<void> {
  const result = await scopedDb(app, STAFF_A, (db) => executor.execute(db, input(proposalId, payload)));
  const followUp = result.followUps[0];
  if (followUp?.kind !== 'publish') throw new Error('expected a publish follow-up');
  await runPublishFollowUp(app, STAFF_A, followUp, ledger, `trace-${proposalId}`);
}

describe.skipIf(!enabled)('publish.batch against a real database', () => {
  test('a Ready document publishes: external ref, the document locks, then auto-archives', async () => {
    await seedDocument('s10_doc_ok');
    const payload: PublishBatchPayload = { documentIds: ['s10_doc_ok'], preview: await previewOf(['s10_doc_ok']) };

    const result = await scopedDb(app, STAFF_A, (db) => executor.execute(db, input('s10_prop_ok', payload)));

    // The effect transaction wrote INTENT, not a publish: the ledger has not
    // been called yet, and that is the whole design.
    expect(result.alreadyApplied).toBe(false);
    expect(result.followUps).toEqual([{ kind: 'publish', proposalId: 's10_prop_ok', businessId: BIZ }]);
    const queued = await owner.publish.findFirst({ where: { actionProposalId: 's10_prop_ok' } });
    expect(queued?.state).toBe('QUEUED');
    expect(queued?.idempotencyKey).toBe('s10_prop_ok:s10_doc_ok');
    expect(queued?.mode).toBe('MANUAL');
    expect(queued?.publishedByUserId).toBe('s10_user_a');
    expect(queued?.externalRef).toBeNull();
    expect((await owner.document.findUnique({ where: { id: 's10_doc_ok' } }))?.state).toBe('READY');

    const followUp = result.followUps[0];
    if (followUp?.kind !== 'publish') throw new Error('unreachable');
    await runPublishFollowUp(app, STAFF_A, followUp, ledger, 'trace-s10_prop_ok');

    const published = await owner.publish.findFirst({ where: { actionProposalId: 's10_prop_ok' } });
    expect(published?.state).toBe('SUCCEEDED');
    expect(published?.externalRef).toBe(demoExternalRef('s10_doc_ok'));
    expect(published?.attachmentSent).toBe(true);
    expect(published?.completedAt).not.toBeNull();
    expect(published?.failureCode).toBeNull();

    // Locked, then auto-archived — and the archive recorded PUBLISHED as the
    // state to restore, which is the archive executor's own behaviour, reused.
    const document = await owner.document.findUnique({ where: { id: 's10_doc_ok' } });
    expect(document?.state).toBe('ARCHIVED');
    expect(document?.archivedAt).not.toBeNull();
    const archiveEvent = await owner.documentEvent.findFirst({
      where: { documentId: 's10_doc_ok', stage: 'state', outcome: 'ARCHIVED' },
    });
    expect((archiveEvent?.detail as Record<string, unknown>)['from']).toBe('PUBLISHED');
  });

  test('a replay of the same proposal is alreadyApplied — no second row, no second follow-up', async () => {
    // The document is ARCHIVED by now, so a replay that re-read state instead
    // of noticing its own rows would refuse. Noticing its own rows is the point.
    const payload: PublishBatchPayload = { documentIds: ['s10_doc_ok'], preview: { itemCount: 1, grossPence: 97_620, vatPence: 16_270 } };
    const replay = await scopedDb(app, STAFF_A, (db) => executor.execute(db, input('s10_prop_ok', payload)));
    expect(replay.alreadyApplied).toBe(true);
    // No follow-up means no second vendor call and no second state move.
    expect(replay.followUps).toEqual([]);
    expect(await owner.publish.count({ where: { actionProposalId: 's10_prop_ok' } })).toBe(1);
  });

  test('the scripted failure lands with a reason on the row AND on the Rejected/Failed surface', async () => {
    // British Gas is the demo's flagged supplier — a marker the executor
    // already reads, so `prisma/seed.ts` (LAW, and edited on another branch)
    // needs no flag column. It hits seeded `doc_007` in the real demo.
    await seedDocument('s10_doc_gas', { supplierName: 'British Gas', totalPence: 41_266, taxPence: 1_965 });
    await executeAndPublish('s10_prop_fail', {
      documentIds: ['s10_doc_gas'],
      preview: await previewOf(['s10_doc_gas']),
    });

    const failed = await owner.publish.findFirst({ where: { actionProposalId: 's10_prop_fail' } });
    expect(failed?.state).toBe('FAILED');
    expect(failed?.failureCode).toBe(LEDGER_REJECTED);
    // "A failure with no reason attached is a bug, not a state" — the contract.
    expect(failed?.failureMessage).toContain('British Gas');
    expect(failed?.externalRef).toBeNull();
    expect(failed?.completedAt).not.toBeNull();

    const document = await owner.document.findUnique({ where: { id: 's10_doc_gas' } });
    expect(document?.state).toBe('REJECTED');
    expect(document?.failureCode).toBe(LEDGER_REJECTED);
    expect(document?.failureMessage).toBe(failed?.failureMessage);

    // Visible on the surface a human actually looks at, under RLS.
    const surfaced = await scopedDb(app, STAFF_A, (db) =>
      db.document.findMany({ where: { state: { in: ['REJECTED', 'FAILED'] }, businessId: BIZ }, select: { id: true } }),
    );
    expect(surfaced.map((row) => row.id)).toContain('s10_doc_gas');
  });

  test('the retry — a NEW proposal over the failed item — succeeds, and the failed attempt is never touched', async () => {
    await executeAndPublish('s10_prop_retry', {
      documentIds: ['s10_doc_gas'],
      preview: await previewOf(['s10_doc_gas']),
    });

    const attempts = await owner.publish.findMany({ where: { documentId: 's10_doc_gas' }, orderBy: { createdAt: 'asc' } });
    expect(attempts).toHaveLength(2);
    // "The old attempt is never replayed and never deleted" — the contract.
    expect(attempts[0]?.state).toBe('FAILED');
    expect(attempts[0]?.failureCode).toBe(LEDGER_REJECTED);
    expect(attempts[0]?.externalRef).toBeNull();
    expect(attempts[1]?.state).toBe('SUCCEEDED');
    expect(attempts[1]?.externalRef).toBe(demoExternalRef('s10_doc_gas'));
    expect(attempts[1]?.idempotencyKey).toBe('s10_prop_retry:s10_doc_gas');

    const document = await owner.document.findUnique({ where: { id: 's10_doc_gas' } });
    expect(document?.state).toBe('ARCHIVED');
    // The reason cleared on the way through PROCESSING: a published document
    // must not still claim the ledger refused it.
    expect(document?.failureCode).toBeNull();
    expect(document?.failureMessage).toBeNull();
  });

  test('an item missing Category refuses the WHOLE batch with NT-PUB-001, and nothing is written', async () => {
    await seedDocument('s10_doc_good');
    await seedDocument('s10_doc_nocat', { categoryCode: null });
    const payload: PublishBatchPayload = {
      documentIds: ['s10_doc_good', 's10_doc_nocat'],
      // The figures a human would have been shown; the minimum refuses first.
      preview: { itemCount: 2, grossPence: 195_240, vatPence: 32_540 },
    };

    const error = await scopedDb(app, STAFF_A, (db) => executor.execute(db, input('s10_prop_nocat', payload)))
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProposalExecutionRefused);
    expect((error as Error).message).toContain('NT-PUB-001');
    expect((error as Error).message).toContain('category');
    expect((error as Error).message).toContain('s10_doc_nocat');
    // All-or-nothing: the healthy sibling did not publish either.
    expect(await owner.publish.count({ where: { actionProposalId: 's10_prop_nocat' } })).toBe(0);
    expect((await owner.document.findUnique({ where: { id: 's10_doc_good' } }))?.state).toBe('READY');
  });

  test('a batch whose live figures no longer match the reviewed preview refuses', async () => {
    const payload: PublishBatchPayload = {
      documentIds: ['s10_doc_good'],
      preview: { itemCount: 1, grossPence: 1, vatPence: 0 },
    };
    await expect(
      scopedDb(app, STAFF_A, (db) => executor.execute(db, input('s10_prop_drift', payload))),
    ).rejects.toThrow('no longer matches the figures that were reviewed');
    expect(await owner.publish.count({ where: { actionProposalId: 's10_prop_drift' } })).toBe(0);
  });

  test('a client with no active ledger connection refuses before anything is written', async () => {
    await seedDocument('s10_doc_bare', { businessId: BIZ_BARE });
    const payload: PublishBatchPayload = { documentIds: ['s10_doc_bare'], preview: await previewOf(['s10_doc_bare']) };
    await expect(
      scopedDb(app, STAFF_A, (db) => executor.execute(db, input('s10_prop_bare', payload))),
    ).rejects.toThrow('no active ledger connection');
    expect(await owner.publish.count({ where: { businessId: BIZ_BARE } })).toBe(0);
  });

  test('an already-published document refuses a second batch — the double-post the idempotency key exists to prevent', async () => {
    await expect(
      scopedDb(app, STAFF_A, (db) =>
        executor.execute(
          db,
          input('s10_prop_again', { documentIds: ['s10_doc_ok'], preview: { itemCount: 1, grossPence: 97_620, vatPence: 16_270 } }),
        ),
      ),
    ).rejects.toThrow('cannot be published');
  });

  test("another practice's staff cannot publish this practice's document, and is not told why", async () => {
    const error = await scopedDb(app, STAFF_B, (db) =>
      executor.execute(
        db,
        input(
          's10_prop_foreign',
          { documentIds: ['s10_doc_good'], preview: { itemCount: 1, grossPence: 97_620, vatPence: 16_270 } },
          STAFF_B,
        ),
      ),
    )
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProposalExecutionRefused);
    // 404-never-403: the wording does not distinguish absent from invisible.
    expect((error as Error).message).toContain('not reachable');
    expect((error as Error).message).not.toContain('permission');
    expect((await owner.document.findUnique({ where: { id: 's10_doc_good' } }))?.state).toBe('READY');
  });

  test('the FULL flow: create → review → approve publishes, locks and archives through the real engine', async () => {
    await seedDocument('s10_doc_flow', { supplierName: 'Adobe Systems', totalPence: 6_199, taxPence: 1_033 });
    const service = new ActionProposalsService(
      app,
      buildExecutorRegistry({ publishing: PUBLISHING }),
      { detect: async () => ({ findings: [], candidatesTruncated: false }) },
      PUBLISHING,
      new InMemoryIdempotencyStore(),
    );

    const created = await service.create(
      STAFF_A,
      {
        kind: 'publish.batch',
        businessId: BIZ,
        payload: { documentIds: ['s10_doc_flow'], preview: await previewOf(['s10_doc_flow']) },
      },
      's10-key-create',
    );

    // What Read review renders is the server-computed preview, in pounds.
    const review = await service.review(STAFF_A, created.id, 's10-key-review');
    expect(review.renderedSummary.title).toContain('Publish 1 document');
    expect(review.renderedSummary.title).toContain('61.99');

    const executed = await service.approve(
      STAFF_A,
      created.id,
      { renderedSummaryHash: review.renderedSummaryHash },
      's10-key-approve',
    );
    expect(executed.state).toBe('EXECUTED');
    expect(executed.outcome).toMatchObject({ alreadyApplied: false });

    // The follow-up ran post-commit, inside approve, and the books moved.
    const row = await owner.publish.findFirst({ where: { actionProposalId: created.id } });
    expect(row?.state).toBe('SUCCEEDED');
    expect(row?.externalRef).toBe(demoExternalRef('s10_doc_flow'));
    expect(row?.actionProposalId).toBe(created.id);
    const document = await owner.document.findUnique({ where: { id: 's10_doc_flow' } });
    expect(document?.state).toBe('ARCHIVED');
  });
});
