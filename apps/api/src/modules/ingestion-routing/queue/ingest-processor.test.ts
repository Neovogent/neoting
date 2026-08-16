import { expect, test } from 'vitest';

import { InMemoryDocumentStore } from '../storage/document-store.js';
import { InMemoryDocumentSink } from './document-sink.js';
import { InMemoryDuplicateDetector } from './duplicate-detector.js';
import { processIngestJob, TerminalJobError } from './ingest-processor.js';
import { FixtureMediaFetcher, MediaFetchError } from './media-fetcher.js';
import { InMemoryProcessedStore } from './processed-store.js';

/** A PNG signature is all the magic-byte sniffer reads, and the fixture
 *  normaliser is a passthrough — so these ARE valid PNG bytes for this pipeline. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);

function harness(): {
  logs: string[];
  warns: string[];
  sink: InMemoryDocumentSink;
  detector: InMemoryDuplicateDetector;
  processed: InMemoryProcessedStore;
  fetcher: FixtureMediaFetcher;
  store: InMemoryDocumentStore;
  deps: Parameters<typeof processIngestJob>[1];
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const sink = new InMemoryDocumentSink();
  const detector = new InMemoryDuplicateDetector();
  const processed = new InMemoryProcessedStore();
  const fetcher = new FixtureMediaFetcher();
  const store = new InMemoryDocumentStore();
  return {
    logs,
    warns,
    sink,
    detector,
    processed,
    fetcher,
    store,
    deps: {
      processed,
      logger: { log: (m) => logs.push(m), warn: (m) => warns.push(m) },
      sink,
      detector,
      media: { fetcher, store },
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

/** A WhatsApp media job as the webhook now enqueues it (#79). */
const whatsappJob = {
  source: 'whatsapp',
  idempotencyKey: 'wamid.1',
  from: '447700900000',
  receivedAtSeconds: 1_700_000_000,
  messageType: 'image',
  caption: '<untrusted_content>lunch with a client</untrusted_content>',
  routing: { kind: 'unrouted' },
  stale: false,
  traceId: 'trace-wa',
  mediaId: 'media-1',
  practiceId: 'prac_wa',
  phoneNumberId: '123456789012345',
};

test('an email job — bytes in hand — is persisted through the sink', async () => {
  const h = harness();
  await processIngestJob(emailJob, h.deps);
  expect(h.sink.persisted.size).toBe(1);
  expect(h.logs.some((l) => l.includes('persisted document'))).toBe(true);
});

test('a text-only whatsapp message is logged, not persisted — and not dropped', async () => {
  const h = harness();
  const { mediaId: _mediaId, ...textOnly } = whatsappJob;
  await processIngestJob({ ...textOnly, messageType: 'text' }, h.deps);
  expect(h.sink.persisted.size).toBe(0);
  expect(h.logs.some((l) => l.includes('no media on'))).toBe(true);
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

// ── WhatsApp media fetch (#79) ───────────────────────────────────────────────

test('a whatsapp media job is fetched, sanitised, stored and persisted with its caption', async () => {
  const h = harness();
  h.fetcher.put('media-1', { bytes: PNG, declaredMimeType: 'image/png' });

  await processIngestJob(whatsappJob, h.deps);

  expect(h.fetcher.requested).toEqual(['media-1']);
  expect(h.sink.persisted.size).toBe(1);
  const persisted = [...h.sink.persisted.values()][0];
  expect(persisted?.channel).toBe('WHATSAPP');
  expect(persisted?.practiceId).toBe('prac_wa');
  expect(persisted?.mimeType).toBe('image/png');
  expect(persisted?.byteSize).toBe(PNG.length);
  // The caption is the description — and it is STILL WRAPPED. Unwrapping it here
  // would put sender-controlled text into a field extraction feeds to a model.
  expect(persisted?.description).toBe('<untrusted_content>lunch with a client</untrusted_content>');
  // Bytes are in object storage before the row points at them.
  await expect(h.store.get(persisted?.s3Key ?? '')).resolves.toEqual(PNG);
  // Unrouted → partitioned by practice, never a shared prefix.
  expect(persisted?.s3Key).toContain('w/_unrouted/prac_wa/documents/');
});

test('the perceptual hash is computed from the bytes in hand, never re-fetched', async () => {
  const h = harness();
  h.fetcher.put('media-1', { bytes: PNG });
  const hashed: Buffer[] = [];
  const deps = {
    ...h.deps,
    media: {
      ...h.deps.media,
      perceptualHasher: {
        async hash(bytes: Buffer) {
          hashed.push(bytes);
          return 'f'.repeat(16);
        },
      },
    },
  };

  await processIngestJob({ ...whatsappJob, routing: { kind: 'matched', businessId: 'biz_wa' } }, deps);

  expect(hashed).toEqual([PNG]); // the sanitised bytes, not a round trip to S3
  expect(h.detector.seen[0]?.perceptualHash).toBe('f'.repeat(16));
});

test('a redelivered wamid stays a logged no-op — the media is not fetched twice', async () => {
  const h = harness();
  h.fetcher.put('media-1', { bytes: PNG });

  await processIngestJob(whatsappJob, h.deps);
  await processIngestJob(whatsappJob, h.deps);

  expect(h.fetcher.requested).toEqual(['media-1']); // once, not twice
  expect(h.sink.persisted.size).toBe(1);
  expect(h.warns.some((w) => w.includes('already processed'))).toBe(true);
});

test('an expired media id is TERMINAL — dead-lettered now, not retried forever', async () => {
  const h = harness();
  h.fetcher.failWith('media-1', new MediaFetchError('expired', 'Meta no longer holds this media id', 404));

  await expect(processIngestJob(whatsappJob, h.deps)).rejects.toThrow(TerminalJobError);
  expect(h.warns.some((w) => w.includes('terminal, dead-lettering'))).toBe(true);
  expect(h.sink.persisted.size).toBe(0);
  // The claim was released, so nothing is left marked "done" having written nothing.
  expect(await h.processed.markProcessed(whatsappJob.idempotencyKey)).toBe(true);
});

test('a Graph 5xx is TRANSIENT — rethrown so BullMQ backs off and retries', async () => {
  const h = harness();
  h.fetcher.failWith('media-1', new MediaFetchError('upstream', 'Meta Graph returned 503', 503));

  const error = await processIngestJob(whatsappJob, h.deps).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MediaFetchError);
  expect(error).not.toBeInstanceOf(TerminalJobError);
  expect(h.warns.some((w) => w.includes('retrying'))).toBe(true);
});

test('a media job with no practice anchor refuses to persist and dead-letters', async () => {
  const h = harness();
  h.fetcher.put('media-1', { bytes: PNG });
  const { practiceId: _practiceId, ...unanchored } = whatsappJob;

  await expect(processIngestJob(unanchored, h.deps)).rejects.toThrow(TerminalJobError);
  await expect(processIngestJob({ ...unanchored, idempotencyKey: 'wamid.2' }, h.deps)).rejects.toThrow(
    /WHATSAPP_PRACTICE_MAP/,
  );
  expect(h.sink.persisted.size).toBe(0);
  expect(h.fetcher.requested).toHaveLength(0); // refused before spending a Graph call
});

test('a sanitisation refusal is said out loud with its NT-ING code, and persists nothing', async () => {
  const h = harness();
  h.fetcher.put('media-1', { bytes: Buffer.from('this is not any accepted format') });

  await processIngestJob(whatsappJob, h.deps);

  expect(h.sink.persisted.size).toBe(0);
  expect(h.warns.some((w) => w.includes('NT-ING-002') && w.includes('trace-wa'))).toBe(true);
});

test('the fixture fetcher never invents bytes for an id nobody seeded', async () => {
  const h = harness();
  await expect(processIngestJob(whatsappJob, h.deps)).rejects.toThrow(TerminalJobError);
  expect(h.sink.persisted.size).toBe(0);
});
