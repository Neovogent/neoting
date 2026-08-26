import { createHash } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { AppException } from '../../common/problem/problem.js';
import { signPortalLink } from '../chase/index.js';
import { hashOtp, PORTAL_OTP_LOCKOUT_MS, PORTAL_OTP_MAX_ATTEMPTS } from './otp-attempts.js';
import { PortalSessionContextResolver } from './portal-session-context.js';
import { signPortalSessionToken } from './portal-session-token.js';
import { PortalSessionService } from './portal-session.service.js';

/**
 * The A2 lockout against a REAL database as `nt_app`.
 *
 * The unit suite proves the arithmetic; only Postgres can answer the three
 * questions this file exists for, and each of them is a way the feature could
 * be entirely fake while every unit test passed:
 *
 * 1. **`otp_sessions.attempts` and `locked_until` are genuinely WRITTEN.** They
 *    have existed in the schema since it was written and nothing read or wrote
 *    either of them until this stage — a counter that increments only in a test
 *    double is the same as no counter.
 * 2. **The counter row is NOT a usable session.** It is created by a caller who
 *    got the code WRONG, so if the resolver would accept it, counting failures
 *    would have handed out the credential that failing was supposed to withhold.
 *    Asserted through the real resolver against the real row.
 * 3. **The write is legal under the real RLS policy.** `otp_sessions` is a
 *    tenant table under `app_can_access_document(business_id, practice_id)`, so
 *    a wrong scope context silently writes nothing rather than erroring — RLS
 *    fails closed and SILENT, which is exactly the failure a unit double hides.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (a red run)
 * when one is configured but unreachable — a security suite that quietly reports
 * green is worse than none.
 *
 * ⚠ Ids are prefixed **`a2p_`**, disjoint from `p9_` and `p9u_` next door, and
 * teardown names them EXPLICITLY rather than using `startsWith`: Prisma compiles
 * `startsWith` to an unescaped `LIKE 'a2p_%'` in which `_` is a wildcard, so it
 * would reach into another suite's fixtures. That has already eaten one suite's
 * rows in this repo (`vitest.config.ts`), and it is why the memberships and
 * users below are deleted by id list.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const LINK_SECRET = 'a2p-portal-link-secret';
const SESSION_SECRET = 'a2p-portal-session-secret';

const PRACTICE = 'a2p_prac';
const BUSINESS = 'a2p_biz';
const CHASE = 'a2p_chase';
const ACCOUNT = 'a2p_acct';
const TXN = 'a2p_txn';
const SYS_USER = 'a2p_usr_sys';
const MEMBERSHIP = 'a2p_mem';

/** Every id this suite creates, for a teardown that names rows instead of pattern-matching them. */
const USER_IDS = [SYS_USER];
const MEMBERSHIP_IDS = [MEMBERSHIP];

let owner: PrismaClient;
let app: PrismaClient;

const demoConfig = { portalLinkSecret: LINK_SECRET, portalSessionSecret: SESSION_SECRET, otpMode: 'demo' } as const;
const realConfig = { ...demoConfig, otpMode: 'totp' } as const;

const NOW = 1_756_100_000_000;

function linkFor(atMs = NOW): string {
  return signPortalLink({ chaseId: CHASE, expSeconds: 24 * 3600 }, LINK_SECRET, atMs);
}

async function grab(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a throw');
}

async function cleanup(): Promise<void> {
  await owner.otpSession.deleteMany({ where: { businessId: BUSINESS } });
  await owner.chase.deleteMany({ where: { businessId: BUSINESS } });
  await owner.bankTransaction.deleteMany({ where: { businessId: BUSINESS } });
  await owner.bankAccount.deleteMany({ where: { businessId: BUSINESS } });
  await owner.membership.deleteMany({ where: { id: { in: MEMBERSHIP_IDS } } });
  await owner.user.deleteMany({ where: { id: { in: USER_IDS } } });
  await owner.business.deleteMany({ where: { id: BUSINESS } });
  await owner.practice.deleteMany({ where: { id: PRACTICE } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.create({ data: { id: PRACTICE, name: 'A2P Practice' } });
  await owner.business.create({ data: { id: BUSINESS, practiceId: PRACTICE, name: 'A2P Cleaning' } });
  // The practice SYSTEM actor: `createSession` sweeps these to find the chase's
  // practice, and every read and write here runs as one.
  await owner.user.create({ data: { id: SYS_USER, email: 'a2p-system@example.test', kind: 'SYSTEM' } });
  await owner.membership.create({ data: { id: MEMBERSHIP, userId: SYS_USER, practiceId: PRACTICE, role: 'PRACTICE_ADMIN' } });

  await owner.bankAccount.create({ data: { id: ACCOUNT, businessId: BUSINESS, displayName: 'Current' } });
  await owner.bankTransaction.create({
    data: {
      id: TXN,
      businessId: BUSINESS,
      accountId: ACCOUNT,
      bookedAt: new Date('2026-08-05T09:00:00.000Z'),
      amountPence: -60_000,
      descriptionRaw: 'GOOGLE ADS',
      merchantName: 'Google',
    },
  });
  await owner.chase.create({
    data: { id: CHASE, businessId: BUSINESS, detectionEngine: 'UNMATCHED_TRANSACTION', transactionId: TXN, itemRefs: [TXN], state: 'SENT' },
  });
}, 30_000);

afterAll(async () => {
  if (!enabled) return;
  await cleanup();
  await owner.$disconnect();
  await app.$disconnect();
});

describe.skipIf(!enabled)('A2 — the portal OTP lockout, against real RLS', () => {
  test('a wrong code WRITES attempts on a real row, and five of them write locked_until', async () => {
    const service = new PortalSessionService(app, demoConfig);
    const token = linkFor();

    for (let attempt = 1; attempt < PORTAL_OTP_MAX_ATTEMPTS; attempt += 1) {
      expect((await grab(() => service.createSession({ linkToken: token, otp: '111111' }, NOW))).code).toBe('NT-OTP-001');
      const row = await owner.otpSession.findUniqueOrThrow({ where: { linkTokenHash: hashOf(token) } });
      // The whole point of the stage: these two columns now hold something.
      expect(row.attempts).toBe(attempt);
      expect(row.lockedUntil).toBeNull();
    }

    await grab(() => service.createSession({ linkToken: token, otp: '111111' }, NOW));
    const locked = await owner.otpSession.findUniqueOrThrow({ where: { linkTokenHash: hashOf(token) } });
    expect(locked.attempts).toBe(PORTAL_OTP_MAX_ATTEMPTS);
    expect(locked.lockedUntil).toEqual(new Date(NOW + PORTAL_OTP_LOCKOUT_MS));

    // And the correct code is now refused with the SAME 401 — no separate
    // "locked" answer, because a distinguishable one would confirm the link
    // names a real chase.
    const refused = await grab(() => service.createSession({ linkToken: token, otp: '000000' }, NOW));
    expect(refused.code).toBe('NT-OTP-001');
    expect(refused.getStatus()).toBe(401);
    expect(refused.publicDetail).toBe('The link or verification code did not verify. Request a fresh link if this one has expired.');

    await owner.otpSession.deleteMany({ where: { businessId: BUSINESS } });
  });

  test('the counter row is NOT a session — the real resolver refuses a bearer minted over it', async () => {
    const service = new PortalSessionService(app, demoConfig);
    const token = linkFor(NOW + 1);
    await grab(() => service.createSession({ linkToken: token, otp: '111111' }, NOW));

    const row = await owner.otpSession.findUniqueOrThrow({ where: { linkTokenHash: hashOf(token) } });
    expect(row.verifiedAt).toBeNull();
    expect(row.expiresAt).toEqual(new Date(NOW));

    // Counting a failure must not, as a side effect, mint the credential that
    // failing withheld. Even handed a perfectly-signed bearer naming this row,
    // the resolver refuses it.
    const forged = signPortalSessionToken(
      { otpSessionId: row.id, businessId: BUSINESS, practiceId: PRACTICE, expiresAtMs: NOW + 60 * 60 * 1000 },
      SESSION_SECRET,
    );
    const resolver = new PortalSessionContextResolver(app, { portalSessionSecret: SESSION_SECRET });
    const error = await grab(() => resolver.resolve(`Bearer ${forged}`, NOW));
    expect(error.code).toBe('NT-OTP-002');

    await owner.otpSession.deleteMany({ where: { businessId: BUSINESS } });
  });

  test('a successful verification clears both columns on the real row', async () => {
    const service = new PortalSessionService(app, demoConfig);
    const token = linkFor(NOW + 2);

    await grab(() => service.createSession({ linkToken: token, otp: '111111' }, NOW));
    await grab(() => service.createSession({ linkToken: token, otp: '222222' }, NOW));
    expect((await owner.otpSession.findUniqueOrThrow({ where: { linkTokenHash: hashOf(token) } })).attempts).toBe(2);

    await service.createSession({ linkToken: token, otp: '000000' }, NOW);
    const row = await owner.otpSession.findUniqueOrThrow({ where: { linkTokenHash: hashOf(token) } });
    expect(row.attempts).toBe(0);
    expect(row.lockedUntil).toBeNull();
    expect(row.verifiedAt).toEqual(new Date(NOW));

    await owner.otpSession.deleteMany({ where: { businessId: BUSINESS } });
  });

  test('OTP_MODE=totp verifies the MINTED code from otp_sessions.otp_hash, and refuses when none is minted', async () => {
    const service = new PortalSessionService(app, realConfig);
    const token = linkFor(NOW + 3);

    // Nothing has minted a code for this link, so nothing can open it — the
    // honest fail-closed state until a sender writes `otp_hash` (A13 for the
    // chase route, `POST /portal/sign-in-codes` for the invited-client one).
    expect((await grab(() => service.createSession({ linkToken: token, otp: '483920' }, NOW))).code).toBe('NT-OTP-001');

    // Now mint one the way a sender would, on the row the failed attempt left.
    await owner.otpSession.update({
      where: { linkTokenHash: hashOf(token) },
      data: { otpHash: hashOtp('483920'), otpExpiresAt: new Date(NOW + 10 * 60 * 1000), attempts: 0 },
    });

    expect((await grab(() => service.createSession({ linkToken: token, otp: '000000' }, NOW))).code).toBe('NT-OTP-001');
    await expect(service.createSession({ linkToken: token, otp: '483920' }, NOW)).resolves.toBeDefined();

    await owner.otpSession.deleteMany({ where: { businessId: BUSINESS } });
  });
});

/**
 * The service stores `sha256(linkToken)` as hex. Recomputed here rather than
 * imported, so the test asserts the stored SHAPE rather than sharing a helper
 * that would silently agree with the implementation if both changed.
 */
function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
