import { createHash } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { Document as DocumentRow } from '@prisma/client';

import type { DocumentUploadRequest } from '@neoting/contracts/model';

import type { PrismaClient } from '../../../common/db/prisma.js';
import { type ScopeContext, ScopeContextSchema } from '../../../common/db/scope-context.js';
import { AppException } from '../../../common/problem/problem.js';
import { InMemoryDocumentStore } from '../storage/document-store.js';
import { FixtureIngestQueue } from '../webhooks/whatsapp/ingest-queue.js';
import { InMemoryIdempotencyStore } from '../../../common/idempotency/idempotency-store.js';
import { signUploadToken, type UploadClaims, verifyUploadToken } from './upload-token.js';
import { WebUploadService } from './web-upload.service.js';

const SECRET = 'svc-secret';
const CTX: ScopeContext = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });

/**
 * The columns Postgres fills in that `persistDocument` never writes. They are
 * here only because `toDocumentResponse` reads every one of them, and calls
 * `.toISOString()` on the three `Date`s — a row without them throws before the
 * assertion under test is reached. Fixed instants, so a response can be compared
 * with `toEqual` across two calls.
 */
const NOW = new Date('2026-08-16T09:00:00.000Z');
const DOCUMENT_DEFAULTS = {
  docType: null, supplierName: null, customerName: null, documentDate: null, dueDate: null,
  currency: null, totalPence: null, taxPence: null, reference: null, categoryCode: null,
  description: null, projectRef: null, parentDocumentId: null, failureCode: null,
  failureMessage: null, archivedAt: null, deletedAt: null, perceptualHash: null, submitterLabel: null,
  receivedLocal: null, routingDecision: null, routingConfidence: null, pageRange: null,
  receivedAt: NOW, createdAt: NOW, updatedAt: NOW,
};

/**
 * A Prisma stand-in for the reads these tests reach: the business reachability
 * lookup in `createUpload`, and a documents map just real enough to make
 * `persistDocument`'s derived-id idempotency observable — a second completion of
 * the same intent has to *find* a row for `created: false` to mean anything.
 *
 * `business === null` simulates a business RLS does not let this caller see —
 * the real policy does the same thing by returning no row, so the service branch
 * under test is identical. What Postgres does with the *write* (the WITH CHECK,
 * the real unique violation) is the integration test's job, not this file's.
 */
function fakePrisma(business: { id: string; practiceId: string | null } | null): PrismaClient {
  const documents = new Map<string, DocumentRow>();
  const tx = {
    $executeRaw: async () => 0,
    business: { findUnique: async () => business },
    document: {
      findUnique: async ({ where }: { where: { id: string } }) => documents.get(where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> & { id: string } }) => {
        const row = { ...DOCUMENT_DEFAULTS, ...data } as unknown as DocumentRow;
        documents.set(data.id, row);
        return row;
      },
    },
    documentEvent: { create: async () => ({}) },
  };
  return { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
}

function harness(
  // `subscriptionStatus` is part of the fixture because `createUpload` now
  // gates on it (D48 entitlement). ACTIVE is the ordinary case; the refusal
  // has its own test below.
  business: { id: string; practiceId: string | null; subscriptionStatus: string | null } | null = {
    id: 'biz_1',
    practiceId: 'prac_1',
    subscriptionStatus: 'ACTIVE',
  },
): { store: InMemoryDocumentStore; queue: FixtureIngestQueue; service: WebUploadService } {
  const store = new InMemoryDocumentStore();
  const queue = new FixtureIngestQueue();
  const service = new WebUploadService(fakePrisma(business), store, queue, new InMemoryIdempotencyStore(), {
    uploadSecret: SECRET,
    uploadTtlSeconds: 900,
  });
  return { store, queue, service };
}

function request(over: Partial<DocumentUploadRequest> = {}): DocumentUploadRequest {
  return { businessId: 'biz_1', channel: 'WEB_UPLOAD', filename: 'batch.pdf', mimeType: 'application/pdf', byteSize: 2048, ...over };
}

async function grab(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

test('createUpload presigns a PUT and returns a verifiable signed uploadId', async () => {
  const { service } = harness();
  const result = await service.createUpload(CTX, request());
  expect(result.upload.method).toBe('PUT');
  expect(result.maxBytes).toBe(100 * 1024 * 1024); // WEB_UPLOAD → accountant cap
  const verified = verifyUploadToken(result.uploadId, SECRET);
  expect(verified.ok).toBe(true);
  if (verified.ok) {
    expect(verified.claims.businessId).toBe('biz_1');
    expect(verified.claims.s3Key.startsWith('w/biz_1/uploads/')).toBe(true);
  }
});

test('createUpload rejects an over-cap declared size with 413 NT-ING-001', async () => {
  const { service } = harness();
  const err = await grab(() => service.createUpload(CTX, request({ byteSize: 200 * 1024 * 1024 })));
  expect((err as AppException).getStatus()).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
  expect((err as AppException).code).toBe('NT-ING-001');
});

test('createUpload rejects a MIME off the allowlist with 415 NT-ING-002', async () => {
  const { service } = harness();
  const err = await grab(() => service.createUpload(CTX, request({ mimeType: 'application/x-msdownload' })));
  expect((err as AppException).getStatus()).toBe(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
  expect((err as AppException).code).toBe('NT-ING-002');
});

test('a business the caller cannot reach is 404 and nothing is signed', async () => {
  // The tenancy guard on the presign path: RLS returns no row, so no URL into
  // that business's S3 prefix is ever minted. 404, not 403 — a 403 would confirm
  // the business exists.
  const { service } = harness(null);
  const err = await grab(() => service.createUpload(CTX, request()));
  expect((err as AppException).getStatus()).toBe(HttpStatus.NOT_FOUND);
});

test('ENTITLEMENT: a lapsed business is 402 NT-BIL-001 and nothing is signed', async () => {
  // D48. Checked AFTER reachability, so a caller cannot learn whether a business
  // they cannot see is paying, and BEFORE a URL exists, so no bytes reach storage
  // for a workspace that will not accept them. Reading, reviewing, approving and
  // exporting are untouched — the line is that a lapsed client stops ADDING.
  const { service } = harness({ id: 'biz_1', practiceId: 'prac_1', subscriptionStatus: 'CANCELED' });
  const err = await grab(() => service.createUpload(CTX, request()));
  expect((err as AppException).code).toBe('NT-BIL-001');
  expect((err as AppException).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
});

test('ENTITLEMENT: a business that has never subscribed is refused the same way', async () => {
  const { service } = harness({ id: 'biz_1', practiceId: 'prac_1', subscriptionStatus: null });
  const err = await grab(() => service.createUpload(CTX, request()));
  expect((err as AppException).code).toBe('NT-BIL-001');
});

test('the practice anchor comes from the business row, not the caller context', async () => {
  // A business-level actor has no practiceId in scope; the document must still
  // be anchored on the business's own practice.
  const { service } = harness({ id: 'biz_1', practiceId: 'prac_owner', subscriptionStatus: 'ACTIVE' });
  const ctx = ScopeContextSchema.parse({ actorId: 'usr_1', businessId: 'biz_1' });
  const result = await service.createUpload(ctx, request());
  const verified = verifyUploadToken(result.uploadId, SECRET);
  expect(verified.ok && verified.claims.practiceId).toBe('prac_owner');
});

test('Idempotency-Key: same key + payload replays; same key + different payload is 409 NT-IDM-001', async () => {
  const { service } = harness();
  const first = await service.createUpload(CTX, request(), 'key-1');
  const replay = await service.createUpload(CTX, request(), 'key-1');
  expect(replay).toEqual(first); // no second intent, original response returned

  const err = await grab(() => service.createUpload(CTX, request({ filename: 'other.pdf' }), 'key-1'));
  expect((err as AppException).code).toBe('NT-IDM-001');
});

// ---- completeUpload validation branches (happy path is the integration test) ----

function tokenFor(store: InMemoryDocumentStore, bytes: Buffer, expiresAtMs: number): string {
  const key = 'w/biz_1/uploads/fixed';
  store.putRaw(key, bytes);
  const claims: UploadClaims = {
    businessId: 'biz_1', practiceId: 'prac_1', channel: 'WEB_UPLOAD', filename: 'r.pdf',
    mimeType: 'application/pdf', byteSize: bytes.length, splitMode: 'AUTO_SPLIT', s3Key: key, expiresAtMs,
  };
  return signUploadToken(claims, SECRET);
}

test('completeUpload refuses an expired intent with 410 NT-ING-005', async () => {
  const { store, service } = harness();
  const bytes = Buffer.from('hello');
  const token = tokenFor(store, bytes, Date.now() - 1000);
  const err = await grab(() => service.completeUpload(CTX, token, createHash('sha256').update(bytes).digest('hex')));
  expect((err as AppException).getStatus()).toBe(HttpStatus.GONE);
  expect((err as AppException).code).toBe('NT-ING-005');
});

test('completeUpload rejects a forged uploadId with 400', async () => {
  const { service } = harness();
  const err = await grab(() => service.completeUpload(CTX, 'forged.token', 'a'.repeat(64)));
  expect((err as AppException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
});

test('completeUpload is 404 when nothing landed at the key', async () => {
  const { service } = harness();
  // A valid, unexpired token whose object was never PUT (the store is empty).
  const token = signUploadToken(
    { businessId: 'biz_1', practiceId: 'prac_1', channel: 'WEB_UPLOAD', filename: 'r.pdf', mimeType: 'application/pdf', byteSize: 5, splitMode: 'AUTO_SPLIT', s3Key: 'w/biz_1/uploads/missing', expiresAtMs: Date.now() + 60_000 },
    SECRET,
  );
  const err = await grab(() => service.completeUpload(CTX, token, 'a'.repeat(64)));
  expect((err as AppException).getStatus()).toBe(HttpStatus.NOT_FOUND);
});

test('completeUpload is 409 NT-ING-003 when the landed bytes do not match the declared hash', async () => {
  const { store, service } = harness();
  const token = tokenFor(store, Buffer.from('actual-bytes'), Date.now() + 60_000);
  const err = await grab(() => service.completeUpload(CTX, token, 'b'.repeat(64)));
  expect((err as AppException).getStatus()).toBe(HttpStatus.CONFLICT);
  expect((err as AppException).code).toBe('NT-ING-003');
});

test('completeUpload is 409 NT-ING-003 when the landed size differs from the declared one — even with a matching hash', async () => {
  // The size comes from the HEAD that already ran, so this fires before the
  // hash pass reads a single byte. Declaring the hash of what actually LANDED
  // is the point of the test: the declaration is checked against the claims the
  // intent signed, not only against a digest.
  const { store, service } = harness();
  const token = tokenFor(store, Buffer.from('the-declared-bytes'), Date.now() + 60_000);
  const landed = Buffer.from('something-else-entirely-and-longer');
  store.putRaw('w/biz_1/uploads/fixed', landed); // replaced behind the intent's back
  const err = await grab(() =>
    service.completeUpload(CTX, token, createHash('sha256').update(landed).digest('hex')),
  );
  expect((err as AppException).getStatus()).toBe(HttpStatus.CONFLICT);
  expect((err as AppException).code).toBe('NT-ING-003');
});

test('completeUpload never materialises the object — the hash is streamed by the store, not get()', async () => {
  // REGRESSION. Completion used to `get()` the whole object into one Buffer to
  // hash it — up to the 100 MB channel cap per in-flight request, in the API
  // process, which is the exact weight the presigned two-step exists to keep
  // off the request path. The store hashes it now; `get()` must not be called.
  const { store, queue, service } = harness();
  const bytes = Buffer.from('streamed-not-buffered');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const token = tokenFor(store, bytes, Date.now() + 60_000);
  store.get = async () => {
    throw new Error('completeUpload called store.get() — it must hash via store.sha256() instead');
  };
  const doc = await service.completeUpload(CTX, token, hash);
  expect(doc.state).toBe('RECEIVED');
  expect(queue.enqueued).toHaveLength(1);
});

test('a second completion of the same intent returns the same document and does not re-enqueue', async () => {
  // The `created` gate. Both calls pass NO Idempotency-Key, so the replay store
  // cannot short-circuit the second one — it runs the whole path and is stopped
  // only by `persistDocument` finding the row under the id derived from the
  // uploadId. That is the durable guarantee; the in-memory store is not.
  //
  // Re-enqueuing is not harmless: `BullmqIngestQueue` sets `removeOnComplete`,
  // so its jobId dedupe expires the moment the first job finishes, and a second
  // job would be accepted and sanitise the document twice.
  const { store, queue, service } = harness();
  const bytes = Buffer.from('same-bytes');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const token = tokenFor(store, bytes, Date.now() + 60_000);

  const first = await service.completeUpload(CTX, token, hash);
  const second = await service.completeUpload(CTX, token, hash);

  expect(second.id).toBe(first.id); // one document, not two
  expect(second).toEqual(first);
  expect(queue.enqueued).toHaveLength(1); // and one sanitisation job
});

test('completeUpload: same Idempotency-Key + different payload is 409 NT-IDM-001', async () => {
  const { store, queue, service } = harness();
  const bytes = Buffer.from('same-bytes');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const token = tokenFor(store, bytes, Date.now() + 60_000);

  const first = await service.completeUpload(CTX, token, hash, 'key-c');
  expect(await service.completeUpload(CTX, token, hash, 'key-c')).toEqual(first); // replay

  // Same key, a different declared hash. The replay guard runs BEFORE the token
  // is verified, so this conflict is NT-IDM-001 and not the NT-ING-003 the same
  // wrong hash would produce without the key — both are 409, and only the code
  // tells the caller whether to fix their hash or their key.
  const err = await grab(() => service.completeUpload(CTX, token, 'c'.repeat(64), 'key-c'));
  expect((err as AppException).getStatus()).toBe(HttpStatus.CONFLICT);
  expect((err as AppException).code).toBe('NT-IDM-001');
  expect(queue.enqueued).toHaveLength(1); // neither the replay nor the conflict enqueued
});
