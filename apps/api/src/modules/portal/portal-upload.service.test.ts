import { createHash, randomUUID } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { PrismaClient } from '../../common/db/prisma.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../common/problem/problem.js';
import type { DocumentStore } from '../ingestion-routing/index.js';
import type { PortalSessionFacts } from './portal-session-context.js';
import { PortalSessionService } from './portal-session.service.js';
import type { PortalUploadIntent } from './portal-upload.port.js';
import { PrismaPortalUploadService } from './portal-upload.service.js';

/**
 * `POST /v1/portal/uploads` — the delegated upload intent (METH Stage 9).
 *
 * Offline: the store is a fake that records what it was asked to presign, and
 * Prisma is a stand-in whose `otp_sessions.update` behaves like the scalar-list
 * `push` the real grant uses. What these tests can prove is the branching, the
 * claims and the ORDER — that the grant is appended before the intent is handed
 * back, and that nothing is signed for a refused request. What only Postgres can
 * prove — that the grant is what makes the delegated write legal — is
 * `portal-delegated-upload.integration.test.ts`.
 */

const UPLOAD_SECRET = 'p9-upload-secret';
const BIZ = 'biz_burger';
const PRACTICE = 'prac_1';

const FACTS: PortalSessionFacts = {
  otpSessionId: 'otp_1',
  businessId: BIZ,
  practiceId: PRACTICE,
  systemUserId: 'usr_system_1',
  actorId: 'usr_system_1',
  contactId: null,
  chaseId: 'chase_1',
  grantedItemIds: [],
  expiresAt: new Date('2026-08-19T12:00:00.000Z'),
};

interface StoreCall {
  readonly key: string;
  readonly contentType: string;
  readonly byteSize: number;
}

/**
 * A `DocumentStore` that can only presign. The other five methods throw rather
 * than return something plausible: this lane never touches the bytes, so a test
 * that reached one of them would be testing a path that does not exist.
 */
function fakeStore(): { store: DocumentStore; presigned: StoreCall[] } {
  const presigned: StoreCall[] = [];
  const unreachable = (name: string) => (): never => {
    throw new Error(`portal upload must never call DocumentStore.${name}`);
  };
  return {
    presigned,
    store: {
      put: unreachable('put'),
      get: unreachable('get'),
      sha256: unreachable('sha256'),
      head: unreachable('head'),
      presignGet: unreachable('presignGet'),
      presignPut: async (input) => {
        presigned.push({ key: input.key, contentType: input.contentType, byteSize: input.byteSize });
        return { key: input.key, url: `https://fixture.local/${input.key}`, headers: { 'Content-Type': input.contentType } };
      },
    },
  };
}

interface Fixture {
  /** null simulates a business RLS does not return — the real policy does the same by returning no row. */
  readonly business: { id: string; practiceId: string | null; subscriptionStatus: string | null } | null;
  readonly grants: string[];
}

/** Enough Prisma for the business read and the grant write, and nothing else. */
function fakePrisma(fixture: Fixture): PrismaClient {
  const tx = {
    $executeRaw: async () => 0,
    business: { findUnique: async () => fixture.business },
    otpSession: {
      update: async ({ data }: { data: { grantedItemIds?: { push: string[] } } }) => {
        // The real column is a scalar list written with `push`, so appending is
        // what the fake has to model — a whole-array write would hide the very
        // clobbering `push` exists to prevent.
        fixture.grants.push(...(data.grantedItemIds?.push ?? []));
        return { id: FACTS.otpSessionId };
      },
    },
  };
  return { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
}

function harness(
  // Entitlement (D48) gates the portal intent too — the client is the payer,
  // so the surface the client uploads through is where the rule has to bite.
  business: { id: string; practiceId: string | null; subscriptionStatus: string | null } | null = {
    id: BIZ,
    practiceId: PRACTICE,
    subscriptionStatus: 'ACTIVE',
  },
): { service: PrismaPortalUploadService; presigned: StoreCall[]; grants: string[] } {
  const fixture: Fixture = { business, grants: [] };
  const prisma = fakePrisma(fixture);
  const { store, presigned } = fakeStore();
  const sessions = new PortalSessionService(prisma, {
    portalLinkSecret: 'link',
    portalSessionSecret: 'session',
    otpMode: 'demo',
  });
  const service = new PrismaPortalUploadService(prisma, store, sessions, new InMemoryIdempotencyStore(), {
    uploadSecret: UPLOAD_SECRET,
    uploadTtlSeconds: 900,
  });
  return { service, presigned, grants: fixture.grants };
}

function request(over: Partial<PortalUploadIntent> = {}): PortalUploadIntent {
  return { filename: 'currys-receipt.jpg', mimeType: 'image/jpeg', byteSize: 240_000, ...over };
}

/**
 * The claims inside the signed `uploadId`, read the way a reviewer would rather
 * than by calling the signer's own verifier — the point is what TRAVELS, and the
 * signature's acceptability is proven where it matters, by the real completion
 * path in the integration test.
 */
function claimsOf(uploadId: string): Record<string, unknown> {
  const payload = uploadId.slice(0, uploadId.indexOf('.'));
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function grab(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
    throw new Error('expected a rejection');
  } catch (error) {
    return error as AppException;
  }
}

test('the intent is presigned under the SESSION\'s business, on the client channel, with the practice from the business row', async () => {
  const { service, presigned } = harness();

  const intent = await service.createPortalUpload(FACTS, request(), randomUUID());

  expect(intent.upload.method).toBe('PUT');
  expect(intent.maxBytes).toBe(25 * 1024 * 1024); // SMS_PORTAL → the client cap, not the 100 MB accountant one
  expect(presigned).toHaveLength(1);
  // The IAM constraint (`<bucket>/w/*`) and the erasability argument, asserted:
  // the key names the business even though the caller never did.
  expect(presigned[0]?.key.startsWith(`w/${BIZ}/uploads/`)).toBe(true);
  expect(presigned[0]?.contentType).toBe('image/jpeg');

  expect(claimsOf(intent.uploadId)).toMatchObject({
    businessId: BIZ,
    practiceId: PRACTICE,
    channel: 'SMS_PORTAL',
    filename: 'currys-receipt.jpg',
    byteSize: 240_000,
    splitMode: 'SINGLE_DOCUMENT',
  });
});

test('THE CRUX: the derived document id is granted to the session before the intent is returned', async () => {
  const { service, grants } = harness();

  const intent = await service.createPortalUpload(FACTS, request(), randomUUID());

  // Exactly the id completion will derive from this token. Without it,
  // `documents_delegated_upload` (`id = ANY(app_granted_item_ids())`) refuses
  // both the write and the read back, and step two fails on a document that is
  // genuinely the client's.
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatch(/^doc_[0-9a-f]{24}$/);
  expect(grants[0]).toBe(derivedId(intent.uploadId));
});

test('a replayed Idempotency-Key returns the SAME intent and does not append the grant twice', async () => {
  const { service, presigned, grants } = harness();
  const key = randomUUID();

  const first = await service.createPortalUpload(FACTS, request(), key);
  const replay = await service.createPortalUpload(FACTS, request(), key);

  expect(replay).toEqual(first);
  // A second nonce would be a second key in the bucket and a second grant on the
  // session — a session's grant is the whole of what it may touch, so it must
  // not grow on a replay.
  expect(presigned).toHaveLength(1);
  expect(grants).toEqual([derivedId(first.uploadId)]);
});

test('the same key with a different payload is 409 NT-IDM-001, not a silently different intent', async () => {
  const { service } = harness();
  const key = randomUUID();
  await service.createPortalUpload(FACTS, request(), key);

  const err = await grab(() => service.createPortalUpload(FACTS, request({ filename: 'other.jpg' }), key));

  expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
  expect(err.code).toBe('NT-IDM-001');
});

test('two sessions reusing one Idempotency-Key get their OWN intent — the replay store is namespaced by session', async () => {
  const { service } = harness();
  const key = randomUUID();
  const other: PortalSessionFacts = { ...FACTS, otpSessionId: 'otp_2' };

  const mine = await service.createPortalUpload(FACTS, request(), key);
  const theirs = await service.createPortalUpload(other, request(), key);

  // Handing the second caller the first caller's intent would hand them a signed
  // token carrying the FIRST session's business — a cross-tenant leak through a
  // flat map keyed on a client-generated UUID.
  expect(theirs.uploadId).not.toBe(mine.uploadId);
});

test('an over-cap declared size is 413 NT-ING-001 and NOTHING is signed or granted', async () => {
  const { service, presigned, grants } = harness();

  const err = await grab(() => service.createPortalUpload(FACTS, request({ byteSize: 26 * 1024 * 1024 }), randomUUID()));

  expect(err.getStatus()).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
  expect(err.code).toBe('NT-ING-001');
  expect(presigned).toHaveLength(0);
  expect(grants).toHaveLength(0);
});

test('a MIME off the allowlist is 415 NT-ING-002, and the response names the field without echoing the value', async () => {
  const { service, presigned } = harness();

  const err = await grab(() => service.createPortalUpload(FACTS, request({ mimeType: 'application/x-msdownload' }), randomUUID()));

  expect(err.getStatus()).toBe(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
  expect(err.code).toBe('NT-ING-002');
  expect(err.fieldErrors?.map((e) => e.field)).toEqual(['mimeType']);
  expect(JSON.stringify(err.fieldErrors)).not.toContain('msdownload');
  expect(presigned).toHaveLength(0);
});

test('a fractional byteSize is 400 — the generated schema is .min(1), NOT .int()', async () => {
  const { service, presigned } = harness();

  // `zod.number().min(1)` passes 1.5 straight through the boundary, and it would
  // go into the presigned content-length and the `byte_size` column.
  const err = await grab(() => service.createPortalUpload(FACTS, request({ byteSize: 1.5 }), randomUUID()));

  expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
  expect(err.code).toBe('NT-VAL-001');
  expect(presigned).toHaveLength(0);
});

test('a session whose business is no longer reachable is 401 NT-OTP-002, and nothing is signed', async () => {
  const { service, presigned, grants } = harness(null);

  const err = await grab(() => service.createPortalUpload(FACTS, request(), randomUUID()));

  expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  expect(err.code).toBe('NT-OTP-002');
  expect(presigned).toHaveLength(0);
  expect(grants).toHaveLength(0);
});

test('ENTITLEMENT: a lapsed client business is 402 NT-BIL-001, and nothing is signed or granted', async () => {
  // D48 charges the CLIENT, so the surface the client uploads through is where
  // the rule has to bite — gating only the accountant's own upload would leave
  // the main ID path open. (The contract declares no 402 on this operation; the
  // drift is flagged in `portal-upload.service.ts` and belongs to a contract
  // change, not to this stage.)
  const { service, presigned, grants } = harness({ id: BIZ, practiceId: PRACTICE, subscriptionStatus: 'PAST_DUE' });

  const err = await grab(() => service.createPortalUpload(FACTS, request(), randomUUID()));

  expect(err.code).toBe('NT-BIL-001');
  expect(err.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
  expect(presigned).toHaveLength(0);
  expect(grants).toHaveLength(0);
});

test('the chased transaction the client picked travels in the claims — a hint, recorded, never dropped', async () => {
  const { service } = harness();

  const picked = await service.createPortalUpload(FACTS, request({ transactionId: 'txn_currys' }), randomUUID());
  const none = await service.createPortalUpload(FACTS, request({ transactionId: null }), randomUUID());

  expect(claimsOf(picked.uploadId)).toMatchObject({ chaseTransactionId: 'txn_currys' });
  // Null is "let extraction decide" (the contract's words), so the claim is
  // absent rather than a null nobody can tell from a bug.
  expect(claimsOf(none.uploadId)).not.toHaveProperty('chaseTransactionId');
});

/**
 * `documentIdFor`, restated in the test rather than imported, so the test pins
 * the VALUE the grant has to be and not merely "whatever that function returns".
 * If ingestion-routing changes the derivation, completion changes with it and
 * this test is the thing that notices the grant no longer matches.
 */
function derivedId(uploadId: string): string {
  return `doc_${createHash('sha256').update(uploadId).digest('hex').slice(0, 24)}`;
}

test('the client\'s note becomes the document\'s NAME — keeping the real extension the statement lane reads (review item 11)', async () => {
  const { service } = harness();

  const named = await service.createPortalUpload(FACTS, request({ note: 'July fuel receipt' }), randomUUID());

  // The display half: IMG-style names give way to the client's own words, with
  // the declared extension kept — `formatFor` picks the CSV/XLSX reader off the
  // filename, so a renamed statement must still read as one.
  // The record half: the unedited note rides beside it, so completion can put
  // what the client SAID on the provenance event.
  expect(claimsOf(named.uploadId)).toMatchObject({
    filename: 'July fuel receipt.jpg',
    portalNote: 'July fuel receipt',
  });
});

test('no note changes nothing — the declared filename travels exactly as before', async () => {
  const { service } = harness();

  const plain = await service.createPortalUpload(FACTS, request(), randomUUID());
  const explicitNull = await service.createPortalUpload(FACTS, request({ note: null }), randomUUID());

  expect(claimsOf(plain.uploadId)).toMatchObject({ filename: 'currys-receipt.jpg' });
  expect(claimsOf(plain.uploadId)).not.toHaveProperty('portalNote');
  expect(claimsOf(explicitNull.uploadId)).toMatchObject({ filename: 'currys-receipt.jpg' });
  expect(claimsOf(explicitNull.uploadId)).not.toHaveProperty('portalNote');
});

test('a note that survives sanitisation as nothing falls back to the declared filename — a rename must never cost the upload', async () => {
  const { service } = harness();

  const blank = await service.createPortalUpload(FACTS, request({ note: '   ' }), randomUUID());
  const separatorsOnly = await service.createPortalUpload(FACTS, request({ note: '///\\' }), randomUUID());

  expect(claimsOf(blank.uploadId)).toMatchObject({ filename: 'currys-receipt.jpg' });
  expect(claimsOf(separatorsOnly.uploadId)).toMatchObject({ filename: 'currys-receipt.jpg' });
});

test('path separators in a note are stripped from the NAME and kept verbatim in the RECORD', async () => {
  const { service } = harness();

  const hostile = await service.createPortalUpload(FACTS, request({ note: '../secret/name' }), randomUUID());

  const claims = claimsOf(hostile.uploadId);
  // The filename carries no separator a downstream path-join could obey…
  expect(String(claims['filename'])).not.toMatch(/[\/]/);
  expect(String(claims['filename']).endsWith('.jpg')).toBe(true);
  // …while the provenance record keeps the client's words unedited, as data.
  expect(claims['portalNote']).toBe('../secret/name');
});
