import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { PublishBatchPayload } from '@neoting/contracts/model';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { AppException } from '../../../common/problem/problem.js';
import { InMemoryIdempotencyStore } from '../../../common/idempotency/idempotency-store.js';

// chase.send composition config for tests — a real secret so signed links verify.
const TEST_CHASE_COMPOSE = { portalLinkSecret: 'test-portal-link-secret', appOrigin: 'https://app.test' };
import { ActionProposalsService } from '../../approvals/action-proposals.service.js';
import { analysisAccountChart, previewExportEntries } from '../../exports-public-api/index.js';
import { LEDGER_REJECTED, previewPublishBatch } from '../../publishing/index.js';
import { ChartOfAccountsService } from '../../rules-suggestions/index.js';
import { ProposalExecutionRefused } from './proposal-executor.js';
import { createPublishBatchExecutor, type ExportEntryPreviewer, type PublishGateway } from './publish-batch.js';
import { buildExecutorRegistry } from './registry.js';

/**
 * `publish.batch` under **D42**, against a REAL database — the stage that makes
 * a document able to reach Published at all.
 *
 * *Published* is an INTERNAL state meaning approved and **released for export**.
 * Nothing here calls a ledger; the adapter on the gateway is a tripwire that
 * throws if anything does.
 *
 * - a Ready document releases → a SUCCEEDED `publishes` row with no external
 *   reference, and the document reaches **PUBLISHED and stays there** (the
 *   contract exports only PUBLISHED documents, so an auto-archive would hide
 *   every one of them);
 * - **a client with no integration row releases too** — that refusal is what
 *   stranded every document at READY, and D47 forbids intake from asking for a
 *   connection;
 * - a dormant seeded ledger-vendor row is never adopted as an export
 *   destination;
 * - a document sitting REJECTED with a failed attempt re-enters through
 *   REJECTED → PROCESSING → READY and releases, and the failed attempt is
 *   still there, untouched;
 * - an item missing Category refuses the whole batch with `NT-PUB-001`, and
 *   nothing is written;
 * - a replay of the same proposal is `alreadyApplied`: no second row, no
 *   second release;
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
/** The ordinary ID client: one VT export destination, the row A11's intake creates. */
const BIZ = 's10_biz';
/** A client with NO integration row at all — which must still release (D42 + D47). */
const BIZ_BARE = 's10_biz_bare';
/** A client carrying only a dormant seeded XERO row, which is not an export destination. */
const BIZ_LEGACY = 's10_biz_legacy';
const INT = 's10_int';
const INT_LEGACY = 's10_int_legacy';

let owner: PrismaClient;
let app: PrismaClient;

const STAFF_A = ScopeContextSchema.parse({ actorId: 's10_user_a', practiceId: P_A });
const STAFF_B = ScopeContextSchema.parse({ actorId: 's10_user_b', practiceId: P_B });

/**
 * The REAL preview (it is pure) behind a ledger that must never be reached.
 * D42 removed the vendor call; this is what proves it stayed removed.
 */
const PUBLISHING: PublishGateway = {
  ledger: {
    publishBill: async () => {
      throw new Error('D42: releasing a document for export must never reach a ledger');
    },
  },
  previewPublishBatch,
};
const executor = createPublishBatchExecutor(PUBLISHING);

/**
 * The entry previewer, composed **exactly the way `approvals.module.ts` composes
 * it**: the export's own emitter over the client's own chart of accounts, read
 * inside the executor's transaction.
 *
 * Composing it any other way here would make this suite prove something the
 * product does not do. `s10_doc_flow` is coded `COST_OF_SALES`, which is
 * deliberately **not** a code on the seeded chart (`COS_PURCHASES` is) — so the
 * assertions below see the honest unresolved answer: the bare code, and the
 * `analysis-account-unprefixed` warning that puts it in front of the accountant
 * before the release.
 */
const ENTRY_PREVIEW: ExportEntryPreviewer = async (db, target, documents) => {
  const businessId = documents[0]?.businessId ?? null;
  if (businessId === null) return previewExportEntries(target, documents, null);
  const chart = await new ChartOfAccountsService(app).resolve(db, businessId);
  return previewExportEntries(target, documents, analysisAccountChart(chart.categories));
};

const BUSINESSES = [BIZ, BIZ_BARE, BIZ_LEGACY];

async function cleanup(): Promise<void> {
  await owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
  await owner.auditEvent.deleteMany({ where: { OR: [{ businessId: { in: BUSINESSES } }, { proposalId: { startsWith: 's10_' } }] } });
  await owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
  await owner.publish.deleteMany({ where: { businessId: { in: BUSINESSES } } });
  await owner.actionProposal.deleteMany({ where: { OR: [{ practiceId: { in: [P_A, P_B] } }, { businessId: { in: BUSINESSES } }] } });
  await owner.documentEvent.deleteMany({ where: { documentId: { startsWith: 's10_' } } });
  await owner.document.deleteMany({ where: { OR: [{ practiceId: { in: [P_A, P_B] } }, { businessId: { in: BUSINESSES } }] } });
  await owner.integration.deleteMany({ where: { businessId: { in: BUSINESSES } } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 's10_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 's10_' } } });
  await owner.business.deleteMany({ where: { id: { in: BUSINESSES } } });
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
      { id: BIZ_BARE, practiceId: P_A, name: 'S10 Client Without Any Integration' },
      { id: BIZ_LEGACY, practiceId: P_A, name: 'S10 Client With A Dormant Vendor Row' },
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
      // ⚠ `isOwner` matters since stage A12: `publish.batch` is a RELEASE, and
      // the gate on the engine's approve path requires the firm's super admin —
      // the release role AND the ownership flag. Without it every approval in
      // this suite refuses `NT-PRM-001` and the executor never runs. That is the
      // gate working, not the fixture being fussy.
      { id: 's10_mem_a', userId: 's10_user_a', practiceId: P_A, role: 'PRACTICE_ADMIN', isOwner: true },
      { id: 's10_mem_b', userId: 's10_user_b', practiceId: P_B, role: 'PRACTICE_ADMIN', isOwner: true },
    ],
  });
  // ⚠ This row is what A11 (client intake) creates for every new client. Until
  // A11 merges, nothing in the product writes it — which is exactly why the
  // executor no longer requires it, and why BIZ_BARE has one test of its own.
  await owner.integration.create({ data: { id: INT, businessId: BIZ, kind: 'VT', isActive: true } });
  await owner.integration.create({ data: { id: INT_LEGACY, businessId: BIZ_LEGACY, kind: 'XERO', orgRef: 's10-org', isActive: true } });
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
  readonly state?: 'READY' | 'REJECTED';
  readonly failureCode?: string;
  readonly failureMessage?: string;
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
      state: over.state ?? 'READY',
      docType: 'INVOICE',
      currency: 'GBP',
      documentDate: new Date('2026-08-01T00:00:00.000Z'),
      reference: `REF-${id}`,
      supplierName: over.supplierName === undefined ? 'Bidfood Ltd' : over.supplierName,
      categoryCode: over.categoryCode === undefined ? 'COST_OF_SALES' : over.categoryCode,
      totalPence: over.totalPence === undefined ? 97_620 : over.totalPence,
      taxPence: over.taxPence === undefined ? 16_270 : over.taxPence,
      ...(over.failureCode === undefined ? {} : { failureCode: over.failureCode, failureMessage: over.failureMessage }),
    },
  });
}

/**
 * The server-computed preview, from the same function the proposal path uses.
 *
 * ⚠ **This projection must match the executor's `DOCUMENT_SELECT`.** It briefly
 * did not — `currency` was added to the preview and not here — and every test in
 * this file that reaches the executor refused with "the batch no longer matches
 * the figures that were reviewed" while quoting two identical sets of figures,
 * because the thing that differed was the field the message does not print. A
 * fixture that reads fewer columns than the code under test is not a smaller
 * fixture, it is a different question.
 */
async function previewOf(ids: readonly string[]): Promise<PublishBatchPayload['preview']> {
  const rows = await owner.document.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, totalPence: true, taxPence: true, supplierName: true, categoryCode: true, currency: true },
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

describe.skipIf(!enabled)('publish.batch against a real database', () => {
  test('a Ready document is released for export: SUCCEEDED with no external ref, and it STAYS Published', async () => {
    await seedDocument('s10_doc_ok');
    const payload: PublishBatchPayload = { documentIds: ['s10_doc_ok'], preview: await previewOf(['s10_doc_ok']) };

    const result = await scopedDb(app, STAFF_A, (db) => executor.execute(db, input('s10_prop_ok', payload)));

    expect(result.alreadyApplied).toBe(false);
    // No follow-up: there is no vendor to wait for, so the whole effect commits
    // atomically with the approval.
    expect(result.followUps).toEqual([]);
    expect(result.detail).toMatchObject({ released: 1, releasedForExport: true, exportDestinationKind: 'VT' });

    const released = await owner.publish.findFirst({ where: { actionProposalId: 's10_prop_ok' } });
    expect(released?.state).toBe('SUCCEEDED');
    expect(released?.idempotencyKey).toBe('s10_prop_ok:s10_doc_ok');
    expect(released?.mode).toBe('MANUAL');
    expect(released?.integrationId).toBe(INT);
    // D44's evidence: who released it is on the row, gate or no gate.
    expect(released?.publishedByUserId).toBe('s10_user_a');
    expect(released?.completedAt).not.toBeNull();
    // Nothing was reached and nothing travelled, so there is nothing to record.
    expect(released?.externalRef).toBeNull();
    expect(released?.attachmentSent).toBe(false);
    expect(released?.failureCode).toBeNull();

    const document = await owner.document.findUnique({ where: { id: 's10_doc_ok' } });
    expect(document?.state).toBe('PUBLISHED');
    // ⚠ NOT archived. `POST /v1/exports` exports only PUBLISHED documents; an
    // auto-archive here would make "nothing to export" the permanent answer.
    expect(document?.archivedAt).toBeNull();

    // The audit line a human reads, in D42's own words.
    const event = await owner.documentEvent.findFirst({
      where: { documentId: 's10_doc_ok', stage: 'state', outcome: 'PUBLISHED' },
    });
    const detail = event?.detail as Record<string, unknown>;
    expect(detail['via']).toBe('release-for-export');
    expect(detail['releasedForExport']).toBe(true);
    expect(detail['exportDestinationKind']).toBe('VT');
  });

  test('the released document is what the export will find: PUBLISHED, under RLS', async () => {
    const visible = await scopedDb(app, STAFF_A, (db) =>
      db.document.findMany({ where: { businessId: BIZ, state: 'PUBLISHED' }, select: { id: true } }),
    );
    expect(visible.map((row) => row.id)).toContain('s10_doc_ok');
  });

  test('a replay of the same proposal is alreadyApplied — no second row, no second release', async () => {
    const payload: PublishBatchPayload = { documentIds: ['s10_doc_ok'], preview: { itemCount: 1, grossPence: 97_620, vatPence: 16_270 } };
    const replay = await scopedDb(app, STAFF_A, (db) => executor.execute(db, input('s10_prop_ok', payload)));
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.followUps).toEqual([]);
    expect(await owner.publish.count({ where: { actionProposalId: 's10_prop_ok' } })).toBe(1);
  });

  test('D42 + D47: a client with NO integration row releases, and the row records no destination', async () => {
    // The refusal this replaces — "this client has no active ledger connection
    // — connect one before publishing" — is why nothing could ever reach
    // Published: there is no OAuth flow, no endpoint, and intake asks for no
    // connections.
    await seedDocument('s10_doc_bare', { businessId: BIZ_BARE });
    const payload: PublishBatchPayload = { documentIds: ['s10_doc_bare'], preview: await previewOf(['s10_doc_bare']) };

    const result = await scopedDb(app, STAFF_A, (db) => executor.execute(db, input('s10_prop_bare', payload)));
    expect(result.detail).not.toHaveProperty('exportDestinationId');

    const row = await owner.publish.findFirst({ where: { actionProposalId: 's10_prop_bare' } });
    expect(row?.state).toBe('SUCCEEDED');
    // Null, not invented — the schema makes `publishes.integration_id` nullable.
    expect(row?.integrationId).toBeNull();
    expect((await owner.document.findUnique({ where: { id: 's10_doc_bare' } }))?.state).toBe('PUBLISHED');
  });

  test('a dormant seeded ledger-vendor row is never adopted as an export destination', async () => {
    await seedDocument('s10_doc_legacy', { businessId: BIZ_LEGACY });
    const payload: PublishBatchPayload = { documentIds: ['s10_doc_legacy'], preview: await previewOf(['s10_doc_legacy']) };

    await scopedDb(app, STAFF_A, (db) => executor.execute(db, input('s10_prop_legacy', payload)));

    const row = await owner.publish.findFirst({ where: { actionProposalId: 's10_prop_legacy' } });
    expect(row?.state).toBe('SUCCEEDED');
    // The XERO row is right there and active. Stamping it on a release would
    // put a vendor's name on an act that never touched a vendor.
    expect(row?.integrationId).toBeNull();
  });

  test('naming a ledger-vendor connection refuses, in words that do not claim anything was posted', async () => {
    await seedDocument('s10_doc_named', { businessId: BIZ_LEGACY });
    const payload: PublishBatchPayload = {
      documentIds: ['s10_doc_named'],
      integrationId: INT_LEGACY,
      preview: await previewOf(['s10_doc_named']),
    };

    const error = await scopedDb(app, STAFF_A, (db) => executor.execute(db, input('s10_prop_named', payload)))
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProposalExecutionRefused);
    expect((error as Error).message).toContain('does not write to accounting software');
    expect(await owner.publish.count({ where: { actionProposalId: 's10_prop_named' } })).toBe(0);
    expect((await owner.document.findUnique({ where: { id: 's10_doc_named' } }))?.state).toBe('READY');
  });

  test('a retry over a failed attempt re-arms REJECTED → PROCESSING → READY and releases; the failed attempt is untouched', async () => {
    // A document left REJECTED by a failed publish attempt — today only the
    // dormant ledger lane produces one, and the re-arm edge has to keep
    // working for it. Seeded directly rather than manufactured, because
    // releasing for export cannot fail.
    await seedDocument('s10_doc_retry', {
      state: 'REJECTED',
      failureCode: LEDGER_REJECTED,
      failureMessage: 'the supplier contact was locked by another update',
    });
    await owner.publish.create({
      data: {
        id: 's10_pub_failed',
        businessId: BIZ,
        documentId: 's10_doc_retry',
        integrationId: INT,
        mode: 'MANUAL',
        state: 'FAILED',
        idempotencyKey: 's10_prop_earlier:s10_doc_retry',
        failureCode: LEDGER_REJECTED,
        failureMessage: 'the supplier contact was locked by another update',
        completedAt: new Date('2026-08-02T00:00:00.000Z'),
      },
    });

    const payload: PublishBatchPayload = { documentIds: ['s10_doc_retry'], preview: await previewOf(['s10_doc_retry']) };
    await scopedDb(app, STAFF_A, (db) => executor.execute(db, input('s10_prop_retry', payload)));

    const attempts = await owner.publish.findMany({ where: { documentId: 's10_doc_retry' }, orderBy: { createdAt: 'asc' } });
    expect(attempts).toHaveLength(2);
    // "The old attempt is never replayed and never deleted" — the contract.
    expect(attempts[0]?.state).toBe('FAILED');
    expect(attempts[0]?.failureCode).toBe(LEDGER_REJECTED);
    expect(attempts[1]?.state).toBe('SUCCEEDED');
    expect(attempts[1]?.idempotencyKey).toBe('s10_prop_retry:s10_doc_retry');

    const document = await owner.document.findUnique({ where: { id: 's10_doc_retry' } });
    expect(document?.state).toBe('PUBLISHED');
    // The reason cleared on the way through PROCESSING: a released document
    // must not still carry why its last attempt failed.
    expect(document?.failureCode).toBeNull();
    expect(document?.failureMessage).toBeNull();
    const outcomes = await owner.documentEvent.findMany({
      where: { documentId: 's10_doc_retry', stage: 'state' },
      orderBy: { createdAt: 'asc' },
      select: { outcome: true },
    });
    expect(outcomes.map((row) => row.outcome)).toEqual(['PROCESSING', 'READY', 'PUBLISHED']);
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
    // All-or-nothing: the healthy sibling was not released either.
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

  test('an already-released document refuses a second batch — it must not land in two export files', async () => {
    await expect(
      scopedDb(app, STAFF_A, (db) =>
        executor.execute(
          db,
          input('s10_prop_again', { documentIds: ['s10_doc_ok'], preview: { itemCount: 1, grossPence: 97_620, vatPence: 16_270 } }),
        ),
      ),
    ).rejects.toThrow('cannot be released');
  });

  test("another practice's staff cannot release this practice's document, and is not told why", async () => {
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

  test('the FULL flow: create → review → approve releases the document through the real engine', async () => {
    await seedDocument('s10_doc_flow', { supplierName: 'Adobe Systems', totalPence: 6_199, taxPence: 1_033 });
    // ⚠ Composed the way `approvals.module.ts` composes it, entry preview
    // included — see the assertions after the review for what that buys.
    const service = new ActionProposalsService(
      app,
      buildExecutorRegistry({ publishing: PUBLISHING, exportEntryPreview: ENTRY_PREVIEW }),
      { detect: async () => ({ findings: [], candidatesTruncated: false }) },
      PUBLISHING,
      new InMemoryIdempotencyStore(),
    TEST_CHASE_COMPOSE,
      ENTRY_PREVIEW,
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

    // What Read review renders is the server-computed preview, in pounds — and
    // it is a RELEASE FOR EXPORT, not a publish to anything (D42).
    const review = await service.review(STAFF_A, created.id, 's10-key-review');
    expect(review.renderedSummary.title).toContain('Release 1 document for export');
    expect(review.renderedSummary.title).toContain('61.99');

    /**
     * ⚠ **The bookkeeping entry, end to end, through a real database.**
     *
     * *"Before publishing show the accountant the actual accounting entry that
     * will be put into the VT software."* The unit tests prove the emitter and
     * the render; only this proves the whole path — the entry computed at
     * creation, stored in `jsonb`, re-parsed at review against the contract's
     * `.strict()` member schema, and rendered.
     *
     * That re-parse is the step worth having a test on: `preview` briefly grew
     * a field the contract did not have, and **every publish review answered
     * `NT-PRP-006` "the stored payload no longer parses"** — a failure that
     * surfaced nowhere near the field that caused it.
     */
    const sections = review.renderedSummary.sections as { heading: string; entries: { label: string; value: string }[] }[];
    const entry = sections.find((section) => section.heading.startsWith('Entry 1'));
    expect(entry?.heading).toBe('Entry 1 — Adobe Systems');

    const cells = new Map(entry?.entries.map((item) => [item.label, item.value]));
    // The document is 61.99 gross / 10.33 VAT, so the file carries 51.66 net.
    // These are the emitter's own strings — the review is showing the file.
    expect(cells.get('Gross amount')).toBe('61.99');
    expect(cells.get('Input VAT')).toBe('10.33');
    expect(cells.get('Net amount')).toBe('51.66');
    expect(cells.get("Bank account name/supplier's name")).toBe('Adobe Systems');
    // Dated 2026-08-01 and a purchase, so it lands in that day's purchase file.
    expect(cells.get('Lands in')).toContain('2026-08-01-purchase-invoices.csv');

    // ⚠ And it is the SAME thing the export writes. Not a similar thing: the
    // rows are compared against what the real emitter produces for the real
    // canonical row, so a change to either side fails here.
    const exportable = await owner.document.findUnique({
      where: { id: 's10_doc_flow' },
      select: {
        id: true, businessId: true, inbox: true, docType: true, supplierName: true,
        customerName: true, documentDate: true, totalPence: true, taxPence: true,
        reference: true, categoryCode: true,
      },
    });
    const emitted = previewExportEntries('VT_TRANSACTION_PLUS', [exportable as never]);
    const stored = (review.renderedSummary as unknown as { entryPreview?: unknown }).entryPreview;
    expect(stored).toBeUndefined(); // it lives on the PAYLOAD, not the render
    const payload = (await owner.actionProposal.findUnique({ where: { id: created.id } }))?.payload as {
      entryPreview: { documents: { rows: string[][] }[] };
    };
    expect(payload.entryPreview.documents[0]?.rows).toEqual(emitted.documents[0]?.rows.map((row) => [...row]));

    // ⚠ D44 / stage A12: today ANY authenticated member of the practice reaches
    // this line. `assertCan(actor, 'publish.release', …)` belongs on the
    // engine's approve path, and A12 has not merged.
    const executed = await service.approve(
      STAFF_A,
      created.id,
      { renderedSummaryHash: review.renderedSummaryHash },
      's10-key-approve',
    );
    expect(executed.state).toBe('EXECUTED');
    expect(executed.outcome).toMatchObject({ alreadyApplied: false, detail: { releasedForExport: true, released: 1 } });

    const row = await owner.publish.findFirst({ where: { actionProposalId: created.id } });
    expect(row?.state).toBe('SUCCEEDED');
    expect(row?.externalRef).toBeNull();
    expect(row?.actionProposalId).toBe(created.id);
    const document = await owner.document.findUnique({ where: { id: 's10_doc_flow' } });
    expect(document?.state).toBe('PUBLISHED');
    expect(document?.archivedAt).toBeNull();
  });

  test('create computes the preview SERVER-side — a caller-sent preview is discarded, never stored', async () => {
    await seedDocument('s10_doc_svr', { supplierName: 'Adobe Systems', totalPence: 6_199, taxPence: 1_033 });
    const service = new ActionProposalsService(
      app,
      buildExecutorRegistry({ publishing: PUBLISHING }),
      { detect: async () => ({ findings: [], candidatesTruncated: false }) },
      PUBLISHING,
      new InMemoryIdempotencyStore(),
    TEST_CHASE_COMPOSE,
    );

    // A payload that lies about the figures. If create stored it verbatim, a
    // human would review 0.01 gross over 9 items — the contract's preview
    // promise exists to make this impossible.
    const created = await service.create(
      STAFF_A,
      {
        kind: 'publish.batch',
        businessId: BIZ,
        payload: { documentIds: ['s10_doc_svr'], preview: { itemCount: 9, grossPence: 1, vatPence: 0 } },
      },
      's10-key-svr-create',
    );

    const stored = await owner.actionProposal.findUnique({ where: { id: created.id } });
    const storedPreview = (stored?.payload as { preview: PublishBatchPayload['preview'] }).preview;
    expect(storedPreview).toEqual(await previewOf(['s10_doc_svr']));
    expect(storedPreview.grossPence).toBe(6_199);

    // And what Read review renders is those server figures, in pounds.
    const review = await service.review(STAFF_A, created.id, 's10-key-svr-review');
    expect(review.renderedSummary.title).toContain('61.99');
  });

  test('an item short of the minimum refuses at CREATION with NT-PUB-001 — no proposal row is stored', async () => {
    await seedDocument('s10_doc_nocat_create', { categoryCode: null });
    const service = new ActionProposalsService(
      app,
      buildExecutorRegistry({ publishing: PUBLISHING }),
      { detect: async () => ({ findings: [], candidatesTruncated: false }) },
      PUBLISHING,
      new InMemoryIdempotencyStore(),
    TEST_CHASE_COMPOSE,
    );

    const error = await service
      .create(
        STAFF_A,
        {
          kind: 'publish.batch',
          businessId: BIZ,
          payload: { documentIds: ['s10_doc_nocat_create'], preview: { itemCount: 1, grossPence: 97_620, vatPence: 16_270 } },
        },
        's10-key-nocat-create',
      )
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).code).toBe('NT-PUB-001');
    expect((error as AppException).publicDetail).toContain('s10_doc_nocat_create');
    expect((error as AppException).publicDetail).toContain('category');

    const rows = await owner.actionProposal.findMany({ where: { kind: 'publish.batch', businessId: BIZ } });
    expect(rows.some((row) => JSON.stringify(row.payload).includes('s10_doc_nocat_create'))).toBe(false);
  });
});
