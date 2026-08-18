import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { DemoExtractor } from './demo-extractor.js';
import { PrismaExtractionStep } from './extraction-pipeline.js';

/**
 * The extraction pipeline proven end to end against a REAL database — the METH
 * Stage 4 acceptance. A seeded RECEIVED document runs through
 * `PrismaExtractionStep` under RLS (as the practice SYSTEM actor), and lands
 * READY / TO_REVIEW / FAILED with its header projection, accepted extraction,
 * coding suggestions and a gapless event log — none of which a unit test can
 * show, because it is all about what the state machine and RLS actually do.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];

let owner: PrismaClient;
let app: PrismaClient;

const P = 'p4_prac';
const B = 'p4_biz';

function step(): PrismaExtractionStep {
  // No-op sleep — the 2–4 s demo latency must not slow the suite.
  return new PrismaExtractionStep(app, new DemoExtractor(), { sleep: async () => {} });
}

async function seedReceived(id: string, opts: { businessId: string | null; byteHash: string; filename: string }): Promise<void> {
  await owner.document.create({
    data: {
      id,
      practiceId: P,
      businessId: opts.businessId,
      s3Key: `w/_unrouted/${P}/documents/${opts.byteHash}`,
      byteHash: opts.byteHash,
      mimeType: 'image/jpeg',
      byteSize: 11,
      channel: 'EMAIL',
      originalFilename: opts.filename,
      inbox: opts.businessId === null ? 'UNROUTED' : 'COSTS',
      state: 'RECEIVED',
    },
  });
}

async function runExtract(id: string, businessId: string | null): Promise<void> {
  // filename + byteHash come off the row now, so the caller only supplies scope.
  await step().run({ documentId: id, practiceId: P, businessId, traceId: `trace-${id}` });
}

async function cleanup(): Promise<void> {
  await owner.document.deleteMany({ where: { practiceId: P } });
  await owner.rule.deleteMany({ where: { businessId: B } });
  // Explicit ids, NOT `startsWith`. Prisma compiles `startsWith: 'p4_'` to
  // `LIKE 'p4_%'` and does not escape the `_`, which is LIKE's single-character
  // wildcard — so this cleanup also matched `p40_sys` and `p40_mem_sys` and
  // deleted `duplicate-detector.integration.test.ts`'s fixtures out from under
  // it. Test files run in parallel workers here, so the two suites interleave
  // and the collision surfaced as an intermittent foreign-key violation in the
  // OTHER file's `beforeAll`, which is the worst place to go looking.
  await owner.business.deleteMany({ where: { id: B } });
  await owner.membership.deleteMany({ where: { id: 'p4_mem_sys' } });
  await owner.user.deleteMany({ where: { id: 'p4_sys' } });
  await owner.practice.deleteMany({ where: { id: P } });
}

beforeAll(async () => {
  if (DATABASE_URL === undefined || OWNER_URL === undefined) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`; // configured-but-unreachable → throw, not skip

  await cleanup();
  await owner.practice.create({ data: { id: P, name: 'P4' } });
  await owner.user.create({ data: { id: 'p4_sys', kind: 'SYSTEM' } });
  await owner.membership.create({ data: { id: 'p4_mem_sys', userId: 'p4_sys', practiceId: P, role: 'PRACTICE_STANDARD' } });
  await owner.business.create({ data: { id: B, practiceId: P, name: 'American Burger Ltd' } });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!DATABASE_URL || !OWNER_URL)('extraction pipeline against a real database', () => {
  test('a confident document lands READY with header, extraction, suggestions and a gapless event log', async () => {
    const id = 'p4_currys';
    await seedReceived(id, { businessId: null, byteHash: 'c'.repeat(64), filename: 'currys-receipt.jpg' });
    await runExtract(id, null);

    const row = await owner.document.findUnique({ where: { id } });
    expect(row?.state).toBe('READY');
    // The denormalised header projection — the readiness trio and more, in pence.
    expect(row?.supplierName).toBe('Currys');
    expect(row?.totalPence).toBe(129_900);
    expect(row?.categoryCode).toBe('OFFICE_EQUIPMENT');
    expect(row?.docType).toBe('RECEIPT');

    const extraction = await owner.extraction.findFirst({ where: { documentId: id } });
    expect(extraction?.isAccepted).toBe(true);
    expect(extraction?.modelVersion).toBe('demo-extractor-1');
    expect(extraction?.extractorKind).toBe('demo');

    const suggestions = await owner.suggestion.findMany({ where: { documentId: id } });
    expect(suggestions.some((s) => s.field === 'categoryCode')).toBe(true);

    // The processing log is EXACTLY this ordered trail — no gaps, no strays. The
    // document was seeded directly (no ingest event), so extraction's three events
    // are the whole log: the PROCESSING state, the extract, then the READY state.
    const events = await owner.documentEvent.findMany({ where: { documentId: id }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.outcome)).toEqual(['PROCESSING', 'extracted', 'READY']);
    expect(events.map((e) => e.stage)).toEqual(['state', 'extract', 'state']);
  });

  test('running the same document twice is idempotent — one accepted extraction, still READY', async () => {
    const id = 'p4_idem';
    await seedReceived(id, { businessId: null, byteHash: 'd'.repeat(64), filename: 'currys.jpg' });
    await runExtract(id, null);
    await runExtract(id, null); // redelivery / retry

    expect(await owner.extraction.count({ where: { documentId: id } })).toBe(1);
    expect((await owner.document.findUnique({ where: { id } }))?.state).toBe('READY');
  });

  test('given a PROCESSING document that already has an accepted extraction, a run finalises without duplicating it', async () => {
    // Defensive idempotency. Write+finalise share a transaction, so this state is
    // not reachable by a crash between them today — but if it ever arose (a future
    // re-extraction flow), the run must NOT write a second extraction: it re-reads
    // the row, sees the accepted extraction, and just drives the state home.
    const id = 'p4_crash';
    await seedReceived(id, { businessId: null, byteHash: '5'.repeat(64), filename: 'currys.jpg' });
    // Simulate the mid-crash state directly: PROCESSING + an accepted extraction +
    // the header the pipeline would have written.
    await owner.document.update({
      where: { id },
      data: { state: 'PROCESSING', supplierName: 'Currys', totalPence: 129_900, categoryCode: 'OFFICE_EQUIPMENT' },
    });
    await owner.extraction.create({
      data: { documentId: id, fields: {}, extractorKind: 'demo', modelVersion: 'demo-extractor-1', isAccepted: true },
    });

    await runExtract(id, null);

    expect(await owner.extraction.count({ where: { documentId: id } })).toBe(1); // no duplicate
    expect((await owner.document.findUnique({ where: { id } }))?.state).toBe('READY');
  });

  test('a failed validator sends the document to TO_REVIEW even with every field present', async () => {
    const id = 'p4_lowconf';
    await seedReceived(id, { businessId: null, byteHash: 'e'.repeat(64), filename: 'lowconf-invoice.pdf' });
    await runExtract(id, null);

    const row = await owner.document.findUnique({ where: { id } });
    expect(row?.state).toBe('TO_REVIEW');
    // All three required fields ARE present, so a missing field cannot be the
    // cause — the failed validator is the only thing that could block READY.
    expect(row?.totalPence).not.toBeNull();
    expect(row?.supplierName).not.toBeNull();
    expect(row?.categoryCode).not.toBeNull();
  });

  test('an unreadable document lands FAILED with a reason it can be retried from', async () => {
    const id = 'p4_fail';
    await seedReceived(id, { businessId: null, byteHash: '9'.repeat(64), filename: 'blurry-photo.jpg' });
    await runExtract(id, null);

    const row = await owner.document.findUnique({ where: { id } });
    expect(row?.state).toBe('FAILED');
    expect(row?.failureCode).toBe('NT-EXT-001');
    expect(row?.failureMessage).toBeTruthy();
    // No accepted extraction is written for a document we could not read.
    expect(await owner.extraction.count({ where: { documentId: id } })).toBe(0);
  });

  test('an active supplier rule overrides the coding, recorded with its rule id', async () => {
    const id = 'p4_ruled';
    await owner.rule.create({
      data: {
        id: 'p4_rule_currys',
        businessId: B,
        tier: 'SUPPLIER_CUSTOMER',
        scopeKey: 'Currys',
        sets: { categoryCode: 'CAPITAL_EQUIPMENT' },
        isActive: true,
      },
    });
    await seedReceived(id, { businessId: B, byteHash: '7'.repeat(64), filename: 'currys-receipt.jpg' });
    await runExtract(id, B);

    const row = await owner.document.findUnique({ where: { id } });
    // The rule beat the profile's default coding.
    expect(row?.categoryCode).toBe('CAPITAL_EQUIPMENT');
    const categorySuggestion = await owner.suggestion.findFirst({ where: { documentId: id, field: 'categoryCode' } });
    expect(categorySuggestion?.sourceRuleId).toBe('p4_rule_currys');
  });
});
