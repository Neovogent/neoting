import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../../common/idempotency/idempotency-store.js';
import { AppException } from '../../../common/problem/problem.js';
import { ActionProposalsService } from '../../approvals/action-proposals.service.js';
import { DemoExtractor } from '../../extraction/demo-extractor.js';
import { PrismaExtractionStep } from '../../extraction/extraction-pipeline.js';
import type { PublishGateway } from './publish-batch.js';
import { buildExecutorRegistry } from './registry.js';

/**
 * The METH Stage 13 rule beat, end to end through the REAL Review → Approve
 * engine against a real database as `nt_app`:
 *
 *   "Whenever Bidfood invoices arrive for American Burger, code them Cost of
 *   Sales Food" → a `rule.create` proposal → review renders the rule's fields,
 *   tier and scope → approve → the `rules` row exists, active, stamped with
 *   the proposal — and the NEXT Bidfood document through the extraction
 *   pipeline arrives pre-coded with the rule's id as its provenance.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P = 'p13_prac';
const BIZ = 'p13_biz';

let owner: PrismaClient;
let app: PrismaClient;

const STAFF = ScopeContextSchema.parse({ actorId: 'p13_user', practiceId: P });

// Neither publish nor SMS is in frame: the stubs satisfy the registry's
// required deps and nothing more (their real suites exercise them).
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
  await owner.auditEvent.deleteMany({ where: { businessId: BIZ } });
  await owner.$executeRawUnsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
  await owner.actionProposal.deleteMany({ where: { OR: [{ practiceId: P }, { businessId: BIZ }] } });
  await owner.document.deleteMany({ where: { practiceId: P } });
  await owner.rule.deleteMany({ where: { businessId: BIZ } });
  // Explicit ids, not `startsWith` — Prisma's LIKE leaves `_` a wildcard (the
  // p4/p40 collision recorded in extraction-pipeline.integration.test.ts).
  await owner.membership.deleteMany({ where: { id: { in: ['p13_mem', 'p13_mem_sys'] } } });
  await owner.user.deleteMany({ where: { id: { in: ['p13_user', 'p13_sys'] } } });
  await owner.business.deleteMany({ where: { id: BIZ } });
  await owner.practice.deleteMany({ where: { id: P } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.create({ data: { id: P, name: 'P13' } });
  await owner.business.create({ data: { id: BIZ, practiceId: P, name: 'American Burger Ltd' } });
  await owner.user.create({ data: { id: 'p13_user', email: 'p13@example.test' } });
  await owner.membership.create({ data: { id: 'p13_mem', userId: 'p13_user', practiceId: P, role: 'PRACTICE_ADMIN' } });
  // The extraction pipeline runs as the practice SYSTEM actor (the p4 suite's
  // arrangement) — the rule beat's second half needs one.
  await owner.user.create({ data: { id: 'p13_sys', kind: 'SYSTEM' } });
  await owner.membership.create({ data: { id: 'p13_mem_sys', userId: 'p13_sys', practiceId: P, role: 'PRACTICE_STANDARD' } });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('rule.create end to end through the engine', () => {
  test('create → review (fields, tier, scope) → approve → active rule stamped with the proposal', async () => {
    const svc = service();
    const created = await svc.create(
      STAFF,
      {
        kind: 'rule.create',
        businessId: BIZ,
        payload: {
          tier: 'SUPPLIER_CUSTOMER',
          scopeKey: 'Bidfood',
          conditions: null,
          sets: { categoryCode: 'COST_OF_SALES_FOOD', vatTreatment: 'standard' },
        },
      },
      'p13-key-create',
    );
    expect(created.state).toBe('CREATED');

    // The review names the rule's scope, tier and every field it sets — a
    // reviewer sees what will start coding the client's documents, not JSON.
    const review = await svc.review(STAFF, created.id, 'p13-key-review');
    const summary = review.renderedSummary as {
      title: string;
      sections: { heading: string; entries: { label: string; value: string }[] }[];
    };
    expect(summary.title).toContain('Bidfood');
    const ruleSection = summary.sections.find((s) => s.heading === 'Rule that will be created');
    expect(ruleSection?.entries).toContainEqual({ label: 'Matches', value: 'Bidfood' });
    expect(ruleSection?.entries).toContainEqual({ label: 'Tier', value: 'SUPPLIER_CUSTOMER' });
    const setsSection = summary.sections.find((s) => s.heading === 'Fields this rule sets');
    expect(setsSection?.entries).toContainEqual({ label: 'categoryCode', value: 'COST_OF_SALES_FOOD' });

    const executed = await svc.approve(STAFF, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'p13-key-approve');
    expect(executed.state).toBe('EXECUTED');
    expect(executed.outcome).toMatchObject({ alreadyApplied: false });

    const rule = await owner.rule.findFirst({ where: { businessId: BIZ, actionProposalId: created.id } });
    expect(rule?.isActive).toBe(true);
    expect(rule?.tier).toBe('SUPPLIER_CUSTOMER');
    expect(rule?.scopeKey).toBe('Bidfood');
    expect(rule?.sets).toEqual({ categoryCode: 'COST_OF_SALES_FOOD', vatTreatment: 'standard' });
    expect(rule?.createdVia).toBe('chat');
    expect(rule?.createdByUserId).toBe('p13_user');
  });

  test('the next Bidfood document arrives pre-coded with the rule as its provenance — the wow beat', async () => {
    const documentId = 'p13_bidfood';
    await owner.document.create({
      data: {
        id: documentId,
        practiceId: P,
        businessId: BIZ,
        s3Key: `w/${BIZ}/documents/${'b'.repeat(64)}`,
        byteHash: 'b'.repeat(64),
        mimeType: 'application/pdf',
        byteSize: 11,
        channel: 'WHATSAPP',
        originalFilename: 'bidfood-invoice.pdf',
        inbox: 'COSTS',
        state: 'RECEIVED',
      },
    });

    // No-op sleep — the 2–4 s demo latency must not slow the suite.
    const step = new PrismaExtractionStep(app, new DemoExtractor(), { sleep: async () => {} });
    await step.run({ documentId, practiceId: P, businessId: BIZ, traceId: 'trace-p13', finalAttempt: false });

    const row = await owner.document.findUnique({ where: { id: documentId } });
    // The chat-created rule beat the profile's default (GENERAL_EXPENSES).
    expect(row?.categoryCode).toBe('COST_OF_SALES_FOOD');
    const rule = await owner.rule.findFirst({ where: { businessId: BIZ, scopeKey: 'Bidfood' } });
    const suggestion = await owner.suggestion.findFirst({ where: { documentId, field: 'categoryCode' } });
    expect(suggestion?.sourceRuleId).toBe(rule?.id);
  });

  test('a practice-level proposal (no business) refuses at approve — a rule needs a workspace', async () => {
    const svc = service();
    const created = await svc.create(
      STAFF,
      {
        kind: 'rule.create',
        businessId: null,
        payload: { tier: 'ACCOUNT_DEFAULT', scopeKey: null, conditions: null, sets: { vatTreatment: 'exempt' } },
      },
      'p13-key-create-null',
    );
    const review = await svc.review(STAFF, created.id, 'p13-key-review-null');

    let code = 'no-throw';
    try {
      await svc.approve(STAFF, created.id, { renderedSummaryHash: review.renderedSummaryHash }, 'p13-key-approve-null');
    } catch (e) {
      code = e instanceof AppException ? e.code : `unexpected:${String(e)}`;
    }
    expect(code).toBe('NT-PRP-006');
    expect(await owner.rule.count({ where: { actionProposalId: created.id } })).toBe(0);
  });
});
