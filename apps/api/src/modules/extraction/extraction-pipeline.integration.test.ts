import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { toExtraction } from '../../common/documents/document-response.js';
import { ChartOfAccountsService, SupplierCodingService } from '../rules-suggestions/index.js';
import { DemoExtractor } from './demo-extractor.js';
import type { DocumentExtractor, ExtractedDocument } from './document-extractor.js';
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

/**
 * An extractor that throws rather than answering — a Bedrock throttle, an
 * expired credential, a 400 on an over-long PDF, a socket reset. Before S5 this
 * was the shape that stranded a document in PROCESSING for ever.
 */
class ThrowingExtractor implements DocumentExtractor {
  readonly kind = 'bedrock';
  readonly modelVersion = 'anthropic.test';
  extract(): Promise<never> {
    return Promise.reject(new Error('bedrock is unreachable'));
  }
}

function throwingStep(): PrismaExtractionStep {
  return new PrismaExtractionStep(app, new ThrowingExtractor(), { sleep: async () => {} });
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
  await step().run({ documentId: id, practiceId: P, businessId, traceId: `trace-${id}`, finalAttempt: false });
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
  // ───────────────────────────────────────────────────────────────────────────
  // S5 · a throw must never strand a document in PROCESSING
  //
  // `run` is the only thing that moves a document out of PROCESSING, so it is
  // the only thing that can promise PROCESSING is never permanent. Before S5 a
  // throw travelled out to BullMQ, the retries ran, the job dead-lettered — and
  // the document stayed PROCESSING for ever: no failure code, nothing on the
  // Rejected/Failed view, and `document.reprocess` REFUSES a processing
  // document, so no Retry button either. A stuck document is worse than a failed
  // one, because a failed one is visible.
  // ───────────────────────────────────────────────────────────────────────────

  test('the simulated Processing delay is fixture-only — a real read is not padded', async () => {
    // The 2-4 s sleep exists so PROCESSING renders truthfully when extraction is
    // instant fixture data. Staging runs `EXTRACTOR=bedrock`, where a real read
    // takes seconds on its own, so leaving it unconditional added 2-4 s of pure
    // latency to every real document. Keyed on the extractor's own `kind`.
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
    };

    const real = 'p4_realtimed';
    await seedReceived(real, { businessId: null, byteHash: 'c1'.repeat(32), filename: 'receipt.jpg' });
    await expect(
      new PrismaExtractionStep(app, new ThrowingExtractor(), { sleep }).run({
        documentId: real,
        practiceId: P,
        businessId: null,
        traceId: 'trace-realtimed',
        finalAttempt: false,
      }),
    ).rejects.toThrow();
    expect(slept).toEqual([]);

    const fixture = 'p4_demotimed';
    await seedReceived(fixture, { businessId: null, byteHash: 'd1'.repeat(32), filename: 'currys-receipt.jpg' });
    await new PrismaExtractionStep(app, new DemoExtractor(), { sleep }).run({
      documentId: fixture,
      practiceId: P,
      businessId: null,
      traceId: 'trace-demotimed',
      finalAttempt: false,
    });
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThanOrEqual(2000);
  });

  test('a throw with retries left leaves the document PROCESSING for the next attempt', async () => {
    const id = 'p4_throttled';
    await seedReceived(id, { businessId: null, byteHash: 'a1'.repeat(32), filename: 'receipt.jpg' });

    await expect(
      throwingStep().run({ documentId: id, practiceId: P, businessId: null, traceId: 'trace-throttled', finalAttempt: false }),
    ).rejects.toThrow('bedrock is unreachable');

    // Deliberately still PROCESSING: the retry ladder is the right tool for a
    // throttle, and `begin()` is re-entrant on PROCESSING so the next attempt
    // resumes cleanly. Burning it to FAILED here would be worse than it sounds —
    // `document.reprocess` re-arms a document WITHOUT re-reading the bytes, so a
    // transient failure converted to FAILED never gets a second real read.
    const row = await owner.document.findUnique({ where: { id } });
    expect(row?.state).toBe('PROCESSING');
    expect(row?.failureCode).toBeNull();
  });

  test('a throw on the FINAL attempt lands FAILED with a reason, and still raises', async () => {
    const id = 'p4_exhausted';
    await seedReceived(id, { businessId: null, byteHash: 'b1'.repeat(32), filename: 'receipt.jpg' });

    // Both halves matter. The throw still propagates, so the job reaches the DLQ
    // and an operator learns Bedrock is refusing; the document still lands
    // FAILED, so the client sees a reason and gets a Retry.
    await expect(
      throwingStep().run({ documentId: id, practiceId: P, businessId: null, traceId: 'trace-exhausted', finalAttempt: true }),
    ).rejects.toThrow('bedrock is unreachable');

    const row = await owner.document.findUnique({ where: { id } });
    expect(row?.state).toBe('FAILED');
    expect(row?.failureCode).toBe('NT-EXT-010');
    expect(row?.failureMessage).toBeTruthy();
    // The SDK's own words never reach the client.
    expect(row?.failureMessage).not.toMatch(/bedrock is unreachable/);
    // FAILED is one of the two states `document.reprocess` accepts, which is
    // what makes this document retryable at all.
    expect(['FAILED', 'REJECTED']).toContain(row?.state);
    // Nothing was invented on the way past.
    expect(await owner.extraction.count({ where: { documentId: id } })).toBe(0);
  });

/**
 * **What the REAL extractor does: read the document and code NOTHING.**
 *
 * `BedrockExtractor` leaves `categoryCode` null on purpose — *a model opinion
 * written straight into a category is an unreviewed change to a ledger* — so
 * the coding ladder is the only thing that has anything to say about the
 * Category field. Every `DemoExtractor` profile codes, which is precisely why
 * the ladder could never be exercised through one, and why this stand-in
 * exists: it reproduces the real extractor's silence on coding and nothing
 * else.
 */
class UncodedExtractor implements DocumentExtractor {
  readonly kind = 'bedrock';
  readonly modelVersion = 'anthropic.test';
  async extract(): Promise<{ ok: true; document: ExtractedDocument }> {
    const field = (value: unknown) => ({ value, provenance: 'AI_SUGGESTED' as const, confidence: 0.9, source: 'anthropic.test' });
    return {
      ok: true,
      document: {
        docType: 'INVOICE',
        supplierName: 'Nexora Solutions LLC',
        customerName: null,
        documentDate: '2026-05-12',
        dueDate: null,
        currency: 'GBP',
        totalPence: 129_900,
        taxPence: 21_650,
        reference: 'NX-1',
        vatNumber: null,
        // ⚠ THE POINT OF THIS FIXTURE.
        categoryCode: null,
        fields: {
          supplierName: field('Nexora Solutions LLC'),
          totalPence: field(129_900),
          taxPence: field(21_650),
          documentDate: field('2026-05-12'),
          currency: field('GBP'),
        },
        lineItems: [],
        validatorResults: {},
        validatorFailed: false,
        overallConfidence: 0.9,
        suggestions: [],
      } as unknown as ExtractedDocument,
    };
  }
}

/** The worker composition root's own wiring, built the same way it builds it. */
function advisedStep(): PrismaExtractionStep {
  return new PrismaExtractionStep(app, new UncodedExtractor(), {
    sleep: async () => {},
    coding: new SupplierCodingService(app, new ChartOfAccountsService(app)),
  });
}

/**
 * **The bug this whole change exists to close, proven against a real database:
 * an accountant seeing a blank Category with no explanation.**
 *
 * The ladder shipped fully tested with nobody calling it. These assertions are
 * the call — and the two things the answer must never do.
 */
describe('the coding ladder reaches the document, and codes nothing', () => {
  test('an uncoded document carries the ladder’s answer, stays TO_REVIEW, and its category_code is untouched', async () => {
    const id = 'p4_advised';
    await seedReceived(id, { businessId: B, byteHash: 'a'.repeat(64), filename: 'nexora-invoice.pdf' });
    await advisedStep().run({ documentId: id, practiceId: P, businessId: B, traceId: `trace-${id}`, finalAttempt: false });

    const row = await owner.document.findUnique({ where: { id } });
    // ⚠ NOTHING NEW WRITES `documents.category_code`. The header projection is
    // still its one writer and it only ever carries the extractor's value or an
    // accountant's rule — neither of which exists here.
    expect(row?.categoryCode).toBeNull();
    // ⚠ AND A SUGGESTION DOES NOT MAKE A DOCUMENT READY. The mandatory set is
    // Total + Supplier + Category; a suggestion is not a category.
    expect(row?.state).toBe('TO_REVIEW');
    // The rest of the header still landed, so this is a document one field from
    // Ready — which is exactly what the screen must say.
    expect(row?.supplierName).toBe('Nexora Solutions LLC');
    expect(row?.totalPence).toBe(129_900);

    // The suggestion rides in the existing `fields` jsonb under its reserved
    // key — no column, no migration.
    const extraction = await owner.extraction.findFirst({ where: { documentId: id, isAccepted: true } });
    const stored = (extraction?.fields as Record<string, unknown> | null)?.['codingSuggestion'] as Record<string, unknown> | undefined;
    expect(stored).toBeDefined();
    expect(stored?.['provenance']).toBe('AI_SUGGESTED');
    // Whatever it decided, it said something a person can read.
    expect(String(stored?.['note']).length).toBeGreaterThan(0);
    expect(['SUGGEST', 'ESCALATE']).toContain(stored?.['outcome']);

    // The read projection separates it onto the contract property AND strips it
    // from `fields` — the #137 bug class, which fails every document read in
    // the browser when it regresses.
    const projected = toExtraction(extraction!);
    expect(projected.codingSuggestion).toBeDefined();
    expect(Object.keys(projected.fields)).not.toContain('codingSuggestion');

    // The coding rung is its own line in the per-document processing log, so
    // "why is this Category empty" is answerable from the record.
    const event = await owner.documentEvent.findFirst({ where: { documentId: id, stage: 'code' } });
    expect(event).not.toBeNull();
    expect(['suggested', 'escalated']).toContain(event?.outcome);
    // Said out loud on every row: this stage applied nothing.
    expect((event?.detail as Record<string, unknown>)?.['applied']).toBe(false);
  });

  test('a document a rule already coded is never asked about', async () => {
    const id = 'p4_advised_ruled';
    await owner.rule.create({
      data: {
        id: 'p4_rule_nexora',
        businessId: B,
        tier: 'SUPPLIER_CUSTOMER',
        scopeKey: 'Nexora Solutions LLC',
        sets: { categoryCode: 'OFFICE_EQUIPMENT' },
        isActive: true,
      },
    });
    await seedReceived(id, { businessId: B, byteHash: 'b'.repeat(64), filename: 'nexora-invoice-2.pdf' });
    await advisedStep().run({ documentId: id, practiceId: P, businessId: B, traceId: `trace-${id}`, finalAttempt: false });

    const row = await owner.document.findUnique({ where: { id } });
    // The accountant's own instruction won, and no opinion rode along beside it:
    // a suggestion there is not extra information, it is pressure to
    // second-guess an explicit instruction.
    expect(row?.categoryCode).toBe('OFFICE_EQUIPMENT');
    const extraction = await owner.extraction.findFirst({ where: { documentId: id, isAccepted: true } });
    expect((extraction?.fields as Record<string, unknown> | null)?.['codingSuggestion']).toBeUndefined();
    expect(await owner.documentEvent.count({ where: { documentId: id, stage: 'code' } })).toBe(0);
  });
});

});
