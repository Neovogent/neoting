import { expect, test } from 'vitest';

import type { PerceptualHasher } from '../lib/dedupe/perceptual-hash.js';
import { type DocumentStore, type DocumentStorePutInput, InMemoryDocumentStore } from '../storage/document-store.js';
import { FixtureMediaFetcher, MediaFetchError } from './media-fetcher.js';
import { fetchWhatsAppMedia } from './whatsapp-media-intake.js';

/** A PNG signature is all the magic-byte sniffer reads, and the fixture
 *  normaliser is a passthrough — so these ARE valid PNG bytes for this pipeline. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);

const PRACTICE = 'prac_wa';

/** A DocumentStore that also records every put, so a test can prove nothing was
 *  stored on a rejection while still reading bytes back on the happy path. */
function recordingStore(): { store: DocumentStore; puts: DocumentStorePutInput[] } {
  const inner = new InMemoryDocumentStore();
  const puts: DocumentStorePutInput[] = [];
  return {
    puts,
    store: {
      async put(input) {
        puts.push(input);
        return inner.put(input);
      },
      get: (key) => inner.get(key),
      sha256: (key) => inner.sha256(key),
      presignPut: (input) => inner.presignPut(input),
      presignGet: (input) => inner.presignGet(input),
      head: (key) => inner.head(key),
    },
  };
}

test('fetches, sanitises and stores an unrouted image — bytes in the store before the key is returned', async () => {
  const fetcher = new FixtureMediaFetcher();
  fetcher.put('m1', { bytes: PNG });
  const { store, puts } = recordingStore();

  const outcome = await fetchWhatsAppMedia({ mediaId: 'm1', practiceId: PRACTICE, businessId: null }, { fetcher, store });

  if (!outcome.ok) throw new Error(`expected ok, got rejection ${outcome.rejection.code}`);
  const doc = outcome.document;
  expect(doc.mimeType).toBe('image/png');
  expect(doc.byteSize).toBe(PNG.length);
  // Unrouted → partitioned BY PRACTICE, never a shared prefix (GDPR erasure).
  expect(doc.storageKey).toBe(`w/_unrouted/${PRACTICE}/documents/${doc.sha256}`);
  // The object exists BEFORE the caller sees the key — a documents row must never
  // point at bytes that are not there yet.
  await expect(store.get(doc.storageKey)).resolves.toEqual(PNG);
  expect(puts).toHaveLength(1);
});

test('a routed image keys under its business, not the unrouted prefix', async () => {
  const fetcher = new FixtureMediaFetcher();
  fetcher.put('m1', { bytes: PNG });
  const { store } = recordingStore();

  const outcome = await fetchWhatsAppMedia({ mediaId: 'm1', practiceId: PRACTICE, businessId: 'biz_1' }, { fetcher, store });
  if (!outcome.ok) throw new Error('expected ok');
  expect(outcome.document.storageKey).toBe(`w/biz_1/documents/${outcome.document.sha256}`);
});

test('synthesises a filename from the DETECTED type, ignoring a lying declared mime', async () => {
  // A WhatsApp image arrives with no filename and documents.original_filename is
  // NOT NULL, so one is synthesised. The declared mime is a sender/Meta claim —
  // seed it as a lie and prove the type decision still comes from the bytes.
  const fetcher = new FixtureMediaFetcher();
  fetcher.put('m1', { bytes: PNG, declaredMimeType: 'application/pdf' });
  const { store } = recordingStore();

  const outcome = await fetchWhatsAppMedia({ mediaId: 'm1', practiceId: PRACTICE, businessId: null }, { fetcher, store });
  if (!outcome.ok) throw new Error('expected ok');
  expect(outcome.document.mimeType).toBe('image/png');
  expect(outcome.document.filename).toBe(`whatsapp-${outcome.document.sha256.slice(0, 12)}.png`);
});

test('a supplied filename is used but reduced to a basename; an empty one falls back to synthesis', async () => {
  const fetcher = new FixtureMediaFetcher();
  fetcher.put('m1', { bytes: PNG });
  const { store } = recordingStore();

  const named = await fetchWhatsAppMedia(
    { mediaId: 'm1', practiceId: PRACTICE, businessId: null, filename: '../../etc/passwd' },
    { fetcher, store },
  );
  if (!named.ok) throw new Error('expected ok');
  expect(named.document.filename).toBe('passwd');

  const blank = await fetchWhatsAppMedia(
    { mediaId: 'm1', practiceId: PRACTICE, businessId: null, filename: '' },
    { fetcher, store },
  );
  if (!blank.ok) throw new Error('expected ok');
  expect(blank.document.filename).toBe(`whatsapp-${blank.document.sha256.slice(0, 12)}.png`);
});

test('the supplied filename never sways the type — a .pdf name on png bytes stays image/png', async () => {
  const fetcher = new FixtureMediaFetcher();
  fetcher.put('m1', { bytes: PNG });
  const { store } = recordingStore();

  const outcome = await fetchWhatsAppMedia(
    { mediaId: 'm1', practiceId: PRACTICE, businessId: null, filename: 'invoice.pdf' },
    { fetcher, store },
  );
  if (!outcome.ok) throw new Error('expected ok');
  expect(outcome.document.filename).toBe('invoice.pdf'); // kept for display
  expect(outcome.document.mimeType).toBe('image/png'); // decided by the bytes
});

test('the perceptual hash is computed from the sanitised bytes in hand, not re-read from storage', async () => {
  const fetcher = new FixtureMediaFetcher();
  fetcher.put('m1', { bytes: PNG });
  const { store } = recordingStore();
  const hashed: Buffer[] = [];
  const perceptualHasher: PerceptualHasher = {
    async hash(bytes: Buffer) {
      hashed.push(bytes);
      return 'a'.repeat(16);
    },
  };

  const outcome = await fetchWhatsAppMedia(
    { mediaId: 'm1', practiceId: PRACTICE, businessId: null },
    { fetcher, store, perceptualHasher },
  );
  if (!outcome.ok) throw new Error('expected ok');
  expect(hashed).toEqual([PNG]); // the bytes we already held, not a round trip to S3
  expect(outcome.document.perceptualHash).toBe('a'.repeat(16));
});

test('with no hasher injected the perceptual hash is null — the lane stays pure', async () => {
  const fetcher = new FixtureMediaFetcher();
  fetcher.put('m1', { bytes: PNG });
  const { store } = recordingStore();
  const outcome = await fetchWhatsAppMedia({ mediaId: 'm1', practiceId: PRACTICE, businessId: null }, { fetcher, store });
  if (!outcome.ok) throw new Error('expected ok');
  expect(outcome.document.perceptualHash).toBeNull();
});

test('a sanitisation refusal returns the rejection and stores nothing', async () => {
  const fetcher = new FixtureMediaFetcher();
  fetcher.put('m1', { bytes: Buffer.from('this is not any accepted format') });
  const { store, puts } = recordingStore();

  const outcome = await fetchWhatsAppMedia({ mediaId: 'm1', practiceId: PRACTICE, businessId: null }, { fetcher, store });

  if (outcome.ok) throw new Error('expected a rejection');
  expect(outcome.rejection.code).toBe('NT-ING-002'); // type_not_allowed
  expect(puts).toHaveLength(0); // nothing reached the store
});

test('a fetch failure PROPAGATES as a thrown MediaFetchError, never a rejection', async () => {
  // A rejection is a decision about the document; a fetch failure is the world
  // being unavailable, and only the caller (the worker) knows whether that is a
  // retry or a dead-letter. So it must throw, not return { ok: false }.
  const fetcher = new FixtureMediaFetcher();
  fetcher.failWith('m1', new MediaFetchError('upstream', 'Meta Graph returned 503', 503));
  const { store, puts } = recordingStore();

  await expect(
    fetchWhatsAppMedia({ mediaId: 'm1', practiceId: PRACTICE, businessId: null }, { fetcher, store }),
  ).rejects.toBeInstanceOf(MediaFetchError);
  expect(puts).toHaveLength(0);
});

test('a HEIC arriving by WhatsApp is stored as image/jpeg — the label describes the OUTPUT bytes', async () => {
  // REGRESSION (the #79 latent mismatch, fixed 1 Sep 2026). The pipeline's
  // `detectedType` describes the INPUT and step 5 re-encodes images — so a
  // HEIC came back labelled `heic` carrying JPEG bytes, and the stored object
  // wore `image/heic`, recreating NT-EXT-003 on the exact format the
  // normaliser exists to fix. `effectiveFormat` re-sniffs the stored bytes.
  const HEIC = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypheic'),
    Buffer.alloc(16),
  ]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

  const fetcher = new FixtureMediaFetcher();
  fetcher.put('m-heic', { bytes: HEIC });
  const { store, puts } = recordingStore();

  const outcome = await fetchWhatsAppMedia(
    { mediaId: 'm-heic', practiceId: PRACTICE, businessId: null },
    {
      fetcher,
      store,
      // What the real sharp normaliser does to a HEIC, in one line: JPEG out.
      imageNormaliser: { normalise: async () => ({ ok: true, bytes: JPEG }) },
    },
  );

  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.document.mimeType).toBe('image/jpeg');
  expect(outcome.document.filename.endsWith('.jpeg')).toBe(true);
  expect(puts[0]?.contentType).toBe('image/jpeg');
});
