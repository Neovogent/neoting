import { expect, test } from 'vitest';

import { InMemoryDocumentSink } from './document-sink.js';
import { InMemoryDuplicateDetector } from './duplicate-detector.js';
import { processIngestJob } from './ingest-processor.js';
import { InMemoryProcessedStore } from './processed-store.js';

function harness(): {
  logs: string[];
  warns: string[];
  sink: InMemoryDocumentSink;
  detector: InMemoryDuplicateDetector;
  processed: InMemoryProcessedStore;
  deps: Parameters<typeof processIngestJob>[1];
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const sink = new InMemoryDocumentSink();
  const detector = new InMemoryDuplicateDetector();
  const processed = new InMemoryProcessedStore();
  return {
    logs,
    warns,
    sink,
    detector,
    processed,
    deps: {
      processed,
      logger: { log: (m) => logs.push(m), warn: (m) => warns.push(m) },
      sink,
      detector,
    },
  };
}

const SHA = 'a'.repeat(64);

const emailJob = {
  source: 'email',
  idempotencyKey: `<m@x>#0#${SHA}`,
  from: 'sender@acme.co',
  receivedAtSeconds: 1_700_000_000,
  messageType: 'png',
  caption: '<untrusted_content>hi</untrusted_content>',
  routing: { kind: 'unrouted' },
  stale: false,
  traceId: 'trace-email',
  filename: 'receipt.png',
  sha256: SHA,
  storageKey: `w/_unrouted/documents/${SHA}`,
  practiceId: 'prac_x',
  mimeType: 'image/png',
  byteSize: 11,
};

const whatsappJob = {
  source: 'whatsapp',
  idempotencyKey: 'wamid.1',
  from: '447700900000',
  receivedAtSeconds: 1_700_000_000,
  messageType: 'image',
  caption: null,
  routing: { kind: 'unrouted' },
  stale: false,
  traceId: 'trace-wa',
};

test('an email job — bytes in hand — is persisted through the sink', async () => {
  const h = harness();
  await processIngestJob(emailJob, h.deps);
  expect(h.sink.persisted.size).toBe(1);
  expect(h.logs.some((l) => l.includes('persisted document'))).toBe(true);
});

test('a whatsapp job (media not fetched yet) is logged, not persisted', async () => {
  const h = harness();
  await processIngestJob(whatsappJob, h.deps);
  expect(h.sink.persisted.size).toBe(0);
  expect(h.logs.some((l) => l.includes('no document to persist'))).toBe(true);
});

test('a routed document triggers duplicate detection within its business', async () => {
  const h = harness();
  await processIngestJob({ ...emailJob, routing: { kind: 'matched', businessId: 'biz_1' } }, h.deps);
  expect(h.detector.seen).toHaveLength(1);
  expect(h.detector.seen[0]?.businessId).toBe('biz_1');
  expect(h.detector.seen[0]?.perceptualHash).toBeNull(); // none on this payload
  expect(h.logs.some((l) => l.includes('dedupe'))).toBe(true);
});

test('an unrouted document persists but is not dedupe-detected (no business to anchor a Duplicate)', async () => {
  const h = harness();
  await processIngestJob(emailJob, h.deps); // routing.kind === 'unrouted'
  expect(h.sink.persisted.size).toBe(1);
  expect(h.detector.seen).toHaveLength(0);
});

test('when the work throws, the idempotency claim is released so the retry redoes it', async () => {
  const h = harness();
  const throwingSink: Parameters<typeof processIngestJob>[1]['sink'] = {
    persist: async () => {
      throw new Error('sink down');
    },
  };
  await expect(processIngestJob(emailJob, { ...h.deps, sink: throwingSink })).rejects.toThrow('sink down');
  // The claim was released, so a fresh attempt sees the key as NEW, not "already processed".
  expect(await h.processed.markProcessed(emailJob.idempotencyKey)).toBe(true);
});

test('the same idempotencyKey handled twice does not double-process', async () => {
  const h = harness();
  await processIngestJob(emailJob, h.deps);
  await processIngestJob(emailJob, h.deps);
  expect(h.sink.persisted.size).toBe(1); // the processed-store skips the redelivery before it reaches the sink
  expect(h.warns).toHaveLength(1);
});

test('a malformed payload is rejected at the boundary (throws → BullMQ retries / DLQs)', async () => {
  const h = harness();
  await expect(processIngestJob({ nonsense: true }, h.deps)).rejects.toThrow();
  await expect(processIngestJob({ ...emailJob, traceId: '' }, h.deps)).rejects.toThrow();
});

test('a job whose persistence fails is retried, not silently swallowed', async () => {
  const h = harness();
  let attempts = 0;
  const flaky = {
    async persist(input: Parameters<InMemoryDocumentSink['persist']>[0]) {
      attempts += 1;
      if (attempts === 1) throw new Error('database unreachable');
      return h.sink.persist(input);
    },
  };
  const deps = { ...h.deps, sink: flaky };

  // First delivery: the sink is down, so the job must throw and let BullMQ retry.
  await expect(processIngestJob(emailJob, deps)).rejects.toThrow('database unreachable');

  // The retry MUST do the work. If the processor marked the key processed before
  // persisting, this returns quietly having written nothing — the document is
  // lost, the job reports success, and it never reaches the DLQ.
  await processIngestJob(emailJob, deps);

  expect(attempts).toBe(2);
  expect(h.sink.persisted.size).toBe(1);
});
