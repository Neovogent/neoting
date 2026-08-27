import { beforeEach, expect, test } from 'vitest';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { AppException } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import { EmailVerificationService } from './email-verification.service.js';
import { EMAIL_VERIFICATION_TTL_MS, signEmailVerificationToken } from './email-verification.js';
import { signSessionToken } from './session-cookie.js';
import { InMemorySignInThrottle, SIGN_IN_MAX_FAILURES, type SignInThrottle } from './sign-in-throttle.js';

const SECRET = 'test-session-secret';
const env = { SESSION_SECRET: SECRET, NODE_ENV: 'test' } as Env;
const NOW = 1_756_000_000_000;
const EMAIL = 'priya@ledgerline.test';
const USER_ID = 'usr_priya';

interface UserRow {
  id: string;
  kind: string;
  email: string | null;
  emailVerified: boolean;
  deactivatedAt: Date | null;
}

function fakeDb(user: UserRow | null): { client: PrismaClient; row: UserRow | null; reads: () => number } {
  let reads = 0;
  const client = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        reads += 1;
        return user !== null && where.id === user.id ? user : null;
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
  return { client, row: user, reads: () => reads };
}

function human(overrides: Partial<UserRow> = {}): UserRow {
  return { id: USER_ID, kind: 'HUMAN', email: EMAIL, emailVerified: false, deactivatedAt: null, ...overrides };
}

function tokenFor(overrides: { userId?: string; email?: string; expiresAtMs?: number } = {}): string {
  return signEmailVerificationToken(
    { userId: overrides.userId ?? USER_ID, email: overrides.email ?? EMAIL, expiresAtMs: overrides.expiresAtMs ?? NOW + EMAIL_VERIFICATION_TTL_MS },
    SECRET,
  );
}

let throttle: SignInThrottle;
beforeEach(() => {
  throttle = new InMemorySignInThrottle();
});

function service(user: UserRow | null): {
  service: EmailVerificationService;
  row: UserRow | null;
  reads: () => number;
} {
  const db = fakeDb(user);
  return { service: new EmailVerificationService(db.client, env, throttle), row: db.row, reads: db.reads };
}

async function grab(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a throw');
}

test('a valid token proves the address, and the account becomes usable', async () => {
  const { service: svc, row } = service(human());

  const outcome = await svc.verify(tokenFor(), NOW);

  expect(outcome).toEqual({ email: EMAIL, alreadyVerified: false });
  // The one thing this endpoint exists to do. Before it, `emailVerified` could
  // only ever be set by prisma/seed.ts, and `auth.service.ts` refuses a session
  // to an unverified address — so every account created through the product's
  // own front door was permanently unusable.
  expect(row?.emailVerified).toBe(true);
});

test('IDEMPOTENT: a second visit is a 200 that says so, not a conflict', async () => {
  const { service: svc, row } = service(human());
  const token = tokenFor();

  await svc.verify(token, NOW);
  const again = await svc.verify(token, NOW);

  // Corporate mail scanners fetch links before humans click them, and clients
  // retry. A second visit must not turn a working account into an error page.
  expect(again).toEqual({ email: EMAIL, alreadyVerified: true });
  expect(row?.emailVerified).toBe(true);
});

test('REFUSAL: forged, malformed, empty and cross-purpose tokens are ONE NT-AUTH-004', async () => {
  const valid = tokenFor();
  const cases: readonly string[] = [
    '',
    'not-a-token',
    `${valid}x`,
    // Signed with the same SESSION_SECRET, for a different purpose. Without the
    // purpose-derived key in `signed-claims.ts` this would verify — a session
    // cookie would be a standing email-verification token.
    signSessionToken({ userId: USER_ID, expiresAtMs: NOW + 60_000 }, SECRET),
  ];

  for (const token of cases) {
    const { service: svc, row, reads } = service(human());
    const error = await grab(() => svc.verify(token, NOW));
    expect(error.code).toBe('NT-AUTH-004');
    expect(row?.emailVerified).toBe(false);
    // ⚠ AND IT COSTS NO DATABASE ROUND TRIP. A rejected token is one HMAC, so a
    // flood of them cannot be turned into a flood of queries.
    expect(reads()).toBe(0);
  }
});

test('REFUSAL: an expired link is NT-AUTH-005 — distinguished, because asking again is the only remedy', async () => {
  const { service: svc, row } = service(human());
  const token = tokenFor({ expiresAtMs: NOW });

  const error = await grab(() => svc.verify(token, NOW));

  expect(error.code).toBe('NT-AUTH-005');
  expect(error.publicDetail).toContain('expired');
  expect(row?.emailVerified).toBe(false);
});

test('REFUSAL: a token whose user is gone, deactivated, SYSTEM, or has changed address is the SAME NT-AUTH-004', async () => {
  const cases: readonly { user: UserRow | null; token: string }[] = [
    { user: null, token: tokenFor() },
    { user: human({ deactivatedAt: new Date(NOW) }), token: tokenFor() },
    { user: human({ kind: 'SYSTEM' }), token: tokenFor() },
    // The address moved on since the token was minted. Binding the address into
    // the claims is what makes an outstanding link stop working when it does —
    // otherwise the link proves control of a mailbox nobody uses any more.
    { user: human({ email: 'someone.else@ledgerline.test' }), token: tokenFor() },
    { user: human(), token: tokenFor({ userId: 'usr_nobody' }) },
  ];

  for (const { user, token } of cases) {
    const { service: svc, row } = service(user);
    const error = await grab(() => svc.verify(token, NOW));
    // Never split. "This token names a real user" is a fact about somebody, and
    // the whole login lane goes to trouble not to answer it.
    expect(error.code).toBe('NT-AUTH-004');
    expect(error.publicDetail).toBe('That verification link is not valid. Sign up again to get a new one.');
    if (row !== null) expect(row.emailVerified).toBe(false);
  }
});

test('the throttle bounds repeated work against ONE link, and holds the token only as a hash', async () => {
  const { service: svc } = service(human());
  const token = tokenFor({ expiresAtMs: NOW });

  for (let attempt = 0; attempt < SIGN_IN_MAX_FAILURES - 1; attempt += 1) {
    expect((await grab(() => svc.verify(token, NOW))).code).toBe('NT-AUTH-005');
  }
  expect((await grab(() => svc.verify(token, NOW))).code).toBe('NT-RATE-001');

  // ⚠ A live credential is not something to leave in a process-wide Map. The
  // counter is keyed on sha256(token) under an `ev:` namespace, so the token
  // itself never becomes a key — and the namespace keeps it disjoint from the
  // login counter, which is keyed on an email address.
  expect(throttle.inspect(token, NOW).locked).toBe(false);
  expect(throttle.inspect(EMAIL, NOW).locked).toBe(false);
});

test('a different link is unaffected by another link being throttled', async () => {
  const { service: svc, row } = service(human());
  const dead = tokenFor({ expiresAtMs: NOW });
  for (let attempt = 0; attempt < SIGN_IN_MAX_FAILURES; attempt += 1) await grab(() => svc.verify(dead, NOW));

  // Per-token, not per-caller. Stated plainly in the service header, because it
  // is the honest limit of this ceiling rather than a property of it.
  const outcome = await svc.verify(tokenFor(), NOW);
  expect(outcome.alreadyVerified).toBe(false);
  expect(row?.emailVerified).toBe(true);
});
