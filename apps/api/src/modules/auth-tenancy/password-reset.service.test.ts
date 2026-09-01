import { beforeEach, expect, test } from 'vitest';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { AppException } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import type { NotificationsService } from '../notifications/index.js';
import { hashPassword, verifyPasswordHash } from './password.js';
import {
  PASSWORD_RESET_TTL_MS,
  passwordFingerprint,
  signPasswordResetToken,
  verifyPasswordResetToken,
} from './password-reset.js';
import { PasswordResetService } from './password-reset.service.js';
import { signSessionToken } from './session-cookie.js';
import { InMemorySignInThrottle, SIGN_IN_MAX_FAILURES, type SignInThrottle } from './sign-in-throttle.js';

const SECRET = 'test-session-secret';
const env = { SESSION_SECRET: SECRET, NODE_ENV: 'test' } as Env;
const NOW = 1_756_000_000_000;
const EMAIL = 'priya@ledgerline.test';
const USER_ID = 'usr_priya';
// One scrypt for the whole file — hashPassword blocks ~50-100ms per call.
const OLD_HASH = hashPassword('the-old-passphrase');
const NEW_PASSWORD = 'an-entirely-new-passphrase';

interface UserRow {
  id: string;
  kind: string;
  email: string | null;
  emailVerified: boolean;
  deactivatedAt: Date | null;
  passwordHash: string | null;
}

function human(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: USER_ID,
    kind: 'HUMAN',
    email: EMAIL,
    emailVerified: true,
    deactivatedAt: null,
    passwordHash: OLD_HASH,
    ...overrides,
  };
}

function fakeDb(user: UserRow | null): { client: PrismaClient; row: UserRow | null } {
  const client = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        if (user === null) return null;
        if (where.id !== undefined) return where.id === user.id ? user : null;
        return where.email === user.email ? user : null;
      },
      updateMany: async ({ where, data }: { where: Partial<UserRow>; data: Partial<UserRow> }) => {
        if (user === null) return { count: 0 };
        const matches = Object.entries(where).every(([key, value]) => user[key as keyof UserRow] === value);
        if (!matches) return { count: 0 };
        Object.assign(user, data);
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
  return { client, row: user };
}

interface Sent {
  to: string;
  resetLink: string;
  expiresInMinutes: number;
}

function fakeNotifications(refuse = false): { notifications: NotificationsService; sent: Sent[] } {
  const sent: Sent[] = [];
  const notifications = {
    sendPasswordReset: async (input: Sent) => {
      if (refuse) return { sent: false as const, reason: 'address-hourly-ceiling' };
      sent.push(input);
      return { sent: true as const, messageId: 'msg_1' };
    },
  } as unknown as NotificationsService;
  return { notifications, sent };
}

let throttle: SignInThrottle;
beforeEach(() => {
  throttle = new InMemorySignInThrottle();
});

function build(
  user: UserRow | null,
  options: { refuseSend?: boolean } = {},
): { service: PasswordResetService; row: UserRow | null; sent: Sent[] } {
  const db = fakeDb(user);
  const mail = fakeNotifications(options.refuseSend ?? false);
  const service = new PasswordResetService(db.client, env, mail.notifications, throttle, (token) => `https://web.test/signup/reset?token=${encodeURIComponent(token)}`);
  return { service, row: db.row, sent: mail.sent };
}

function tokenFor(overrides: Partial<{ userId: string; email: string; passwordFingerprint: string; expiresAtMs: number }> = {}): string {
  return signPasswordResetToken(
    {
      userId: overrides.userId ?? USER_ID,
      email: overrides.email ?? EMAIL,
      passwordFingerprint: overrides.passwordFingerprint ?? passwordFingerprint(OLD_HASH),
      expiresAtMs: overrides.expiresAtMs ?? NOW + PASSWORD_RESET_TTL_MS,
    },
    SECRET,
  );
}

async function grab(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a throw');
}

// ── the token itself ─────────────────────────────────────────────────────────

test('the token round-trips, and a cross-purpose token signed with the SAME secret does not verify', () => {
  const verdict = verifyPasswordResetToken(tokenFor(), SECRET, NOW);
  expect(verdict.ok).toBe(true);
  if (verdict.ok) expect(verdict.claims.userId).toBe(USER_ID);

  // Same SESSION_SECRET, different purpose label. Without the purpose-derived
  // key a session cookie would double as a standing password-reset token —
  // the exact cross-over `signed-claims.ts` exists to make impossible.
  const cookie = signSessionToken({ userId: USER_ID, expiresAtMs: NOW + 60_000 }, SECRET);
  expect(verifyPasswordResetToken(cookie, SECRET, NOW).ok).toBe(false);

  const stale = verifyPasswordResetToken(tokenFor({ expiresAtMs: NOW }), SECRET, NOW);
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.reason).toBe('expired');
});

// ── request: mint and mail, or silently do nothing ──────────────────────────

test('a usable account gets the mail, with a link the emailed token actually verifies from', async () => {
  const { service, sent } = build(human());

  await service.request(EMAIL, NOW);

  expect(sent).toHaveLength(1);
  expect(sent[0]?.to).toBe(EMAIL);
  expect(sent[0]?.expiresInMinutes).toBe(30);
  const token = new URL(sent[0]?.resetLink ?? '').searchParams.get('token');
  const verdict = verifyPasswordResetToken(token ?? '', SECRET, NOW);
  expect(verdict.ok).toBe(true);
  if (verdict.ok) expect(verdict.claims.passwordFingerprint).toBe(passwordFingerprint(OLD_HASH));
});

test('SILENT 202: unknown, SYSTEM, deactivated, passwordless and unverified addresses all send NOTHING', async () => {
  const cases: readonly (UserRow | null)[] = [
    null,
    human({ kind: 'SYSTEM' }),
    human({ deactivatedAt: new Date(NOW) }),
    human({ passwordHash: null }),
    // Unverified: the reset mail would BE the verification bypass — a link that
    // proves mailbox control on an account whose mailbox was never proven.
    human({ emailVerified: false }),
  ];

  for (const user of cases) {
    const { service, sent } = build(user);
    // No throw, no distinguishable answer — the POST /practices stance. Whether
    // an address has an account here is not the caller's to learn.
    await service.request(EMAIL, NOW);
    expect(sent).toHaveLength(0);
  }
});

test('a refused send is swallowed too — a rate-limited address must look identical to an unknown one', async () => {
  const { service, sent } = build(human(), { refuseSend: true });
  await service.request(EMAIL, NOW);
  expect(sent).toHaveLength(0);
});

// ── reset: spend the token ───────────────────────────────────────────────────

test('a valid token sets the new password, and the SAME token never works twice', async () => {
  const { service, row } = build(human());
  const token = tokenFor();

  await service.reset(token, NEW_PASSWORD, NOW);

  expect(verifyPasswordHash(NEW_PASSWORD, row?.passwordHash ?? '')).toBe(true);
  // Single-use with no table: the spend replaced the hash the fingerprint was
  // minted against, so the token now fails the fingerprint check — as does
  // every OTHER outstanding reset token for this account.
  const again = await grab(() => service.reset(token, 'yet-another-passphrase', NOW));
  expect(again.code).toBe('NT-AUTH-004');
  expect(verifyPasswordHash(NEW_PASSWORD, row?.passwordHash ?? '')).toBe(true);
});

test('REFUSAL: forged, malformed and cross-purpose tokens are ONE NT-AUTH-004; expiry alone is NT-AUTH-005', async () => {
  for (const token of ['', 'not-a-token', `${tokenFor()}x`, signSessionToken({ userId: USER_ID, expiresAtMs: NOW + 60_000 }, SECRET)]) {
    const { service, row } = build(human());
    expect((await grab(() => service.reset(token, NEW_PASSWORD, NOW))).code).toBe('NT-AUTH-004');
    expect(row?.passwordHash).toBe(OLD_HASH);
  }

  const { service } = build(human());
  const expired = await grab(() => service.reset(tokenFor({ expiresAtMs: NOW }), NEW_PASSWORD, NOW));
  expect(expired.code).toBe('NT-AUTH-005');
});

test('REFUSAL: gone, SYSTEM, deactivated, changed-address and changed-password users are the SAME NT-AUTH-004', async () => {
  const cases: readonly { user: UserRow | null; token: string }[] = [
    { user: null, token: tokenFor() },
    { user: human({ kind: 'SYSTEM' }), token: tokenFor() },
    { user: human({ deactivatedAt: new Date(NOW) }), token: tokenFor() },
    { user: human({ email: 'someone.else@ledgerline.test' }), token: tokenFor() },
    // The password changed by another door since the mail went out. The
    // fingerprint mismatch is the single-use mechanism doing its job.
    { user: human(), token: tokenFor({ passwordFingerprint: passwordFingerprint('scrypt$other$hash') }) },
  ];

  for (const { user, token } of cases) {
    const { service, row } = build(user);
    const error = await grab(() => service.reset(token, NEW_PASSWORD, NOW));
    expect(error.code).toBe('NT-AUTH-004');
    if (row !== null) expect(row.passwordHash).toBe(OLD_HASH);
  }
});

test('the throttle bounds repeated spends of ONE link, keyed on a hash in its own pr: space', async () => {
  const { service } = build(human());
  const dead = tokenFor({ expiresAtMs: NOW });

  for (let attempt = 0; attempt < SIGN_IN_MAX_FAILURES - 1; attempt += 1) {
    expect((await grab(() => service.reset(dead, NEW_PASSWORD, NOW))).code).toBe('NT-AUTH-005');
  }
  expect((await grab(() => service.reset(dead, NEW_PASSWORD, NOW))).code).toBe('NT-RATE-001');

  // The raw token is never a Map key, and the counter shares nothing with the
  // login counter (keyed on an address) or verification's `ev:` space.
  expect(throttle.inspect(dead, NOW).locked).toBe(false);
  expect(throttle.inspect(EMAIL, NOW).locked).toBe(false);

  // A fresh link is unaffected — per-token, not per-caller, stated honestly.
  const { service: fresh, row } = build(human());
  await fresh.reset(tokenFor(), NEW_PASSWORD, NOW);
  expect(verifyPasswordHash(NEW_PASSWORD, row?.passwordHash ?? '')).toBe(true);
});
