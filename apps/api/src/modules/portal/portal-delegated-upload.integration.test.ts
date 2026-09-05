import { createHash, randomUUID } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { ScopeContextSchema } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../common/problem/problem.js';
import { signPortalLink } from '../chase/index.js';
import { documentIdFor } from '../ingestion-routing/index.js';
import { InMemoryDocumentStore } from '../ingestion-routing/storage/document-store.js';
import { delegatedCompletionFor } from '../ingestion-routing/web-upload/delegated-completion.js';
import { WebUploadService } from '../ingestion-routing/web-upload/web-upload.service.js';
import { FixtureIngestQueue } from '../ingestion-routing/webhooks/whatsapp/ingest-queue.js';
import { PORTAL_UPLOAD_EVENT, PortalUploadNotifier } from './portal-upload-notifier.js';
import { PortalSessionContextResolver } from './portal-session-context.js';
import { PortalSessionService } from './portal-session.service.js';
import { PrismaPortalUploadService } from './portal-upload.service.js';

/**
 * The DELEGATED UPLOAD path end to end against a REAL database as `nt_app`
 * (METH Stage 9, SoT §4 Stage 8.4): SMS link + `000000` → `POST /portal/uploads`
 * → `POST /document-uploads/{uploadId}/complete` with the portal bearer → a
 * document in the client's workspace, recorded as
 * `uploaded-by-delegated-session`, with the ingest job the pipeline needs.
 *
 * **Five things only Postgres can answer, and they are why this file exists.**
 *
 * 1. **The grant is what makes the write legal.** `documents_delegated_upload`
 *    keys on `id = ANY(app_granted_item_ids())`, so the derived document id has
 *    to be on the session row BEFORE completion. No fake can prove that; a stub
 *    Prisma accepts every insert.
 * 2. **A delegated session cannot write into another business.** The WITH CHECK
 *    is `business_id = app_business_id()`, and the test forces the one case the
 *    handler's own guard would otherwise hide.
 * 3. **`document_events` genuinely refuses a delegated context**, which is why
 *    the provenance row is written under the practice SYSTEM one — the row is
 *    here, so the split is proven rather than asserted in a comment.
 * 4. **The delegated session can read its own document back**, which is what the
 *    portal's status poll depends on.
 * 5. **The enqueued job carries what the worker needs** for extraction and Stage
 *    8's auto-close to run for a portal document exactly as for a web upload.
 *
 * Storage is `InMemoryDocumentStore` on purpose: the presigned-signature
 * question is `web-upload.integration.test.ts`'s (it PUTs to real MinIO), and
 * making this suite need `RUN_S3_INTEGRATION=1` would leave the tenancy
 * assertions unrun on an ordinary `pnpm test` with docker up.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable — a tenancy suite that quietly reports
 * green is worse than none. Ids are prefixed `p9u_`, disjoint from every other
 * suite (including `portal.integration.test.ts`'s `p9_`), and torn down at both
 * ends: one local Postgres, file-serial runs.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const LINK_SECRET = 'p9u-portal-link-secret';
const SESSION_SECRET = 'p9u-portal-session-secret';
const UPLOAD_SECRET = 'p9u-upload-secret';

const P_A = 'p9u_prac_a';
const P_B = 'p9u_prac_b';
const BIZ_A = 'p9u_biz_a';
const BIZ_B = 'p9u_biz_b';
const CHASE_A = 'p9u_chase_a';
const CHASE_B = 'p9u_chase_b';
const SYS_A = 'p9u_usr_sys_a';

let owner: PrismaClient;
let app: PrismaClient;

const sessionConfig = { portalLinkSecret: LINK_SECRET, portalSessionSecret: SESSION_SECRET, otpMode: 'demo' } as const;
const uploadConfig = { uploadSecret: UPLOAD_SECRET, uploadTtlSeconds: 900 };

/** The whole journey's front half, exactly as the endpoints run it: link + OTP → bearer. */
async function openSession(chaseId: string): Promise<string> {
  const issued = await new PortalSessionService(app, sessionConfig).createSession({
    linkToken: signPortalLink({ chaseId }, LINK_SECRET),
    otp: '000000',
  });
  return `Bearer ${issued.token}`;
}

function resolver(): PortalSessionContextResolver {
  return new PortalSessionContextResolver(app, { portalSessionSecret: SESSION_SECRET });
}

/** The real notifier, against the real `notifications` policy — see the last test. */
function notifier(): PortalUploadNotifier {
  return new PortalUploadNotifier(app);
}

function portalUploads(store: InMemoryDocumentStore): PrismaPortalUploadService {
  return new PrismaPortalUploadService(
    app,
    store,
    new PortalSessionService(app, sessionConfig),
    new InMemoryIdempotencyStore(),
    uploadConfig,
  );
}

function completions(store: InMemoryDocumentStore): { service: WebUploadService; queue: FixtureIngestQueue } {
  const queue = new FixtureIngestQueue();
  return {
    queue,
    service: new WebUploadService(app, store, queue, new InMemoryIdempotencyStore(), uploadConfig),
  };
}

/** Intent → the client's PUT (stood in for) → the bytes are where completion will look. */
async function intentWithBytes(
  store: InMemoryDocumentStore,
  authorization: string,
  filename: string,
  bytes: Buffer,
): Promise<{ uploadId: string; byteHash: string }> {
  const facts = await resolver().resolveForUpload(authorization);
  const intent = await portalUploads(store).createPortalUpload(
    facts,
    { filename, mimeType: 'image/jpeg', byteSize: bytes.length },
    randomUUID(),
  );
  store.putRaw(intent.upload.url.replace('https://fixture.local/', ''), bytes);
  return { uploadId: intent.uploadId, byteHash: createHash('sha256').update(bytes).digest('hex') };
}

async function cleanup(): Promise<void> {
  await owner.notification.deleteMany({ where: { businessId: { in: [BIZ_A, BIZ_B] } } });
  await owner.otpSession.deleteMany({ where: { businessId: { in: [BIZ_A, BIZ_B] } } });
  // Document ids are DERIVED (`doc_<hash>`), so they cannot be matched by
  // prefix — the practice anchor is what makes them findable for teardown.
  // `DocumentEvent.document` is `onDelete: Cascade`, so the events go with them.
  await owner.document.deleteMany({ where: { practiceId: { in: [P_A, P_B] } } });
  await owner.chase.deleteMany({ where: { businessId: { in: [BIZ_A, BIZ_B] } } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 'p9u_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 'p9u_' } } });
  await owner.business.deleteMany({ where: { id: { in: [BIZ_A, BIZ_B] } } });
  await owner.practice.deleteMany({ where: { id: { in: [P_A, P_B] } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`; // configured-but-unreachable → throw, not skip

  await cleanup();
  await owner.practice.createMany({ data: [{ id: P_A, name: 'P9U A' }, { id: P_B, name: 'P9U B' }] });
  // SYSTEM users: the actor a delegated write is attributed to when the chase's
  // contact has no provisioned user — SoT §3.3's phone-number-only client, the
  // common case.
  await owner.user.createMany({
    data: [
      { id: SYS_A, email: 'p9u-system-a@example.test', kind: 'SYSTEM' },
      { id: 'p9u_usr_sys_b', email: 'p9u-system-b@example.test', kind: 'SYSTEM' },
    ],
  });
  await owner.membership.createMany({
    data: [
      { id: 'p9u_mem_a', userId: SYS_A, practiceId: P_A, role: 'PRACTICE_ADMIN' },
      { id: 'p9u_mem_b', userId: 'p9u_usr_sys_b', practiceId: P_B, role: 'PRACTICE_ADMIN' },
    ],
  });
  await owner.business.createMany({
    data: [
      // ACTIVE because the portal intent is entitlement-gated (D48): a client
      // business with no subscription cannot take new documents, which is what
      // this suite is otherwise entirely about.
      { id: BIZ_A, practiceId: P_A, name: 'P9U American Burger', subscriptionStatus: 'ACTIVE' },
      { id: BIZ_B, practiceId: P_B, name: 'P9U Other Client', subscriptionStatus: 'ACTIVE' },
    ],
  });
  await owner.chase.createMany({
    data: [
      { id: CHASE_A, businessId: BIZ_A, detectionEngine: 'UNMATCHED_TRANSACTION', itemRefs: [], state: 'SENT', firstSentAt: new Date() },
      { id: CHASE_B, businessId: BIZ_B, detectionEngine: 'UNMATCHED_TRANSACTION', itemRefs: [], state: 'SENT', firstSentAt: new Date() },
    ],
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('the delegated upload path against real RLS', () => {
  test('link + OTP → intent → complete lands the document under the DELEGATED grant, with its provenance and its job', async () => {
    const store = new InMemoryDocumentStore();
    const { service, queue } = completions(store);
    const authorization = await openSession(CHASE_A);
    const bytes = Buffer.from('\xff\xd8\xff p9u currys receipt bytes');

    const { uploadId, byteHash } = await intentWithBytes(store, authorization, 'currys-receipt.jpg', bytes);

    // THE CRUX, on the real row: the id completion will derive is already in the
    // session's grant, and it is the ONLY thing there.
    const session = await owner.otpSession.findFirstOrThrow({ where: { chaseId: CHASE_A } });
    expect(session.grantedItemIds).toEqual([documentIdFor(uploadId)]);

    const caller = await delegatedCompletionFor(resolver(), notifier(),authorization);
    const document = await service.completeDelegatedUpload(caller, uploadId, byteHash, randomUUID());

    expect(document.id).toBe(documentIdFor(uploadId));
    expect(document.businessId).toBe(BIZ_A);
    expect(document.state).toBe('RECEIVED');
    expect(document.channel).toBe('SMS_PORTAL');

    const row = await owner.document.findUniqueOrThrow({ where: { id: document.id } });
    // The practice anchor comes from the BUSINESS row — it is what lets the
    // worker extract at all, and Stage 8's auto-close after it.
    expect(row.practiceId).toBe(P_A);
    expect(row.inbox).toBe('COSTS');
    // The provenance the acceptance names, on the row itself, so it survives
    // even if the timeline write below never lands. Since review item 21 the
    // ROW label names WHICH portal door — this is a chase-link session — while
    // the timeline event below keeps SoT §4 Stage 8.3's exact audit string.
    expect(row.submitterLabel).toBe('uploaded-via-chase-link');
    // A delegated session is not a user; the actor is the practice SYSTEM one
    // (the chase's contact has no provisioned user), decided at session creation.
    expect(row.submitterUserId).toBe(SYS_A);
    expect(row.s3Key.startsWith(`w/${BIZ_A}/uploads/`)).toBe(true);

    // The timeline entry, written under the practice SYSTEM context because
    // `document_events` has no delegated policy. Its presence is the proof that
    // the split works; its absence would be a silent RLS refusal.
    const events = await owner.documentEvent.findMany({ where: { documentId: document.id } });
    expect(events).toHaveLength(1);
    expect(events[0]?.stage).toBe('upload');
    expect(events[0]?.outcome).toBe('uploaded-by-delegated-session');
    expect(events[0]?.detail).toMatchObject({ otpSessionId: session.id, chaseId: CHASE_A, channel: 'SMS_PORTAL' });

    // "Notify the accountant when a client uploads" (SoT §4 Stage 8.8): one row,
    // written under the SYSTEM context because `notifications` has no delegated
    // policy either — the same split as the event above, proven the same way.
    const notifications = await owner.notification.findMany({ where: { businessId: BIZ_A, event: PORTAL_UPLOAD_EVENT } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.payload).toMatchObject({ documentId: document.id, otpSessionId: session.id, source: 'portal' });

    // The job the worker needs: an already-persisted document with its practice
    // and its business, so extraction runs and Stage 8's auto-close follows —
    // exactly the web-upload shape, which is the branch the processor has.
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]).toMatchObject({
      source: 'web_upload',
      documentId: document.id,
      practiceId: P_A,
      routing: { kind: 'matched', businessId: BIZ_A },
      storageKey: row.s3Key,
      sha256: byteHash,
    });
  });

  test('the session can read back the document it was granted — and only through the grant', async () => {
    const store = new InMemoryDocumentStore();
    const { service } = completions(store);
    const authorization = await openSession(CHASE_A);
    const bytes = Buffer.from('\xff\xd8\xff p9u readback bytes');

    const { uploadId, byteHash } = await intentWithBytes(store, authorization, 'readback.jpg', bytes);
    const caller = await delegatedCompletionFor(resolver(), notifier(),authorization);
    const document = await service.completeDelegatedUpload(caller, uploadId, byteHash, randomUUID());

    const mine = await scopedDb(app, caller.context, (db) => db.document.findUnique({ where: { id: document.id } }));
    expect(mine?.id).toBe(document.id);

    // The same context, minus this id from the grant, sees nothing — the
    // document boundary is `id = ANY(app_granted_item_ids())` in SQL, not a
    // filter in the handler. (`grantedItemIds` cannot be empty, so the grant is
    // pointed at a different id rather than emptied.)
    const narrowed = ScopeContextSchema.parse({ ...caller.context, grantedItemIds: ['p9u_doc_not_this_one'] });
    const theirs = await scopedDb(app, narrowed, (db) => db.document.findUnique({ where: { id: document.id } }));
    expect(theirs).toBeNull();
  });

  test('a session CANNOT complete an intent it did not start — 404, before any storage is touched', async () => {
    const store = new InMemoryDocumentStore();
    const { service, queue } = completions(store);
    const mine = await openSession(CHASE_A);
    const theirs = await openSession(CHASE_B);

    // My session has an upload of its own, so its grant is genuinely non-empty —
    // the refusal below has to come from the grant not covering THIS id, not
    // from a session that could not have completed anything at all.
    await intentWithBytes(store, mine, 'mine.jpg', Buffer.from('\xff\xd8\xff p9u my own bytes'));
    // An intent minted under the OTHER business's session…
    const foreign = await intentWithBytes(store, theirs, 'not-mine.jpg', Buffer.from('\xff\xd8\xff p9u someone elses bytes'));
    // …completed with MY session's delegated context.
    const caller = await delegatedCompletionFor(resolver(), notifier(),mine);

    const error = await service
      .completeDelegatedUpload(caller, foreign.uploadId, foreign.byteHash, randomUUID())
      .then(
        () => null,
        (rejection: unknown) => rejection as AppException,
      );

    // 404, never 403 — an intent this session cannot reach does not exist as far
    // as it is concerned.
    expect(error?.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(await owner.document.count({ where: { id: documentIdFor(foreign.uploadId) } })).toBe(0);
    expect(queue.enqueued).toHaveLength(0);
  });

  test('POSTGRES refuses a delegated write into another business, even with the grant forced open', async () => {
    // The handler's own guard (the 404 above) would hide this, so it is bypassed
    // deliberately: a delegated context for business A, whose grant has been
    // hand-widened to include a document id belonging to business B's intent.
    // Nothing in the application then stands between the write and the database
    // — which is the point. `documents_delegated_upload`'s WITH CHECK
    // (`business_id = app_business_id()`) is the only thing left, and it must be
    // enough.
    const store = new InMemoryDocumentStore();
    const { service, queue } = completions(store);
    const mine = await openSession(CHASE_A);
    const theirs = await openSession(CHASE_B);

    await intentWithBytes(store, mine, 'mine.jpg', Buffer.from('\xff\xd8\xff p9u my own bytes again'));
    const foreign = await intentWithBytes(store, theirs, 'cross-tenant.jpg', Buffer.from('\xff\xd8\xff p9u cross tenant bytes'));
    const caller = await delegatedCompletionFor(resolver(), notifier(),mine);
    const forced = ScopeContextSchema.parse({
      ...caller.context,
      grantedItemIds: [documentIdFor(foreign.uploadId)],
    });

    const error = await service
      .completeDelegatedUpload({ ...caller, context: forced }, foreign.uploadId, foreign.byteHash, randomUUID())
      .then(
        () => null,
        (rejection: unknown) => rejection as Error,
      );

    // Named, not merely "it threw": a bare `rejects.toThrow()` would also pass if
    // the refusal came from the application, which is exactly what this test
    // removed. The message has to be Postgres's own.
    expect(error?.message).toMatch(/row-level security/i);

    // Nothing was written for either business, and nothing was queued.
    expect(await owner.document.count({ where: { id: documentIdFor(foreign.uploadId) } })).toBe(0);
    expect(await owner.document.count({ where: { practiceId: P_B } })).toBe(0);
    expect(queue.enqueued).toHaveLength(0);
  });

  test('a replayed completion returns the same document and does not enqueue or re-record twice', async () => {
    const store = new InMemoryDocumentStore();
    const { service, queue } = completions(store);
    const authorization = await openSession(CHASE_A);
    const bytes = Buffer.from('\xff\xd8\xff p9u replay bytes');
    const key = randomUUID();

    const { uploadId, byteHash } = await intentWithBytes(store, authorization, 'replay.jpg', bytes);
    const caller = await delegatedCompletionFor(resolver(), notifier(),authorization);

    const first = await service.completeDelegatedUpload(caller, uploadId, byteHash, key);
    const replay = await service.completeDelegatedUpload(caller, uploadId, byteHash, key);
    // And once more with NO key, so the replay store cannot short-circuit it:
    // only the derived document id stops this one.
    const again = await service.completeDelegatedUpload(caller, uploadId, byteHash);

    expect(replay).toEqual(first);
    expect(again.id).toBe(first.id);
    expect(await owner.document.count({ where: { id: first.id } })).toBe(1);
    expect(await owner.documentEvent.count({ where: { documentId: first.id } })).toBe(1);
    expect(queue.enqueued).toHaveLength(1);
    // One document, one toast: the notification hangs off the `created` gate,
    // not off the request.
    expect(
      await owner.notification.count({
        where: { businessId: BIZ_A, event: PORTAL_UPLOAD_EVENT, payload: { path: ['documentId'], equals: first.id } },
      }),
    ).toBe(1);
  });
});
