import { createHash } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { DocumentUploadRequest } from '@neoting/contracts/model';

import type { PrismaClient } from '../../../common/db/prisma.js';
import { type ScopeContext, ScopeContextSchema } from '../../../common/db/scope-context.js';
import { AppException } from '../../../common/problem/problem.js';
import { InMemoryDocumentStore } from '../storage/document-store.js';
import { FixtureIngestQueue } from '../webhooks/whatsapp/ingest-queue.js';
import { InMemoryIdempotencyStore } from './idempotency-store.js';
import { signUploadToken, type UploadClaims, verifyUploadToken } from './upload-token.js';
import { WebUploadService } from './web-upload.service.js';

const SECRET = 'svc-secret';
const CTX: ScopeContext = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });

/**
 * A Prisma stand-in for the two reads these tests reach: the business
 * reachability lookup in `createUpload`, and nothing else. `business === null`
 * simulates a business RLS does not let this caller see — the real policy does
 * the same thing by returning no row, so the service branch under test is
 * identical. The persist path is the integration test's job, not this file's.
 */
function fakePrisma(business: { id: string; practiceId: string | null } | null): PrismaClient {
  const tx = {
    $executeRaw: async () => 0,
    business: { findUnique: async () => business },
  };
  return { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
}

function harness(
  business: { id: string; practiceId: string | null } | null = { id: 'biz_1', practiceId: 'prac_1' },
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

test('the practice anchor comes from the business row, not the caller context', async () => {
  // A business-level actor has no practiceId in scope; the document must still
  // be anchored on the business's own practice.
  const { service } = harness({ id: 'biz_1', practiceId: 'prac_owner' });
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
