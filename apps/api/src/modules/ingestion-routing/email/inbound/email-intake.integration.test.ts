import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { RecordingExtractionStep } from '../../../extraction/index.js';
import { documentIdFor, PrismaDocumentSink } from '../../queue/document-sink.js';
import { InMemoryDuplicateDetector } from '../../queue/duplicate-detector.js';
import { processIngestJob } from '../../queue/ingest-processor.js';
import { FixtureMediaFetcher } from '../../queue/media-fetcher.js';
import { InMemoryProcessedStore } from '../../queue/processed-store.js';
import { InMemoryDocumentStore } from '../../storage/document-store.js';
import { FixtureIngestQueue } from '../../webhooks/whatsapp/ingest-queue.js';
import type { EmailParser } from '../email-parser.js';
import type { ParsedEmail } from '../parsed-email.js';
import { runEmailIntake } from './email-intake-runner.js';

/**
 * The email lane proven end to end against a REAL database — acceptance #5 of
 * issue #78. A parsed email with two attachments (one clean, one encrypted) runs
 * through the intake runner → `processEmail` → the worker's sink, and the result
 * is exactly one persisted `Document` and one visible rejection with a reason:
 * partial acceptance, never all-or-nothing, proven where a unit test cannot —
 * that the `scopedDb` write actually lands under the recipient's practice.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];

let owner: PrismaClient;
let app: PrismaClient;

const PRACTICE = 'p78_prac';

/** A PNG signature — accepted by the pipeline (fixture normaliser is a passthrough). */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
/** A PDF the default document guard flags as encrypted (it greps for `/Encrypt`). */
const ENCRYPTED_PDF = Buffer.from('%PDF-1.4\n1 0 obj<< /Encrypt 2 0 R >>endobj\ntrailer<< /Encrypt 2 0 R >>\n%%EOF');

function twoAttachmentEmail(): ParsedEmail {
  return {
    from: 'client@acme.co',
    to: `doc+${PRACTICE}@neoting.test`,
    subject: 'receipts',
    date: null,
    messageId: '<m78@acme.co>',
    text: 'two attached',
    attachments: [
      { filename: 'receipt.png', contentType: 'image/png', bytes: PNG },
      { filename: 'locked.pdf', contentType: 'application/pdf', bytes: ENCRYPTED_PDF },
    ],
  };
}

const parser: EmailParser = { async parse() { return twoAttachmentEmail(); } };
const quietLogger = { log: () => {}, warn: () => {} };

async function cleanup(): Promise<void> {
  await owner.document.deleteMany({ where: { practiceId: PRACTICE } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 'p78_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 'p78_' } } });
  await owner.practice.deleteMany({ where: { id: { startsWith: 'p78_' } } });
}

beforeAll(async () => {
  if (DATABASE_URL === undefined || OWNER_URL === undefined) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`; // configured-but-unreachable → throw, not skip

  await cleanup();
  await owner.practice.create({ data: { id: PRACTICE, name: 'P78' } });
  await owner.user.create({ data: { id: 'p78_sys', kind: 'SYSTEM' } });
  await owner.membership.create({
    data: { id: 'p78_mem_sys', userId: 'p78_sys', practiceId: PRACTICE, role: 'PRACTICE_STANDARD' },
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!DATABASE_URL || !OWNER_URL)('email intake against a real database', () => {
  test('two attachments — one clean, one encrypted — yield exactly one document and one recorded rejection', async () => {
    const queue = new FixtureIngestQueue();
    const store = new InMemoryDocumentStore();

    const outcome = await runEmailIntake(
      {
        id: 'p78-msg',
        raw: Buffer.from('raw'),
        envelopeRecipient: `doc+${PRACTICE}@neoting.test`,
        receivedAtSeconds: 1_700_000_000,
      },
      { parser, queue, logger: quietLogger, store },
    );

    if (outcome.status !== 'processed') throw new Error(`expected processed, got ${outcome.status}`);
    // Partial acceptance: the clean PNG is accepted, the encrypted PDF rejected
    // with a plain-English reason — never all-or-nothing.
    expect(outcome.result.accepted).toHaveLength(1);
    expect(outcome.result.rejected).toHaveLength(1);
    expect(outcome.result.rejected[0]?.reason).toBeTruthy();
    expect(queue.enqueued).toHaveLength(1);

    const enqueued = queue.enqueued[0];
    if (enqueued === undefined) throw new Error('expected one enqueued job');
    // The fixture queue does not attach a traceId; the real producer would. Stamp
    // the one the payload schema requires so the worker path can run.
    const job = { ...enqueued, traceId: 'trace-p78' };

    const sink = new PrismaDocumentSink(app);
    // `media` became a required ProcessorDeps member with #96 (WhatsApp media
    // fetch). An email job carries its bytes already, so the fetcher is never
    // consulted on this path — the empty fixture proves that by construction.
    const workerDeps = () => ({
      processed: new InMemoryProcessedStore(),
      logger: quietLogger,
      sink,
      detector: new InMemoryDuplicateDetector(),
      media: { fetcher: new FixtureMediaFetcher(), store: new InMemoryDocumentStore() },
      // No-op: this #78 test asserts the persistence write, not extraction.
      extractor: new RecordingExtractionStep(),
    });

    await processIngestJob(job, workerDeps());

    const documentId = documentIdFor(job.idempotencyKey);
    expect(await owner.document.count({ where: { practiceId: PRACTICE } })).toBe(1);
    const row = await owner.document.findUnique({ where: { id: documentId } });
    expect(row?.channel).toBe('EMAIL');
    expect(row?.practiceId).toBe(PRACTICE);
    expect(row?.inbox).toBe('UNROUTED');

    // A redelivery of the same job is a no-op — still exactly one document
    // (#78 acceptance 4). A fresh ProcessedStore forces the durability to rest on
    // the sink's derived primary key, not the in-process claim.
    await processIngestJob(job, workerDeps());
    expect(await owner.document.count({ where: { practiceId: PRACTICE } })).toBe(1);
  });
});
