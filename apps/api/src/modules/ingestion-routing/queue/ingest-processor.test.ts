import { NO_MATCH_SUGGESTER, NO_STATEMENT_STEP, RecordingMatchSuggester } from '../../banking-matching/index.js';
import { expect, test } from 'vitest';

import { RecordingChaseAutoClose } from '../../chase/index.js';
import { type ExtractionCompletion, RecordingExtractionStep } from '../../extraction/index.js';
import { InMemoryDocumentStore } from '../storage/document-store.js';
import {
  RecordingUploadSanitisation,
  type UploadSanitisationResult,
} from '../web-upload/upload-sanitisation.js';
import { InMemoryDocumentSink } from './document-sink.js';
import { InMemoryDuplicateDetector } from './duplicate-detector.js';
import { processIngestJob, TerminalJobError } from './ingest-processor.js';
import { FixtureMediaFetcher, MediaFetchError } from './media-fetcher.js';
import { InMemoryProcessedStore } from './processed-store.js';

/** A PNG signature is all the magic-byte sniffer reads, and the fixture
 *  normaliser is a passthrough — so these ARE valid PNG bytes for this pipeline. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);

function harness(
  completion: ExtractionCompletion | null = null,
  sanitisation?: UploadSanitisationResult,
): {
  logs: string[];
  warns: string[];
  sink: InMemoryDocumentSink;
  detector: InMemoryDuplicateDetector;
  processed: InMemoryProcessedStore;
  fetcher: FixtureMediaFetcher;
  store: InMemoryDocumentStore;
  extractor: RecordingExtractionStep;
  autoClose: RecordingChaseAutoClose;
  uploadSanitiser: RecordingUploadSanitisation;
  deps: Parameters<typeof processIngestJob>[1];
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const sink = new InMemoryDocumentSink();
  const detector = new InMemoryDuplicateDetector();
  const processed = new InMemoryProcessedStore();
  const fetcher = new FixtureMediaFetcher();
  const store = new InMemoryDocumentStore();
  const extractor = new RecordingExtractionStep(completion);
  const autoClose = new RecordingChaseAutoClose();
  const uploadSanitiser =
    sanitisation === undefined ? new RecordingUploadSanitisation() : new RecordingUploadSanitisation(sanitisation);
  return {
    logs,
    warns,
    sink,
    detector,
    processed,
    fetcher,
    store,
    extractor,
    autoClose,
    uploadSanitiser,
    deps: {
      processed,
      logger: { log: (m) => logs.push(m), warn: (m) => warns.push(m) },
      sink,
      detector,
      media: { fetcher, store },
      uploadSanitiser,
      extractor,
      autoClose,
      // Not a statement test: the step is declared and does nothing. Declaring
      // it is the point — `statements` is required precisely so a composition
      // root cannot forget it by accident.
      statements: NO_STATEMENT_STEP,
      matchSuggester: NO_MATCH_SUGGESTER,
      // These unit tests drive the processor directly, with no BullMQ job above
      // them, so "is this the last attempt" has no real answer. `false` is the
      // one that changes nothing: extraction rethrows and stays PROCESSING,
      // which is what these tests already assert.
      finalAttempt: false,
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

test('extraction runs after a persisted document, carrying its ids (METH Stage 4)', async () => {
  const h = harness();
  await processIngestJob(emailJob, h.deps);
  expect(h.extractor.runs).toHaveLength(1);
  const run = h.extractor.runs[0];
  expect(run?.documentId).toBeTruthy(); // extraction reads filename/byteHash off the row
  expect(run?.practiceId).toBe('prac_x');
  expect(run?.businessId).toBeNull(); // unrouted
  expect(run?.traceId).toBe('trace-email');
});

test('a routed job hands extraction the business it was routed to', async () => {
  const h = harness();
  await processIngestJob({ ...emailJob, routing: { kind: 'matched', businessId: 'biz_1' } }, h.deps);
  expect(h.extractor.runs[0]?.businessId).toBe('biz_1');
});

// ── Auto-close on inbound match (chase, METH Stage 8) ────────────────────────

/** A landed extraction completion — the header the auto-close hook receives. */
const READY_COMPLETION: ExtractionCompletion = {
  documentId: 'unused', // the RecordingExtractionStep overwrites it with the real id
  businessId: null, // ditto — reflected from the run's businessId
  state: 'READY',
  supplierName: 'Currys',
  totalPence: 129_900,
  documentDate: new Date('2026-08-09T00:00:00.000Z'),
};

test('a routed, landed document runs auto-close with its extracted header (METH Stage 8)', async () => {
  const h = harness(READY_COMPLETION);
  await processIngestJob({ ...emailJob, routing: { kind: 'matched', businessId: 'biz_1' } }, h.deps);

  expect(h.autoClose.runs).toHaveLength(1);
  const run = h.autoClose.runs[0];
  expect(run?.businessId).toBe('biz_1');
  expect(run?.practiceId).toBe('prac_x');
  expect(run?.supplierName).toBe('Currys');
  expect(run?.totalPence).toBe(129_900);
  expect(run?.traceId).toBe('trace-email');
});

test('an unrouted document does not run auto-close (no business to anchor a chase)', async () => {
  // Even with a landed completion, an unrouted document (businessId null) has no
  // business to hold an open chase — auto-close is skipped.
  const h = harness({ ...READY_COMPLETION, businessId: null });
  await processIngestJob(emailJob, h.deps); // routing.kind === 'unrouted'
  expect(h.autoClose.runs).toHaveLength(0);
});

test('a document that did not land (FAILED/skipped extraction) does not run auto-close', async () => {
  // A null completion is a FAILED read or a no-op redelivery — a chase must never
  // close on a document we could not read.
  const h = harness(null);
  await processIngestJob({ ...emailJob, routing: { kind: 'matched', businessId: 'biz_1' } }, h.deps);
  expect(h.autoClose.runs).toHaveLength(0);
});

test('a web-upload document runs auto-close too, carrying the upload business', async () => {
  const h = harness(READY_COMPLETION);
  await processIngestJob(webUploadJob, h.deps);
  expect(h.autoClose.runs).toHaveLength(1);
  expect(h.autoClose.runs[0]?.businessId).toBe('biz_1');
  expect(h.autoClose.runs[0]?.practiceId).toBe('prac_web');
});

test('an auto-close failure is swallowed — the document is safe, the job succeeds', async () => {
  const h = harness(READY_COMPLETION);
  const failing = {
    ...h.deps,
    autoClose: {
      run: async () => {
        throw new Error('chase engine down');
      },
    },
  };
  // The job must NOT throw: the document is already persisted and extracted, and
  // a chase-close error is not allowed to lose it.
  await expect(
    processIngestJob({ ...emailJob, routing: { kind: 'matched', businessId: 'biz_1' } }, failing),
  ).resolves.toBeUndefined();
  expect(h.warns.some((w) => w.includes('auto-close') && w.includes('chase engine down'))).toBe(true);
});

test('a message with nothing to persist does not run extraction', async () => {
  const h = harness();
  const { mediaId: _mediaId, ...textOnly } = whatsappJob;
  await processIngestJob({ ...textOnly, messageType: 'text' }, h.deps);
  expect(h.sink.persisted.size).toBe(0);
  expect(h.extractor.runs).toHaveLength(0);
});

// A web upload persists its own document (in its service), then enqueues a job
// carrying documentId. Without a branch for it, materialise() finds no bytes and
// the document never leaves RECEIVED (Stage 4 acceptance #1).
const webUploadJob = {
  source: 'web_upload',
  idempotencyKey: 'doc_web_1',
  documentId: 'doc_web_1',
  from: 'biz_1',
  receivedAtSeconds: 1_700_000_000,
  messageType: 'web_upload',
  caption: null,
  routing: { kind: 'matched', businessId: 'biz_1' },
  stale: false,
  storageKey: 'w/biz_1/uploads/xyz',
  sha256: 'b'.repeat(64),
  practiceId: 'prac_web',
  traceId: 'trace-web',
};

test('a web-upload job extracts the already-persisted document without re-persisting', async () => {
  const h = harness();
  await processIngestJob(webUploadJob, h.deps);
  expect(h.sink.persisted.size).toBe(0); // the upload service already persisted it
  expect(h.extractor.runs).toHaveLength(1);
  const run = h.extractor.runs[0];
  expect(run?.documentId).toBe('doc_web_1');
  expect(run?.practiceId).toBe('prac_web');
  expect(run?.businessId).toBe('biz_1');
});

test('a web-upload job for a standalone business (no practice) is not extracted, and says so', async () => {
  const h = harness();
  const { practiceId: _p, ...standalone } = webUploadJob;
  await processIngestJob(standalone, h.deps);
  expect(h.extractor.runs).toHaveLength(0);
  expect(h.logs.some((l) => l.includes('standalone business'))).toBe(true);
});

// METH S7: the already-persisted branch bypasses persist() by design, which
// also bypassed the detector — so the same receipt dropped twice in the browser
// was the ONE arrival channel with no `duplicates` row behind the compare.
test('a web-upload job runs duplicate detection on the already-persisted document', async () => {
  const h = harness();
  await processIngestJob(webUploadJob, h.deps);
  expect(h.detector.seen).toHaveLength(1);
  expect(h.detector.seen[0]?.documentId).toBe('doc_web_1');
  expect(h.detector.seen[0]?.businessId).toBe('biz_1');
  // The default fixture sanitiser makes no statement about identity, so the
  // processor falls back to the job's own hash — the pre-A3 behaviour, kept
  // here deliberately so the fallback stays covered. The real step always
  // answers; see the sanitised-hash test below.
  expect(h.detector.seen[0]?.byteHash).toBe('b'.repeat(64));
  expect(h.detector.seen[0]?.perceptualHash).toBeNull();
  expect(h.logs.some((l) => l.includes('dedupe doc_web_1'))).toBe(true);
});

// ── Upload sanitisation (Stage A3) ──────────────────────────────────────────
//
// Web and portal uploads skipped sanitisation entirely: the document was
// persisted from the browser's claims and the worker went straight to dedupe and
// extract. A HEIC stayed HEIC, EXIF (and its GPS) was never stripped, and
// `documents.mime_type` was whatever the browser said.

test('a web-upload job is sanitised BEFORE it is deduped or extracted', async () => {
  const h = harness();
  await processIngestJob(webUploadJob, h.deps);
  expect(h.uploadSanitiser.runs).toHaveLength(1);
  const run = h.uploadSanitiser.runs[0];
  expect(run?.documentId).toBe('doc_web_1');
  expect(run?.practiceId).toBe('prac_web');
  expect(run?.businessId).toBe('biz_1');
  expect(run?.traceId).toBe('trace-web');
});

test('dedupe keys on the SANITISED byte hash, not the one the browser uploaded', async () => {
  // Sanitisation re-encodes: HEIC→JPEG, EXIF stripped, a PDF rewritten by qpdf.
  // The job's `sha256` then describes bytes that no longer exist anywhere, so
  // deduping against it compares this receipt to a file we do not hold.
  const h = harness(null, {
    status: 'sanitised',
    document: {
      storageKey: 'w/biz_1/documents/' + 'c'.repeat(64),
      byteHash: 'c'.repeat(64),
      byteSize: 900,
      mimeType: 'image/jpeg',
      perceptualHash: 'ffff0000ffff0000',
    },
  });
  await processIngestJob(webUploadJob, h.deps);

  expect(h.detector.seen).toHaveLength(1);
  expect(h.detector.seen[0]?.byteHash).toBe('c'.repeat(64)); // NOT the job's 'b'*64
  // Web uploads carried no perceptual hash at all until sanitisation computed
  // one, so the "same paper photographed twice" net never covered this lane.
  expect(h.detector.seen[0]?.perceptualHash).toBe('ffff0000ffff0000');
});

test('a rejected upload stops: no dedupe, no extraction, and a reason in the log', async () => {
  // The document is REJECTED on the row with its NT-ING code — the Rejected/
  // Failed surface — so nothing is dropped and nothing needs to dead-letter.
  const h = harness(null, {
    status: 'rejected',
    rejection: { kind: 'password_protected', code: 'NT-ING-004', message: 'This file is password-protected.' },
  });
  await processIngestJob(webUploadJob, h.deps);

  expect(h.detector.seen).toHaveLength(0);
  expect(h.extractor.runs).toHaveLength(0);
  expect(h.warns.some((w) => w.includes('NT-ING-004') && w.includes('doc_web_1'))).toBe(true);
});

test('an upload whose row is not visible stops rather than extracting nothing', async () => {
  const h = harness(null, { status: 'unavailable', reason: 'not visible' });
  await processIngestJob(webUploadJob, h.deps);
  expect(h.detector.seen).toHaveLength(0);
  expect(h.extractor.runs).toHaveLength(0);
  expect(h.warns.some((w) => w.includes('not available to sanitise'))).toBe(true);
});

test('an already-sanitised upload still extracts — a redelivery is not a failure', async () => {
  const h = harness(null, {
    status: 'already-sanitised',
    document: {
      storageKey: 'w/biz_1/documents/' + 'd'.repeat(64),
      byteHash: 'd'.repeat(64),
      byteSize: 12,
      mimeType: 'application/pdf',
      perceptualHash: null,
    },
  });
  await processIngestJob(webUploadJob, h.deps);
  expect(h.extractor.runs).toHaveLength(1);
  expect(h.detector.seen[0]?.byteHash).toBe('d'.repeat(64));
});

test('a web-upload job with no byte hash skips detection rather than keying on nothing', async () => {
  const h = harness();
  const { sha256: _sha, ...hashless } = webUploadJob;
  await processIngestJob(hashless, h.deps);
  expect(h.detector.seen).toHaveLength(0);
  expect(h.extractor.runs).toHaveLength(1); // extraction still runs — dedupe is a net, not a gate
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

test('a sanitisation refusal DEAD-LETTERS with its NT-ING code — never a quiet success', async () => {
  // REGRESSION. This used to warn and return null, which completed the job:
  // claim kept, wamid replay-blocked, media id expiring at Meta — the document
  // lost with one log line as its only trace. Terminal, like an unmapped
  // practice: the DLQ keeps job.data visible and replayable.
  const h = harness();
  h.fetcher.put('media-1', { bytes: Buffer.from('this is not any accepted format') });

  await expect(processIngestJob(whatsappJob, h.deps)).rejects.toThrow(TerminalJobError);

  expect(h.sink.persisted.size).toBe(0);
  expect(h.warns.some((w) => w.includes('NT-ING-002') && w.includes('trace-wa'))).toBe(true);
});

test('the fixture fetcher never invents bytes for an id nobody seeded', async () => {
  const h = harness();
  await expect(processIngestJob(whatsappJob, h.deps)).rejects.toThrow(TerminalJobError);
  expect(h.sink.persisted.size).toBe(0);
});

/* ── WhatsApp routing anchors (Phase 2) ─────────────────────────────────────── */

const mapOf = (entries: Record<string, readonly string[]>) => new Map(Object.entries(entries));

test('a whatsapp sender registered as a contact routes to their workspace', async () => {
  const h = harness();
  h.fetcher.put('media-1', { bytes: PNG });
  const deps = {
    ...h.deps,
    // The wa_id arrives without the leading `+`; buildSenderMap keys both
    // forms, so a plain-map fixture keys the bare form directly.
    senderMap: { load: async (_practiceId: string) => mapOf({ '447700900000': ['biz_wa'] }) },
  };

  await processIngestJob(whatsappJob, deps);

  const persisted = [...h.sink.persisted.values()][0];
  expect(persisted?.businessId).toBe('biz_wa');
  expect(h.extractor.runs[0]?.businessId).toBe('biz_wa');
});

test('a sender on two workspaces stays Unrouted with the which-company reason', async () => {
  const h = harness();
  h.fetcher.put('media-1', { bytes: PNG });
  const deps = {
    ...h.deps,
    senderMap: { load: async () => mapOf({ '447700900000': ['biz_a', 'biz_b'] }) },
  };

  await processIngestJob(whatsappJob, deps);

  const persisted = [...h.sink.persisted.values()][0];
  expect(persisted?.businessId).toBeNull();
  expect(h.logs.some((l) => l.includes('unrouted'))).toBe(true);
});

test('an unknown whatsapp sender stays Unrouted — never guessed, never dropped', async () => {
  const h = harness();
  h.fetcher.put('media-1', { bytes: PNG });
  const deps = { ...h.deps, senderMap: { load: async () => mapOf({}) } };

  await processIngestJob(whatsappJob, deps);

  const persisted = [...h.sink.persisted.values()][0];
  expect(persisted?.businessId).toBeNull();
  expect(h.sink.persisted.size).toBe(1);
});

test('a sender-map failure downgrades to Unrouted rather than failing the job', async () => {
  const h = harness();
  h.fetcher.put('media-1', { bytes: PNG });
  const deps = {
    ...h.deps,
    senderMap: {
      load: async (): Promise<ReadonlyMap<string, readonly string[]>> => {
        throw new Error('contacts unreachable');
      },
    },
  };

  await processIngestJob(whatsappJob, deps);

  expect(h.sink.persisted.size).toBe(1);
  expect([...h.sink.persisted.values()][0]?.businessId).toBeNull();
  expect(h.warns.some((w) => w.includes('sender-map load failed'))).toBe(true);
});

test('an env-unmapped receiving number resolves its practice from Practice.whatsappPhoneNumberId', async () => {
  const h = harness();
  h.fetcher.put('media-1', { bytes: PNG });
  const { practiceId: _dropped, ...unanchored } = whatsappJob;
  const deps = {
    ...h.deps,
    whatsAppPractices: {
      byPhoneNumberId: async (id: string) => (id === '123456789012345' ? 'prac_from_column' : null),
    },
  };

  await processIngestJob(unanchored, deps);

  expect([...h.sink.persisted.values()][0]?.practiceId).toBe('prac_from_column');
});

test('the env map WINS over the column — a controller-anchored job is not re-resolved', async () => {
  const h = harness();
  h.fetcher.put('media-1', { bytes: PNG });
  let asked = 0;
  const deps = {
    ...h.deps,
    whatsAppPractices: {
      byPhoneNumberId: async () => {
        asked += 1;
        return 'prac_other';
      },
    },
  };

  await processIngestJob(whatsappJob, deps);

  expect(asked).toBe(0);
  expect([...h.sink.persisted.values()][0]?.practiceId).toBe('prac_wa');
});

test('a number neither source names still dead-letters — the resolver is a fallback, not a net', async () => {
  const h = harness();
  h.fetcher.put('media-1', { bytes: PNG });
  const { practiceId: _dropped, ...unanchored } = whatsappJob;
  const deps = { ...h.deps, whatsAppPractices: { byPhoneNumberId: async () => null } };

  await expect(processIngestJob(unanchored, deps)).rejects.toThrow(TerminalJobError);
  expect(h.sink.persisted.size).toBe(0);
});

test('an email job is never re-anchored by the whatsapp resolvers', async () => {
  const h = harness();
  let asked = 0;
  const deps = {
    ...h.deps,
    senderMap: {
      load: async () => {
        asked += 1;
        return mapOf({ 'sender@acme.co': ['biz_email'] });
      },
    },
  };

  await processIngestJob(emailJob, deps);

  // The email lane routes in runEmailIntake, BEFORE the queue — re-deciding
  // here would be a second opinion on a decision already made.
  expect(asked).toBe(0);
  expect([...h.sink.persisted.values()][0]?.businessId).toBeNull();
});

/* ── the automatic match suggester (Phase 4) ───────────────────────────────── */

test('a routed, landed document runs the match suggester with its extracted header', async () => {
  const suggester = new RecordingMatchSuggester();
  const h = harness(READY_COMPLETION);
  await processIngestJob({ ...emailJob, routing: { kind: 'matched', businessId: 'biz_1' } }, { ...h.deps, matchSuggester: suggester });

  expect(suggester.runs).toHaveLength(1);
  const run = suggester.runs[0];
  expect(run?.businessId).toBe('biz_1');
  expect(run?.practiceId).toBe('prac_x');
  expect(run?.supplierName).toBe('Currys');
  expect(run?.totalPence).toBe(129_900);
});

test('an unrouted document runs no match suggestion — a suggestion needs a business', async () => {
  const suggester = new RecordingMatchSuggester();
  const h = harness({ ...READY_COMPLETION, businessId: null });
  await processIngestJob(emailJob, { ...h.deps, matchSuggester: suggester });
  expect(suggester.runs).toHaveLength(0);
});

test('a suggester failure is swallowed — the document and the job are safe', async () => {
  const h = harness(READY_COMPLETION);
  const deps = {
    ...h.deps,
    matchSuggester: {
      run: async () => {
        throw new Error('suggestion store unreachable');
      },
    },
  };
  await processIngestJob({ ...emailJob, routing: { kind: 'matched', businessId: 'biz_1' } }, deps);
  expect(h.warns.some((w) => w.includes('match-suggest'))).toBe(true);
  expect(h.sink.persisted.size).toBe(1);
});
