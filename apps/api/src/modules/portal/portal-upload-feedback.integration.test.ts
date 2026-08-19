import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { AppException } from '../../common/problem/problem.js';
import { PortalContextService } from './portal-context.service.js';
import { PortalSessionContextResolver, type PortalSessionFacts } from './portal-session-context.js';
import { signPortalSessionToken } from './portal-session-token.js';
import { PORTAL_UPLOAD_EVENT, PortalUploadNotifier } from './portal-upload-notifier.js';
import { PortalUploadStatusService } from './portal-upload-status.service.js';

/**
 * The portal's post-upload half, proven against a REAL database as `nt_app`
 * (METH Stage 9):
 *
 *   a delegated session that has uploaded a document gets the chase verdict for
 *   it — "received, thank you" or the named difference — the accountant gets a
 *   `portal.upload` notification exactly once, and a document the session was
 *   never granted is invisible to it. The last one is the acceptance's negative
 *   test, and it is invisible in SQL rather than filtered in TypeScript: the
 *   delegated context is built only from `otp_sessions.granted_item_ids`, and
 *   `documents_delegated_upload` keys on exactly that.
 *
 * The facts these services take are produced by the REAL resolver from a REAL
 * bearer, so the test exercises the session row the same way a request does.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (red run)
 * when one is configured but unreachable. Ids are the disjoint `p9_` namespace
 * and are torn down whole (apps/api/CLAUDE.md — the suite runs file-serially).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P = 'p9_prac';
const BIZ = 'p9_biz';
const SYS = 'p9_sys';
const CHASE = 'p9_chase';
const OTP = 'p9_otp';
const SESSION_SECRET = 'p9-portal-session-secret';

const MATCHING = 'p9_doc_match';
const WRONG = 'p9_doc_wrong';
const UNGRANTED = 'p9_doc_secret';

const BOOKED_AT = new Date('2026-08-05T09:12:00.000Z');
const EXPIRES_AT = new Date('2099-01-01T00:00:00.000Z');

let owner: PrismaClient;
let app: PrismaClient;

function notifier(): PortalUploadNotifier {
  return new PortalUploadNotifier(app);
}

function statuses(): PortalUploadStatusService {
  return new PortalUploadStatusService(app);
}

/**
 * Set the session's grant, then resolve the bearer the way a request does —
 * `grantItems` is the upload path's job, and what matters here is that the
 * facts under test are the resolver's own.
 */
async function factsWithGrant(grantedItemIds: readonly string[]): Promise<PortalSessionFacts> {
  await owner.otpSession.update({ where: { id: OTP }, data: { grantedItemIds: [...grantedItemIds] } });
  const token = signPortalSessionToken(
    { otpSessionId: OTP, businessId: BIZ, practiceId: P, expiresAtMs: EXPIRES_AT.getTime() },
    SESSION_SECRET,
  );
  const resolver = new PortalSessionContextResolver(app, { portalSessionSecret: SESSION_SECRET });
  return resolver.resolve(`Bearer ${token}`);
}

async function seedDocument(
  id: string,
  header: { supplierName: string; totalPence: number; documentDate: Date },
  state: 'PROCESSING' | 'READY' = 'READY',
): Promise<void> {
  await owner.document.create({
    data: {
      id,
      practiceId: P,
      businessId: BIZ,
      s3Key: `w/${BIZ}/documents/${id}`,
      byteHash: `h-${id}`,
      mimeType: 'image/jpeg',
      byteSize: 12,
      channel: 'SMS_PORTAL',
      originalFilename: `${id}.jpg`,
      inbox: 'COSTS',
      state,
      supplierName: header.supplierName,
      totalPence: header.totalPence,
      documentDate: header.documentDate,
    },
  });
  await owner.extraction.create({
    data: { documentId: id, fields: {}, extractorKind: 'demo', overallConfidence: 0.94, isAccepted: true },
  });
}

async function deleteSeed(): Promise<void> {
  await owner.notification.deleteMany({ where: { businessId: BIZ } });
  await owner.extraction.deleteMany({ where: { document: { practiceId: P } } });
  await owner.document.deleteMany({ where: { practiceId: P } });
  await owner.otpSession.update({ where: { id: OTP }, data: { grantedItemIds: [] } }).catch(() => undefined);
}

async function cleanup(): Promise<void> {
  await owner.notification.deleteMany({ where: { businessId: BIZ } });
  await owner.extraction.deleteMany({ where: { document: { practiceId: P } } });
  await owner.document.deleteMany({ where: { practiceId: P } });
  await owner.otpSession.deleteMany({ where: { businessId: BIZ } });
  await owner.chaseMessage.deleteMany({ where: { chase: { businessId: BIZ } } });
  await owner.chase.deleteMany({ where: { businessId: BIZ } });
  await owner.bankTransaction.deleteMany({ where: { businessId: BIZ } });
  await owner.bankAccount.deleteMany({ where: { businessId: BIZ } });
  await owner.membership.deleteMany({ where: { id: { startsWith: 'p9_' } } });
  await owner.user.deleteMany({ where: { id: { startsWith: 'p9_' } } });
  await owner.business.deleteMany({ where: { id: BIZ } });
  await owner.practice.deleteMany({ where: { id: P } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.create({ data: { id: P, name: 'P9 Accountants' } });
  await owner.user.create({ data: { id: SYS, kind: 'SYSTEM' } });
  await owner.membership.create({ data: { id: 'p9_mem_sys', userId: SYS, practiceId: P, role: 'PRACTICE_STANDARD' } });
  await owner.business.create({ data: { id: BIZ, practiceId: P, name: 'American Burger Ltd' } });

  const account = await owner.bankAccount.create({ data: { businessId: BIZ, displayName: 'Current' } });
  const txn = await owner.bankTransaction.create({
    data: {
      businessId: BIZ,
      accountId: account.id,
      bookedAt: BOOKED_AT,
      amountPence: -60_000,
      descriptionRaw: 'GOOGLE ADS 8829 IE',
      merchantName: 'Google',
      matchState: 'UNMATCHED',
    },
  });
  await owner.chase.create({
    data: {
      id: CHASE,
      businessId: BIZ,
      detectionEngine: 'UNMATCHED_TRANSACTION',
      transactionId: txn.id,
      itemRefs: [txn.id],
      state: 'SENT',
      firstSentAt: new Date(),
    },
  });
  await owner.otpSession.create({
    data: {
      id: OTP,
      businessId: BIZ,
      chaseId: CHASE,
      scope: 'DELEGATED_UPLOAD',
      linkTokenHash: 'p9-link-hash',
      grantedItemIds: [],
      verifiedAt: new Date(),
      expiresAt: EXPIRES_AT,
    },
  });
});

beforeEach(async () => {
  if (!enabled) return;
  await deleteSeed();
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('portal upload feedback against a real database', () => {
  test('a portal upload notifies the accountant, exactly once', async () => {
    await seedDocument(MATCHING, { supplierName: 'Google', totalPence: 60_000, documentDate: new Date('2026-08-05T00:00:00.000Z') });
    const facts = await factsWithGrant([MATCHING]);

    expect(await notifier().notifyUploadReceived(facts, { documentId: MATCHING, traceId: 'trace-p9' })).toBe(true);

    const rows = await owner.notification.findMany({ where: { businessId: BIZ, event: PORTAL_UPLOAD_EVENT } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      documentId: MATCHING,
      otpSessionId: OTP,
      chaseId: CHASE,
      source: 'portal',
      traceId: 'trace-p9',
    });
    // // DEMO-MOCK: delivery channels — the row is the toast, nothing was sent.
    expect(rows[0]?.channels).toEqual([]);
    expect(rows[0]?.recipientUserId).toBeNull();
    expect(rows[0]?.readAt).toBeNull();

    // A replayed completion writes no second toast.
    expect(await notifier().notifyUploadReceived(facts, { documentId: MATCHING })).toBe(false);
    expect(await owner.notification.count({ where: { businessId: BIZ, event: PORTAL_UPLOAD_EVENT } })).toBe(1);
  });

  test('two different documents in one session each get their own notification', async () => {
    await seedDocument(MATCHING, { supplierName: 'Google', totalPence: 60_000, documentDate: BOOKED_AT });
    await seedDocument(WRONG, { supplierName: 'Amazon', totalPence: 42_000, documentDate: new Date('2026-07-01T00:00:00.000Z') });
    const facts = await factsWithGrant([MATCHING, WRONG]);

    await notifier().notifyUploadReceived(facts, { documentId: MATCHING });
    await notifier().notifyUploadReceived(facts, { documentId: WRONG });

    expect(await owner.notification.count({ where: { businessId: BIZ, event: PORTAL_UPLOAD_EVENT } })).toBe(2);
  });

  test('the right document reports the match, its header and the chased item', async () => {
    await seedDocument(MATCHING, { supplierName: 'Google', totalPence: 60_000, documentDate: new Date('2026-08-05T00:00:00.000Z') });
    const facts = await factsWithGrant([MATCHING]);

    const status = await statuses().statusFor(facts, MATCHING);

    expect(status.stage).toBe('match');
    expect(status.message).toBe("Received, thank you — that's the £600 Google transaction from 5 Aug.");
    expect(status.extracted?.totalPence).toBe(60_000);
    expect(status.extracted?.confidence).toBe(0.94);
    expect(status.chaseState).toBe('SENT');
    expect(status.transactionId).not.toBeNull();
  });

  test('the wrong document names the difference and the item stays outstanding', async () => {
    await seedDocument(WRONG, { supplierName: 'Amazon', totalPence: 42_000, documentDate: new Date('2026-07-01T00:00:00.000Z') });
    const facts = await factsWithGrant([WRONG]);

    const status = await statuses().statusFor(facts, WRONG);

    expect(status.stage).toBe('mismatch');
    expect(status.reasons).toEqual(['supplier', 'amount', 'date']);
    expect(status.message).toBe(
      'This looks like a £420 Amazon invoice from 1 Jul, but we need the £600 Google transaction from 5 Aug.',
    );
  });

  test('a document still processing reports processing, not a mismatch', async () => {
    await seedDocument(MATCHING, { supplierName: 'Google', totalPence: 60_000, documentDate: BOOKED_AT }, 'PROCESSING');
    const facts = await factsWithGrant([MATCHING]);

    const status = await statuses().statusFor(facts, MATCHING);
    expect(status.stage).toBe('processing');
    expect(status.extracted).toBeNull();
  });

  test('a portal session cannot read a document it was not granted', async () => {
    await seedDocument(MATCHING, { supplierName: 'Google', totalPence: 60_000, documentDate: BOOKED_AT });
    await seedDocument(UNGRANTED, { supplierName: 'Currys', totalPence: 129_900, documentDate: BOOKED_AT });
    // Same business, same practice, sitting right next to the granted one.
    const facts = await factsWithGrant([MATCHING]);

    await expect(statuses().statusFor(facts, UNGRANTED)).rejects.toBeInstanceOf(AppException);
    await expect(statuses().statusFor(facts, UNGRANTED)).rejects.toMatchObject({ code: 'NT-VAL-001' });

    // And it is absent from the session's own list, not merely un-fetchable.
    const listed = await statuses().statusesForSession(facts);
    expect(listed.map((status) => status.documentId)).toEqual([MATCHING]);
  });

  test('a session that has uploaded nothing yet reads nothing — an empty grant is a state, not an error', async () => {
    await seedDocument(MATCHING, { supplierName: 'Google', totalPence: 60_000, documentDate: BOOKED_AT });
    const facts = await factsWithGrant([]);

    expect(await statuses().statusesForSession(facts)).toEqual([]);
    await expect(statuses().statusFor(facts, MATCHING)).rejects.toBeInstanceOf(AppException);
  });

  /**
   * `received` has exactly ONE implementation and this is it: the chase module's
   * `toChaseItem`, read by `GET /portal/context`. A chase closed by another
   * channel — the client sent the receipt by WhatsApp instead — must read as
   * received here even though this session was granted nothing and can see no
   * document at all. Asserted against the live path, because that is the only
   * one a client's phone ever reaches.
   */
  test('a chase already closed by another channel reports the item as received on GET /portal/context', async () => {
    await owner.chase.update({ where: { id: CHASE }, data: { state: 'CLOSED_RECEIVED' } });
    try {
      const context = await new PortalContextService(app).getContext(await factsWithGrant([]));
      expect(context.items).toHaveLength(1);
      expect(context.items.every((item) => item.received)).toBe(true);
    } finally {
      await owner.chase.update({ where: { id: CHASE }, data: { state: 'SENT' } });
    }
  });
});
