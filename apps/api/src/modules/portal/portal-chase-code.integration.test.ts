import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { signPortalLink } from '../chase/index.js';
import { DemoEmailSender, InMemoryEmailRateLimiter, NotificationsService } from '../notifications/index.js';
import { PortalOnboardingService } from './portal-onboarding.service.js';
import { PortalSessionService } from './portal-session.service.js';

/**
 * The chase-OTP acceptance — the gap `portal/CLAUDE.md` carried as *"the CHASE
 * half still writes no `otp_hash`, so `OTP_MODE=totp` opens no session from a
 * chase link"*, closed end to end against a real database:
 *
 *   a chase exists (as the approved executor leaves it) → the client posts the
 *   LINK TOKEN to sign-in-codes → a six-digit code is minted, hashed onto the
 *   link's `otp_sessions` row, and EMAILED to the chase's registered recipient
 *   contact → `POST /portal/sessions` under `OTP_MODE=totp` exchanges link +
 *   code for a bearer → the code is spent (single-use) → a wrong code refuses.
 *
 * Namespace `pcc_`, torn down by explicit id list (the house rule — never
 * `startsWith`, whose unescaped LIKE has eaten a neighbour's fixtures).
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P = 'pcc_prac';
const BIZ = 'pcc_biz';
const SYSTEM_USER = 'pcc_system';
const SYSTEM_MEMBERSHIP = 'pcc_mem_system';
const CONTACT = 'pcc_contact';
const CONTACT_NO_EMAIL = 'pcc_contact_nomail';
const ACCOUNT = 'pcc_acct';
const TXN = 'pcc_txn';
const CHASE = 'pcc_chase';
const CHASE_NO_CONTACT = 'pcc_chase_nocontact';
const LINK_SECRET = 'pcc-link-secret-000000000000000000';
const SESSION_SECRET = 'pcc-session-secret-0000000000000000';

let owner: PrismaClient;
let app: PrismaClient;
let email: DemoEmailSender;

function onboarding(): PortalOnboardingService {
  const notifications = new NotificationsService(email, new InMemoryEmailRateLimiter());
  return new PortalOnboardingService(
    app,
    { portalSessionSecret: SESSION_SECRET, otpMode: 'totp', portalLinkSecret: LINK_SECRET },
    notifications,
  );
}

function sessions(): PortalSessionService {
  return new PortalSessionService(app, {
    portalLinkSecret: LINK_SECRET,
    portalSessionSecret: SESSION_SECRET,
    otpMode: 'totp',
  });
}

/** The six digits out of the last sent mail — the way the client reads them. */
function lastCode(): string {
  const outbox = email.readOutbox();
  const body = outbox[outbox.length - 1]?.body ?? '';
  return /\b([0-9]{6})\b/.exec(body)?.[1] ?? '';
}

async function cleanup(): Promise<void> {
  await owner.otpSession.deleteMany({ where: { businessId: BIZ } });
  await owner.chase.deleteMany({ where: { id: { in: [CHASE, CHASE_NO_CONTACT] } } });
  await owner.bankTransaction.deleteMany({ where: { id: TXN } });
  await owner.bankAccount.deleteMany({ where: { id: ACCOUNT } });
  await owner.contact.deleteMany({ where: { id: { in: [CONTACT, CONTACT_NO_EMAIL] } } });
  await owner.membership.deleteMany({ where: { id: SYSTEM_MEMBERSHIP } });
  await owner.user.deleteMany({ where: { id: SYSTEM_USER } });
  await owner.business.deleteMany({ where: { id: BIZ } });
  await owner.practice.deleteMany({ where: { id: P } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;
  email = new DemoEmailSender();

  await cleanup();
  await owner.practice.create({ data: { id: P, name: 'PCC' } });
  await owner.business.create({ data: { id: BIZ, practiceId: P, name: 'Chase Code Ltd' } });
  // The sweep resolves through each practice's SYSTEM actor — the worker rule.
  await owner.user.create({ data: { id: SYSTEM_USER, kind: 'SYSTEM' } });
  await owner.membership.create({
    data: { id: SYSTEM_MEMBERSHIP, userId: SYSTEM_USER, practiceId: P, role: 'PRACTICE_STANDARD' },
  });
  await owner.contact.create({
    data: { id: CONTACT, businessId: BIZ, mobileE164: '+447700900201', email: 'pcc@client.test', isPrimary: true },
  });
  await owner.contact.create({ data: { id: CONTACT_NO_EMAIL, businessId: BIZ, mobileE164: '+447700900202', email: null } });
  await owner.bankAccount.create({ data: { id: ACCOUNT, businessId: BIZ, displayName: 'Current' } });
  await owner.bankTransaction.create({
    data: {
      id: TXN,
      businessId: BIZ,
      accountId: ACCOUNT,
      bookedAt: new Date('2026-08-09T12:00:00.000Z'),
      amountPence: -12_900,
      descriptionRaw: 'CURRYS 1234',
      matchState: 'UNMATCHED',
    },
  });
  await owner.chase.create({
    data: {
      id: CHASE,
      businessId: BIZ,
      detectionEngine: 'UNMATCHED_TRANSACTION',
      transactionId: TXN,
      itemRefs: [TXN],
      recipientContactId: CONTACT,
      state: 'SENT',
    },
  });
  await owner.chase.create({
    data: {
      id: CHASE_NO_CONTACT,
      businessId: BIZ,
      detectionEngine: 'UNMATCHED_TRANSACTION',
      transactionId: TXN,
      itemRefs: [TXN],
      recipientContactId: null,
      state: 'SENT',
    },
  });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('chase link → emailed code → portal session, under OTP_MODE=totp', () => {
  test('the code is minted onto the link row, emailed to the REGISTERED contact, opens a session ONCE', async () => {
    const linkToken = signPortalLink({ chaseId: CHASE }, LINK_SECRET);

    await onboarding().requestChaseCode(linkToken);

    // The code went to the chase's registered recipient — never a typed address.
    const sent = email.readOutbox().at(-1);
    expect(sent?.to).toBe('pcc@client.test');
    const code = lastCode();
    expect(code).toMatch(/^[0-9]{6}$/);

    // The row the code landed on is NOT a session: unverified, already expired.
    const row = await owner.otpSession.findFirst({ where: { chaseId: CHASE } });
    expect(row?.verifiedAt).toBeNull();
    expect(row?.otpHash).not.toBeNull();

    // Link + code → a bearer. This is the sentence that was false before:
    // under totp a chase link could open no session at all.
    const issued = await sessions().createSession({ linkToken, otp: code });
    expect(issued.token.length).toBeGreaterThan(20);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Single-use: the hash cleared on success, so the same code refuses now.
    await expect(sessions().createSession({ linkToken, otp: code })).rejects.toMatchObject({ code: 'NT-OTP-001' });
  });

  test('a wrong code refuses uniformly and counts the attempt', async () => {
    const linkToken = signPortalLink({ chaseId: CHASE }, LINK_SECRET);
    await onboarding().requestChaseCode(linkToken);

    await expect(sessions().createSession({ linkToken, otp: '999999' })).rejects.toMatchObject({ code: 'NT-OTP-001' });
    const row = await owner.otpSession.findFirst({ where: { chaseId: CHASE } });
    expect(row?.attempts).toBeGreaterThan(0);

    // The right code still works after a slip — the counter clears on success.
    const issued = await sessions().createSession({ linkToken, otp: lastCode() });
    expect(issued.token.length).toBeGreaterThan(20);
  });

  test('every refusal is silent: bad token, unknown chase, no recipient contact — nothing is sent', async () => {
    const before = email.readOutbox().length;

    await onboarding().requestChaseCode('not-a-token');
    await onboarding().requestChaseCode(signPortalLink({ chaseId: 'pcc_no_such_chase' }, LINK_SECRET));
    await onboarding().requestChaseCode(signPortalLink({ chaseId: CHASE_NO_CONTACT }, LINK_SECRET));
    // Signed with the WRONG secret — a forged link anchors nothing.
    await onboarding().requestChaseCode(signPortalLink({ chaseId: CHASE }, 'wrong-secret-000000000000000000000'));

    expect(email.readOutbox()).toHaveLength(before);
  });
});
