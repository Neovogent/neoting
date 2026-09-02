import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';

// chase.send composition config for tests — a real secret so signed links verify.
const TEST_CHASE_COMPOSE = { portalLinkSecret: 'test-portal-link-secret', appOrigin: 'https://app.test' };
import { ActionProposalsService } from '../approvals/action-proposals.service.js';
import { loadCategories } from '../chat-framework/grounding.js';
import type { PublishGateway } from '../validation-dedupe/proposals/publish-batch.js';
import { buildExecutorRegistry } from '../validation-dedupe/proposals/registry.js';
import { ChartOfAccountsService } from './chart-of-accounts/chart-of-accounts.service.js';
import { SupplierCodingService } from './coding/supplier-coding.service.js';

/**
 * **A6's acceptance, against a real database as `nt_app`.**
 *
 * The whole loop, with every state change going through the REAL Review →
 * Approve engine — no fixture stands in for the thing being proven:
 *
 * 1. A client is seeded a chart of accounts, and it is written where
 *    `chat-framework` already looks for one.
 * 2. Invoice 1 from Nisbets is coded by hand — an approved
 *    `document.update-coding` — and the coding ladder reads that back as the
 *    client's own prior decision.
 * 3. That becomes a `rule.create` proposal whose scope key is the supplier's
 *    exact spelling, approved through the same engine.
 * 4. **The rule then outranks a conflicting history**, and **the human's
 *    correction outranks the rule.** Those two are A6's absolute constraint and
 *    they are asserted against real rows rather than against a fake.
 * 5. Another practice sees none of it.
 *
 * Id namespace: **`a6_`**, disjoint from every other suite. Teardown is by
 * explicit id list — never `startsWith`, because Prisma's LIKE leaves `_` a
 * wildcard (the p4/p40 collision recorded in
 * `extraction-pipeline.integration.test.ts`).
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P = 'a6_prac';
const P_OTHER = 'a6_prac_other';
const BIZ = 'a6_biz';
const INTEGRATION = 'a6_int';
const USER = 'a6_user';
const USER_OTHER = 'a6_user_other';
const MEM = 'a6_mem';
const MEM_OTHER = 'a6_mem_other';
const DOC_1 = 'a6_doc_one';
const DOC_2 = 'a6_doc_two';

const SUPPLIER = 'Nisbets Ltd';
const CONSUMABLES = 'COS_MATERIALS_AND_CONSUMABLES';
const PURCHASES = 'COS_PURCHASES';

const STAFF = ScopeContextSchema.parse({ actorId: USER, practiceId: P });
const OTHER_STAFF = ScopeContextSchema.parse({ actorId: USER_OTHER, practiceId: P_OTHER });

const CLEANING_AGENCY = {
  businessActivity: 'Commercial cleaning for offices and schools',
  typicalSuppliers: ['Nisbets'],
  typicalCosts: ['Cleaning materials'],
  hasEmployees: true,
};

let owner: PrismaClient;
let app: PrismaClient;

/** Neither publish nor SMS is in frame; the stubs satisfy the registry's required deps and nothing more. */
const STUB_PUBLISHING: PublishGateway = {
  ledger: { publishBill: async () => ({ ok: true, externalRef: 'STUB', attachmentSent: false }) },
  previewPublishBatch: () => ({ ok: true, preview: { itemCount: 0, grossPence: 0, vatPence: 0, currency: null } }),
};

function proposals(): ActionProposalsService {
  return new ActionProposalsService(
    app,
    buildExecutorRegistry({ publishing: STUB_PUBLISHING }),
    { detect: async () => ({ findings: [], candidatesTruncated: false }) },
    STUB_PUBLISHING,
    new InMemoryIdempotencyStore(),
    TEST_CHASE_COMPOSE,
  );
}

function charts(): ChartOfAccountsService {
  return new ChartOfAccountsService(app);
}

function coding(): SupplierCodingService {
  return new SupplierCodingService(app, charts());
}

/** Create → review → approve, through the real engine. Approve is unreachable without the review. */
async function approve(kind: 'document.update-coding' | 'rule.create', payload: unknown, key: string): Promise<void> {
  const service = proposals();
  const created = await service.create(STAFF, { kind, businessId: BIZ, payload } as never, `${key}-create`);
  // Approve is server-gated on the review having been opened, and the echoed
  // hash is what the reviewer actually saw.
  const review = await service.review(STAFF, created.id, `${key}-review`);
  await service.approve(STAFF, created.id, { renderedSummaryHash: review.renderedSummaryHash }, `${key}-approve`);
}

async function seedDocument(id: string, categoryCode: string | null): Promise<void> {
  await owner.document.create({
    data: {
      id,
      practiceId: P,
      businessId: BIZ,
      s3Key: `a6/${id}`,
      originalFilename: `${id}.pdf`,
      mimeType: 'application/pdf',
      byteSize: 1024,
      byteHash: `a6hash_${id}`,
      channel: 'WEB_UPLOAD',
      inbox: 'COSTS',
      state: 'TO_REVIEW',
      docType: 'INVOICE',
      supplierName: SUPPLIER,
      currency: 'GBP',
      totalPence: 12_000,
      taxPence: 2_000,
      categoryCode,
    },
  });
}

async function cleanup(): Promise<void> {
  await owner.$executeRawUnsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
  await owner.auditEvent.deleteMany({ where: { businessId: BIZ } });
  await owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
  await owner.actionProposal.deleteMany({ where: { OR: [{ practiceId: P }, { businessId: BIZ }] } });
  await owner.document.deleteMany({ where: { id: { in: [DOC_1, DOC_2] } } });
  await owner.rule.deleteMany({ where: { businessId: BIZ } });
  await owner.referenceSync.deleteMany({ where: { integrationId: INTEGRATION } });
  await owner.integration.deleteMany({ where: { id: INTEGRATION } });
  await owner.membership.deleteMany({ where: { id: { in: [MEM, MEM_OTHER] } } });
  await owner.user.deleteMany({ where: { id: { in: [USER, USER_OTHER] } } });
  await owner.business.deleteMany({ where: { id: BIZ } });
  await owner.practice.deleteMany({ where: { id: { in: [P, P_OTHER] } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.createMany({ data: [{ id: P, name: 'Mercer & Co' }, { id: P_OTHER, name: 'Other Firm' }] });
  await owner.business.create({
    data: { id: BIZ, practiceId: P, name: 'Sparkle Cleaning Ltd', contextQuestionnaire: CLEANING_AGENCY },
  });
  // A11's intake creates exactly one active VT integration per client; the
  // chart hangs off it, and `reference_syncs`' RLS policy reads through it.
  await owner.integration.create({ data: { id: INTEGRATION, businessId: BIZ, kind: 'VT', isActive: true } });
  await owner.user.createMany({
    data: [
      { id: USER, email: 'a6@example.test' },
      { id: USER_OTHER, email: 'a6other@example.test' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: MEM, userId: USER, practiceId: P, role: 'PRACTICE_ADMIN', isOwner: true },
      { id: MEM_OTHER, userId: USER_OTHER, practiceId: P_OTHER, role: 'PRACTICE_ADMIN' },
    ],
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('the chart of accounts, under RLS', () => {
  test('seeds once, and the write is admitted by reference_syncs’ own policy', async () => {
    const first = await charts().getChartOfAccounts(STAFF, BIZ);
    expect(first.source).toBe('SEEDED');
    expect(first.profileId).toBe('SERVICES_WITH_STAFF');

    // Read back as the OWNER: the assertion is about what landed, and reading
    // it through the same policies that wrote it could hide a row that did not.
    const rows = await owner.referenceSync.findMany({ where: { integrationId: INTEGRATION } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.listKind).toBe('chart_of_accounts');

    const second = await charts().getChartOfAccounts(STAFF, BIZ);
    expect(second.source).toBe('STORED');
    expect(await owner.referenceSync.count({ where: { integrationId: INTEGRATION } })).toBe(1);
  });

  /**
   * ⚠ This is the whole reason the chart lives in `reference_syncs` rather than
   * in a new table: `chat-framework/grounding.ts` already queries that shape,
   * and until something wrote the row every accountant got *"this client has no
   * synced chart of accounts yet, so a coding rule has nothing to code
   * against."*
   */
  test('is visible to the query chat-framework already makes, in the emittable form', async () => {
    await charts().getChartOfAccounts(STAFF, BIZ);

    // Through `scopedDb` and the real `loadCategories`, so this is the call
    // chat actually makes, under the policies it actually runs under.
    const categories = await scopedDb(app, STAFF, (db) => loadCategories(db, BIZ));

    expect(categories.length).toBeGreaterThan(20);
    // Ledger-prefixed — the exact string A7's VT emitter writes into
    // `Analysis account`.
    expect(categories.map((c) => c.name)).toContain('Cost of sales: Materials and consumables');
    expect(categories.find((c) => c.code === PURCHASES)?.name).toBe('Cost of sales: Purchases');
  });

  test('another practice sees neither the client nor its chart', async () => {
    await charts().getChartOfAccounts(STAFF, BIZ);
    await expect(charts().getChartOfAccounts(OTHER_STAFF, BIZ)).rejects.toMatchObject({ code: 'NT-VAL-001' });
  });
});

describe.skipIf(!enabled)('the loop that makes the second invoice code itself', () => {
  test('hand-coded once → learned history → a rule proposal keyed on the exact spelling', async () => {
    await seedDocument(DOC_1, null);

    // Nothing to go on yet.
    const before = await coding().resolveForSupplier(STAFF, BIZ, SUPPLIER);
    expect(before.decision.outcome).toBe('REVIEW');

    // The accountant codes it by hand, through the real engine.
    await approve('document.update-coding', { documentId: DOC_1, fields: { categoryCode: CONSUMABLES } }, 'a6-code-1');

    const after = await coding().resolveForSupplier(STAFF, BIZ, SUPPLIER);
    expect(after.decision.outcome).toBe('CODE');
    if (after.decision.outcome !== 'CODE') return;
    expect(after.decision.authority).toBe('LEARNED_HISTORY');
    expect(after.decision.categoryCode).toBe(CONSUMABLES);
    expect(after.decision.analysisAccount).toBe('Cost of sales: Materials and consumables');

    const proposal = await coding().proposeSupplierRule(STAFF, BIZ, SUPPLIER);
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    // The pipeline matches `scopeKey` against `supplierName` EXACTLY. Anything
    // else is a rule that is approved and then never fires.
    expect(proposal.payload.scopeKey).toBe(SUPPLIER);
    expect(proposal.payload.sets.categoryCode).toBe(CONSUMABLES);

    // Approve it, and the rule the extraction pipeline looks for now exists.
    await approve('rule.create', proposal.payload, 'a6-rule-1');
    const rules = await owner.rule.findMany({ where: { businessId: BIZ } });
    expect(rules).toHaveLength(1);
    expect(rules[0]?.tier).toBe('SUPPLIER_CUSTOMER');
    expect(rules[0]?.scopeKey).toBe(SUPPLIER);
    expect(rules[0]?.isActive).toBe(true);
    // No rule exists without the proposal that activated it.
    expect(rules[0]?.actionProposalId).not.toBeNull();
  });

  /**
   * ⚠ **A6's absolute constraint, half one.** An accountant writes an explicit
   * rule that disagrees with everything the client's own history says. The rule
   * wins, and it is not close — history is never even a competitor.
   */
  test('an explicit accountant rule beats a conflicting learned history', async () => {
    await approve(
      'rule.create',
      { tier: 'USER', scopeKey: SUPPLIER, sets: { categoryCode: PURCHASES } },
      'a6-rule-user',
    );

    const result = await coding().resolveForSupplier(STAFF, BIZ, SUPPLIER);
    expect(result.decision.outcome).toBe('CODE');
    if (result.decision.outcome !== 'CODE') return;
    expect(result.decision.authority).toBe('ACCOUNTANT_RULE');
    expect(result.decision.categoryCode).toBe(PURCHASES);
    expect(result.decision.analysisAccount).toBe('Cost of sales: Purchases');
    // The history is still there and still disagrees — it simply does not win.
    expect(result.history.categoryCodes).toEqual([CONSUMABLES]);
  });

  /**
   * ⚠ **A6's absolute constraint, half two — and the one that matters most.**
   * The document a person corrected is now contradicted by an approved rule.
   * It is not recoded, not suggested away, not "updated to match the rule".
   * The lock is checked before the ladder runs at all.
   */
  test('nothing overrides a human’s correction — not even the rule that now disagrees', async () => {
    const result = await coding().resolveForDocument(STAFF, DOC_1);

    expect(result.decision.outcome).toBe('LOCKED');
    if (result.decision.outcome !== 'LOCKED') return;
    expect(result.decision.lock).toBe('HUMAN_CORRECTION');
    // What it is coded to, for display — never something to re-apply.
    expect(result.decision.categoryCode).toBe(CONSUMABLES);
    expect(result.decision.reason).toContain('Nothing here overrides that');

    // And nothing in this module wrote to the document to make that true.
    const row = await owner.document.findUnique({ where: { id: DOC_1 }, select: { categoryCode: true } });
    expect(row?.categoryCode).toBe(CONSUMABLES);

    // A rule already codes this supplier, so there is no second rule to propose.
    const proposal = await coding().proposeRuleFromDocument(STAFF, DOC_1);
    expect(proposal.ok).toBe(false);
  });

  test('a fresh document from the same supplier gets the rule’s answer, not the human-locked one', async () => {
    await seedDocument(DOC_2, null);

    const result = await coding().resolveForDocument(STAFF, DOC_2);
    expect(result.decision.outcome).toBe('CODE');
    if (result.decision.outcome !== 'CODE') return;
    expect(result.decision.authority).toBe('ACCOUNTANT_RULE');
    expect(result.decision.categoryCode).toBe(PURCHASES);
  });

  test('another practice cannot resolve this client’s documents', async () => {
    await expect(coding().resolveForDocument(OTHER_STAFF, DOC_2)).rejects.toMatchObject({ code: 'NT-VAL-001' });
  });
});
