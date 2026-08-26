import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { RecordingChaseAutoClose } from '../../chase/index.js';
import { RecordingExtractionStep } from '../../extraction/index.js';
import { InMemoryDocumentStore } from '../storage/document-store.js';
import { documentIdFor, PrismaDocumentSink } from './document-sink.js';
import { InMemoryDuplicateDetector } from './duplicate-detector.js';
import { processIngestJob } from './ingest-processor.js';
import { RecordingUploadSanitisation } from '../web-upload/upload-sanitisation.js';
import { FixtureMediaFetcher } from './media-fetcher.js';
import { InMemoryProcessedStore } from './processed-store.js';

/**
 * The WhatsApp lane proven end to end against a REAL database — acceptance #5 of
 * issue #79. A media id is resolved to bytes (fixture fetcher, so no network),
 * sanitised, stored, and then persisted through `scopedDb`, so this test shows
 * what a unit test cannot: that the RLS-scoped write actually lands, anchored on
 * the practice a WhatsApp document has instead of a business, with the caption
 * kept wrapped in the `description` column.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable — a tenancy suite that quietly passes
 * while proving nothing is worse than none.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];

let owner: PrismaClient;
let app: PrismaClient;

const PRACTICE = 'p79_prac';

/** PNG signature — valid for this pipeline (the fixture normaliser is a passthrough). */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);

const whatsappJob = {
  source: 'whatsapp',
  idempotencyKey: 'wamid.p79.1',
  from: '447700900000',
  receivedAtSeconds: 1_700_000_000,
  messageType: 'image',
  caption: '<untrusted_content>lunch receipt</untrusted_content>',
  routing: { kind: 'unrouted' },
  stale: false,
  traceId: 'trace-p79',
  mediaId: 'media-p79',
  practiceId: PRACTICE,
  phoneNumberId: '123456789012345',
};

async function cleanup(): Promise<void> {
  await owner.document.deleteMany({ where: { practiceId: PRACTICE } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 'p79_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 'p79_' } } });
  await owner.practice.deleteMany({ where: { id: { startsWith: 'p79_' } } });
}

beforeAll(async () => {
  if (DATABASE_URL === undefined || OWNER_URL === undefined) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`; // configured-but-unreachable → throw, not skip

  await cleanup();
  await owner.practice.create({ data: { id: PRACTICE, name: 'P79' } });
  await owner.user.create({ data: { id: 'p79_sys', kind: 'SYSTEM' } });
  await owner.membership.create({
    data: { id: 'p79_mem_sys', userId: 'p79_sys', practiceId: PRACTICE, role: 'PRACTICE_STANDARD' },
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!DATABASE_URL || !OWNER_URL)('WhatsApp media intake against a real database', () => {
  test('a fetched WhatsApp image persists as an unrouted document under its practice, caption still wrapped', async () => {
    const fetcher = new FixtureMediaFetcher();
    fetcher.put('media-p79', { bytes: PNG });
    const store = new InMemoryDocumentStore();

    await processIngestJob(whatsappJob, {
      processed: new InMemoryProcessedStore(),
      logger: { log: () => {}, warn: () => {} },
      sink: new PrismaDocumentSink(app),
      detector: new InMemoryDuplicateDetector(),
      media: { fetcher, store },
      // Never consulted: a WhatsApp job carries no `documentId`, so it never
      // reaches the already-persisted branch sanitisation lives on (Stage A3).
      uploadSanitiser: new RecordingUploadSanitisation(),
      // A no-op here: this test is about the #79 persistence/tenancy write, not
      // extraction (which has its own integration test). Leaving the document in
      // RECEIVED keeps the assertions below about what the sink wrote.
      extractor: new RecordingExtractionStep(),
      // No-op: extraction returns null, so auto-close is never triggered here.
      autoClose: new RecordingChaseAutoClose(),
      finalAttempt: false,
    });

    const documentId = documentIdFor(whatsappJob.idempotencyKey);
    const row = await owner.document.findUnique({ where: { id: documentId } });
    expect(row?.practiceId).toBe(PRACTICE);
    expect(row?.businessId).toBeNull();
    expect(row?.inbox).toBe('UNROUTED');
    expect(row?.state).toBe('RECEIVED');
    expect(row?.channel).toBe('WHATSAPP');
    // The caption is stored as the description AND STILL WRAPPED — never unwrapped
    // into a field extraction later feeds to a model (§9.6).
    expect(row?.description).toBe('<untrusted_content>lunch receipt</untrusted_content>');
    // The row points at bytes that really landed in the store, under the practice.
    expect(row?.s3Key).toBe(`w/_unrouted/${PRACTICE}/documents/${row?.byteHash}`);

    const events = await owner.documentEvent.findMany({ where: { documentId } });
    expect(events).toHaveLength(1);
    expect(events[0]?.stage).toBe('ingest');
    expect(events[0]?.traceId).toBe('trace-p79');
  });
});
