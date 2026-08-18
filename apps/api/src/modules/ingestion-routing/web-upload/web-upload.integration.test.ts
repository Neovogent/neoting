import { createHash, randomUUID } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import type { AppException } from '../../../common/problem/problem.js';
import type { DocumentStore } from '../storage/document-store.js';
import { createS3Client, S3DocumentStore } from '../storage/s3-document-store.js';
import { FixtureIngestQueue } from '../webhooks/whatsapp/ingest-queue.js';
import { InMemoryIdempotencyStore } from '../../../common/idempotency/idempotency-store.js';
import { WebUploadService } from './web-upload.service.js';

/**
 * The #76 acceptance, and the only test that can be it: **intent → a real PUT to
 * the presigned URL → complete**, against a real database and a real object
 * store.
 *
 * Every unit test in this lane hands the service an `InMemoryDocumentStore`
 * whose `presignPut` returns `https://fixture.local/...` — a URL nothing ever
 * fetches. That proves the branching and proves nothing about the signature. The
 * two failures this catches are exactly the ones that only appear against real
 * infrastructure:
 *
 * 1. **The presigned PUT is rejected.** `S3DocumentStore.presignPut` folds
 *    `content-type` and `content-length` into the signature. If the headers we
 *    hand the client are not the headers the signature covers, the browser's PUT
 *    is a 403 and the upload never happens — with the API reporting success.
 * 2. **The document does not land under RLS.** The row is business-anchored and
 *    written from a practice context; `documents_tenant`'s WITH CHECK is the
 *    thing deciding whether that is allowed, and no fake can answer for it.
 *
 * Gated so `pnpm test` stays offline (issue #16's rule). Needs both:
 *
 *   docker compose up -d && pnpm db:migrate && pnpm db:seed
 *   RUN_S3_INTEGRATION=1 pnpm --filter @neoting/api test
 *
 * Skipped visibly when unconfigured; `beforeAll` throws (red run) when it IS
 * configured but the database or MinIO is unreachable. A suite that quietly
 * reports green while proving nothing is worse than no suite, because it is
 * trusted.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const S3_ENABLED = process.env['RUN_S3_INTEGRATION'] === '1';
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined && S3_ENABLED;

const P_A = 'p76_prac_a';
const P_B = 'p76_prac_b';
const BIZ_A = 'p76_biz_a';
const BIZ_B = 'p76_biz_b';
const SECRET = 'p76-upload-secret';

let owner: PrismaClient;
let app: PrismaClient;
let store: S3DocumentStore;

const CTX_A = ScopeContextSchema.parse({ actorId: 'p76_user_a', practiceId: P_A });

async function cleanup(): Promise<void> {
  // `DocumentEvent.document` is `onDelete: Cascade`, so the events go with the rows.
  await owner.document.deleteMany({ where: { practiceId: { in: [P_A, P_B] } } });
  await owner.business.deleteMany({ where: { id: { startsWith: 'p76_' } } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 'p76_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 'p76_' } } });
  await owner.practice.deleteMany({ where: { id: { startsWith: 'p76_' } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`; // configured-but-unreachable → throw, not skip

  store = new S3DocumentStore(
    createS3Client({
      S3_REGION: 'eu-west-2',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_FORCE_PATH_STYLE: true,
      S3_ACCESS_KEY_ID: process.env['S3_ACCESS_KEY_ID'] ?? 'neoting',
      S3_SECRET_ACCESS_KEY: process.env['S3_SECRET_ACCESS_KEY'] ?? 'neoting123',
    }),
    process.env['S3_BUCKET_DOCUMENTS'] ?? 'nt-local-docs',
  );
  // Same reasoning as the SELECT 1 above, for MinIO. A missing object is `null`;
  // a missing MinIO throws, and this is where that should surface.
  await store.head('w/p76/probe-that-does-not-exist');

  await cleanup();
  await owner.practice.createMany({ data: [{ id: P_A, name: 'P76 A' }, { id: P_B, name: 'P76 B' }] });
  await owner.user.createMany({
    data: [
      { id: 'p76_user_a', email: 'p76a@example.test' },
      { id: 'p76_user_b', email: 'p76b@example.test' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 'p76_mem_a', userId: 'p76_user_a', practiceId: P_A, role: 'PRACTICE_ADMIN' },
      { id: 'p76_mem_b', userId: 'p76_user_b', practiceId: P_B, role: 'PRACTICE_ADMIN' },
    ],
  });
  await owner.business.createMany({
    data: [
      { id: BIZ_A, practiceId: P_A, name: 'P76 Client A' },
      { id: BIZ_B, practiceId: P_B, name: 'P76 Client B' },
    ],
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

function makeService(documentStore: DocumentStore = store): { service: WebUploadService; queue: FixtureIngestQueue } {
  // The queue stays a fixture on purpose: this test is about the HTTP/storage/DB
  // path, and asserting on `queue.enqueued` proves the handoff without making
  // Redis a second reason for the suite to be red.
  const queue = new FixtureIngestQueue();
  const service = new WebUploadService(app, documentStore, queue, new InMemoryIdempotencyStore(), {
    uploadSecret: SECRET,
    uploadTtlSeconds: 900,
  });
  return { service, queue };
}

/**
 * The real store, wrapped to count `presignPut`. Delegation is written out rather
 * than spread because `S3DocumentStore` is a class and its methods live on the
 * prototype, which `{ ...store }` would not copy.
 *
 * This is what lets the cross-tenant test assert the NEGATIVE its name claims.
 * Without it the test proves only that the call threw 404 — and a refactor that
 * moved the presign above the RLS lookup would still mint a URL into another
 * practice's prefix and still pass.
 */
function countingStore(inner: DocumentStore): { store: DocumentStore; presignPutCalls: () => number } {
  let calls = 0;
  return {
    presignPutCalls: () => calls,
    store: {
      put: (input) => inner.put(input),
      get: (key) => inner.get(key),
      sha256: (key) => inner.sha256(key),
      head: (key) => inner.head(key),
      presignPut: (input) => {
        calls += 1;
        return inner.presignPut(input);
      },
      presignGet: (input) => inner.presignGet(input),
    },
  };
}

/** The PUT a browser would do. Failure is surfaced with the body, not as a bare status. */
async function putToPresigned(url: string, headers: Readonly<Record<string, string>>, bytes: Buffer): Promise<void> {
  const response = await fetch(url, { method: 'PUT', headers: { ...headers }, body: new Uint8Array(bytes) });
  if (!response.ok) {
    throw new Error(`presigned PUT failed ${response.status}: ${await response.text()}`);
  }
}

describe.skipIf(!enabled)('web upload, end to end', () => {
  test('intent → PUT → complete lands a RECEIVED document and enqueues sanitisation', async () => {
    const { service, queue } = makeService();
    const bytes = Buffer.from('%PDF-1.4 p76 integration bytes');
    const byteHash = createHash('sha256').update(bytes).digest('hex');

    const intent = await service.createUpload(CTX_A, {
      businessId: BIZ_A,
      channel: 'WEB_UPLOAD',
      filename: 'august-invoices.pdf',
      mimeType: 'application/pdf',
      byteSize: bytes.length,
    });
    expect(intent.upload.method).toBe('PUT');

    // The real thing: MinIO validates the signature, and the signed
    // content-type/content-length must match what we told the client to send.
    await putToPresigned(intent.upload.url, intent.upload.headers, bytes);

    const document = await service.completeUpload(CTX_A, intent.uploadId, byteHash);

    expect(document.state).toBe('RECEIVED');
    expect(document.businessId).toBe(BIZ_A);
    expect(document.channel).toBe('WEB_UPLOAD');
    expect(document.byteHash).toBe(byteHash);
    expect(document.byteSize).toBe(bytes.length);

    const row = await owner.document.findUnique({ where: { id: document.id } });
    expect(row?.practiceId).toBe(P_A);
    expect(row?.inbox).toBe('COSTS');
    expect(row?.submitterUserId).toBe('p76_user_a');
    // The IAM constraint, asserted rather than assumed: staging grants `<bucket>/w/*`
    // and nothing else, so a key outside it passes every unit test and 403s live.
    expect(row?.s3Key.startsWith(`w/${BIZ_A}/uploads/`)).toBe(true);

    const events = await owner.documentEvent.findMany({ where: { documentId: document.id } });
    expect(events).toHaveLength(1);
    expect(events[0]?.stage).toBe('upload');

    // The bytes are really there, at the key the row points at.
    expect((await store.get(row?.s3Key ?? '')).equals(bytes)).toBe(true);

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]).toMatchObject({
      source: 'web_upload',
      documentId: document.id,
      storageKey: row?.s3Key,
      sha256: byteHash,
    });
  });

  test('the document is visible to its own practice and invisible to another, under RLS', async () => {
    const { service } = makeService();
    const bytes = Buffer.from('%PDF-1.4 p76 tenancy bytes');
    const byteHash = createHash('sha256').update(bytes).digest('hex');

    const intent = await service.createUpload(CTX_A, {
      businessId: BIZ_A,
      channel: 'WEB_UPLOAD',
      filename: 'tenancy.pdf',
      mimeType: 'application/pdf',
      byteSize: bytes.length,
    });
    await putToPresigned(intent.upload.url, intent.upload.headers, bytes);
    const document = await service.completeUpload(CTX_A, intent.uploadId, byteHash);

    const ctxB = ScopeContextSchema.parse({ actorId: 'p76_user_b', practiceId: P_B });
    const mine = await scopedDb(app, CTX_A, (db) => db.document.findUnique({ where: { id: document.id } }));
    const theirs = await scopedDb(app, ctxB, (db) => db.document.findUnique({ where: { id: document.id } }));

    expect(mine?.id).toBe(document.id);
    expect(theirs).toBeNull();
  });

  test('a business belonging to another practice is 404 and NOTHING is presigned', async () => {
    // The cross-tenant hole this endpoint would otherwise have. The presigned key
    // is `w/<businessId>/uploads/…` built from the request body, so without the
    // reachability check a caller could mint a write URL into another practice's
    // prefix. Postgres would refuse the row at completion — but the bytes would
    // already be sitting in someone else's bucket prefix, and object storage has
    // no RLS to undo that.
    //
    // Proven here against the REAL `businesses_tenant` policy: the unit test can
    // only show the branch fires when `findUnique` returns null; this shows that
    // Postgres is what returns null.
    const spy = countingStore(store);
    const { service, queue } = makeService(spy.store);
    const before = await owner.document.count({ where: { practiceId: P_B } });

    const error = await service
      .createUpload(CTX_A, {
        businessId: BIZ_B,
        channel: 'WEB_UPLOAD',
        filename: 'not-mine.pdf',
        mimeType: 'application/pdf',
        byteSize: 128,
      })
      .then(
        () => null,
        (rejection: unknown) => rejection as AppException,
      );

    // 404, never 403 — a 403 would confirm the business exists.
    expect(error?.getStatus()).toBe(HttpStatus.NOT_FOUND);
    // The assertion the test is named for: no URL was ever minted. This is the
    // one that pins the ORDER of the check against the presign, and it is the
    // only one here that a reordering refactor would break.
    expect(spy.presignPutCalls()).toBe(0);
    expect(queue.enqueued).toHaveLength(0);
    expect(await owner.document.count({ where: { practiceId: P_B } })).toBe(before);
  });

  test('replaying the Idempotency-Key returns the original document, not a second one', async () => {
    const { service } = makeService();
    const bytes = Buffer.from('%PDF-1.4 p76 idempotency bytes');
    const byteHash = createHash('sha256').update(bytes).digest('hex');
    const key = randomUUID();

    const intent = await service.createUpload(CTX_A, {
      businessId: BIZ_A,
      channel: 'WEB_UPLOAD',
      filename: 'replay.pdf',
      mimeType: 'application/pdf',
      byteSize: bytes.length,
    });
    await putToPresigned(intent.upload.url, intent.upload.headers, bytes);

    const first = await service.completeUpload(CTX_A, intent.uploadId, byteHash, key);
    const replay = await service.completeUpload(CTX_A, intent.uploadId, byteHash, key);

    expect(replay).toEqual(first);
    expect(await owner.document.count({ where: { id: first.id } })).toBe(1);
    expect(await owner.documentEvent.count({ where: { documentId: first.id } })).toBe(1);
  });
});
