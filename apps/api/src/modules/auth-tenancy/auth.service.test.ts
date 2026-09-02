import { expect, test } from 'vitest';

import { AppException } from '../../common/problem/problem.js';
import type { PrismaClient } from '../../common/db/prisma.js';
import type { Env } from '../../config/env.js';
import { AuthService } from './auth.service.js';
import { hashPassword } from './password.js';
import { verifySessionCookieHeader } from './session-cookie.js';
import { InMemorySignInThrottle, RateLimitedException, SIGN_IN_MAX_FAILURES, SIGN_IN_WINDOW_MS } from './sign-in-throttle.js';
import { createTotpEnrolment, recoveryCodesRemaining, TOTP_PERIOD_SECONDS, totpEngine, verifySecondFactor } from './totp.js';
import { pickActingMembership } from './session-scope.js';

const SECRET = 'test-session-secret';
const env = { SESSION_SECRET: SECRET, OTP_MODE: 'demo', NODE_ENV: 'test' } as Env;

/** The shape `findCredentialRow` selects. Defaults are "a healthy account". */
interface UserRow {
  id: string;
  kind: string;
  passwordHash: string | null;
  emailVerified: boolean;
  deactivatedAt: Date | null;
  totpSecretRef: string | null;
}

function row(overrides: Partial<UserRow> & Pick<UserRow, 'id'>): UserRow {
  return { kind: 'HUMAN', passwordHash: null, emailVerified: true, deactivatedAt: null, totpSecretRef: null, ...overrides };
}

/**
 * Login READS one user row (A1) and, since A2, WRITES exactly one thing: the
 * shortened envelope after a recovery code is spent. This double allows those
 * two operations on `users` and throws on every other client member, so a
 * session row, a `lastLoginAt` or a second query fails the test rather than
 * passing unnoticed. `lookups` records the normalised email the service asked
 * for; `updates` records every write.
 */
function prismaWithUsers(users: Readonly<Record<string, UserRow>>): {
  client: PrismaClient;
  lookups: string[];
  updates: { id: string; data: Record<string, unknown> }[];
} {
  const lookups: string[] = [];
  const updates: { id: string; data: Record<string, unknown> }[] = [];
  const client = new Proxy({} as PrismaClient, {
    get(_target, property) {
      if (property === 'user') {
        return {
          findUnique: async ({ where }: { where: { email: string } }) => {
            lookups.push(where.email);
            return users[where.email] ?? null;
          },
          update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            updates.push({ id: where.id, data });
            return { id: where.id };
          },
        };
      }
      throw new Error(`login touched prisma.${String(property)} — it may read the user row and update it and nothing else`);
    },
  });
  return { client, lookups, updates };
}

/** The seeded fixture user behind the demo credential table (prisma/seed.ts). */
const SEEDED_DEMO = { 'shakib@neoting.test': row({ id: 'usr_shakib_demo' }) };

const service = new AuthService(prismaWithUsers(SEEDED_DEMO).client, env, new InMemorySignInThrottle());
const GOOD = { email: 'shakib@neoting.test', password: 'demo-neoting-2026', totp: '000000' };

test('valid demo credentials issue a token that verifies back to the mapped userId', async () => {
  const session = await service.login(GOOD);
  const verdict = verifySessionCookieHeader(`nt_session=${session.token}`, SECRET);
  expect(verdict).toEqual({ ok: true, userId: 'usr_shakib_demo' });
  // 12 h ± test slack — the TTL is the stage's number, not a magic constant to drift.
  expect(session.expiresAt.getTime() - Date.now()).toBeGreaterThan(11.9 * 60 * 60 * 1000);
});

test('a real stored credential (A1 signup) issues a session — no demo table involved', async () => {
  const users = { 'priya@ledgerline.test': row({ id: 'usr_priya', passwordHash: hashPassword('correct horse battery') }) };
  const session = await new AuthService(prismaWithUsers(users).client, env, new InMemorySignInThrottle()).login({
    email: 'priya@ledgerline.test',
    password: 'correct horse battery',
    totp: '000000',
  });
  expect(verifySessionCookieHeader(`nt_session=${session.token}`, SECRET)).toEqual({ ok: true, userId: 'usr_priya' });
});

test('every failure mode is the SAME 401 NT-AUTH-003 — no oracle between email, password and TOTP', async () => {
  const attempts = [
    { ...GOOD, email: 'nobody@neoting.test' },
    { ...GOOD, password: 'wrong' },
    { ...GOOD, totp: '111111' },
  ];
  for (const attempt of attempts) {
    const err = (await grabAsync(() => service.login(attempt))) as AppException;
    expect(err).toBeInstanceOf(AppException);
    expect(err.code).toBe('NT-AUTH-003');
    expect(err.getStatus()).toBe(401);
    // Identical public detail across all three — the message must not narrow it.
    expect(err.publicDetail).toBe('The email, password or verification code did not match.');
  }
});

test('A1 REFUSAL: an unverified address cannot log in, with the SAME 401 as a wrong password', async () => {
  const password = 'a-perfectly-good-passphrase';
  const users = { 'new@firm.test': row({ id: 'usr_new', passwordHash: hashPassword(password), emailVerified: false }) };
  const auth = new AuthService(prismaWithUsers(users).client, env, new InMemorySignInThrottle());

  const refused = (await grabAsync(() => auth.login({ email: 'new@firm.test', password, totp: '000000' }))) as AppException;
  expect(refused).toBeInstanceOf(AppException);
  expect(refused.getStatus()).toBe(401);
  // The SAME code and the SAME words as "wrong password". Saying "verify your
  // email" here would confirm the address is registered — the exact question
  // POST /v1/practices answers with a contentless 202 to avoid.
  expect(refused.code).toBe('NT-AUTH-003');
  expect(refused.publicDetail).toBe('The email, password or verification code did not match.');
});

test('a deactivated user and a SYSTEM actor are refused even with the right password', async () => {
  const password = 'a-perfectly-good-passphrase';
  const users = {
    'gone@firm.test': row({ id: 'usr_gone', passwordHash: hashPassword(password), deactivatedAt: new Date() }),
    'robot@firm.test': row({ id: 'usr_robot', passwordHash: hashPassword(password), kind: 'SYSTEM' }),
  };
  const auth = new AuthService(prismaWithUsers(users).client, env, new InMemorySignInThrottle());
  for (const email of ['gone@firm.test', 'robot@firm.test']) {
    const err = (await grabAsync(() => auth.login({ email, password, totp: '000000' }))) as AppException;
    expect(err).toBeInstanceOf(AppException);
    expect(err.code).toBe('NT-AUTH-003');
  }
});

test('PRODUCTION REFUSES the demo credential table — a published password mints no session', async () => {
  // Same seeded row, same published fixture password, only NODE_ENV differs.
  // The user has no password_hash, so with the fixture table refused there is
  // nothing left to authenticate against.
  const production = { ...env, NODE_ENV: 'production' } as Env;
  const auth = new AuthService(prismaWithUsers(SEEDED_DEMO).client, production, new InMemorySignInThrottle());
  const err = (await grabAsync(() => auth.login(GOOD))) as AppException;
  expect(err).toBeInstanceOf(AppException);
  expect(err.code).toBe('NT-AUTH-003');
  // …and the same credentials still work outside production, so this is a gate,
  // not a broken fixture.
  await expect(new AuthService(prismaWithUsers(SEEDED_DEMO).client, env, new InMemorySignInThrottle()).login(GOOD)).resolves.toBeDefined();
});

test('email matching is case-insensitive, and normalised ONCE before the lookup', async () => {
  const { client, lookups } = prismaWithUsers(SEEDED_DEMO);
  const session = await new AuthService(client, env, new InMemorySignInThrottle()).login({ ...GOOD, email: '  Shakib@Neoting.test ' });
  expect(verifySessionCookieHeader(`nt_session=${session.token}`, SECRET)).toEqual({ ok: true, userId: 'usr_shakib_demo' });
  // The database is asked for the normalised form — `users.email` is unique on
  // the literal bytes, so a lookup by the typed form would miss its own row.
  expect(lookups).toEqual(['shakib@neoting.test']);
});

test('me() projects user + practice + acting role + RLS-visible businesses from ONE scoped transaction', async () => {
  let transactions = 0;
  const tx = {
    $executeRaw: async () => 0,
    user: {
      findUnique: async () => ({ id: 'usr_shakib_demo', email: 'shakib@neoting.test', firstName: 'Shakib', lastName: 'Bin Kabir' }),
    },
    membership: {
      findMany: async () => [
        // Business-scoped row FIRST — the practice-wide row must still win the acting role.
        // ⚠ `isOwner` is on every row because the real `select` reads it and the
        // contract makes it REQUIRED on `/me`: a fixture without it returns
        // `isOwner: undefined`, which the browser's own `.strict()`
        // `getMeResponse` rejects as contract drift. Omitting it here made the
        // suite unable to notice the `select` losing the column.
        { practiceId: 'prac_1', businessId: 'biz_burger', role: 'PRACTICE_STANDARD', isOwner: false },
        { practiceId: 'prac_1', businessId: null, role: 'PRACTICE_ADMIN', isOwner: true },
      ],
    },
    practice: { findUnique: async () => ({ id: 'prac_1', name: 'Neovogent Accounting' }) },
    business: { findMany: async () => [{ id: 'biz_burger', name: 'American Burger Ltd' }] },
  };
  const prisma = {
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      transactions += 1;
      return fn(tx);
    },
  } as unknown as PrismaClient;

  const me = await new AuthService(prisma, env, new InMemorySignInThrottle()).me({
    actorId: 'usr_shakib_demo',
    practiceId: 'prac_1',
    sessionScope: 'user',
    grantedItemIds: [],
  });

  expect(transactions).toBe(1);
  expect(me.user).toEqual({ id: 'usr_shakib_demo', email: 'shakib@neoting.test', firstName: 'Shakib', lastName: 'Bin Kabir' });
  expect(me.practice).toEqual({ id: 'prac_1', name: 'Neovogent Accounting' });
  expect(me.role).toBe('PRACTICE_ADMIN');
  // D44's other half, and it is read off the SAME acting membership as `role` —
  // the release gate is `role AND isOwner`, so a screen that reads one without
  // the other cannot degrade honestly. The contract makes it required.
  expect(me.isOwner).toBe(true);
  expect(me.businesses).toEqual([{ id: 'biz_burger', name: 'American Burger Ltd' }]);
});

test('isOwner follows the ACTING membership — a practice admin who does not own the practice is not the owner', async () => {
  // Same shape as above with the flag flipped: it must come off the row that
  // decided the role, not off "any membership with it set".
  const tx = {
    $executeRaw: async () => 0,
    user: {
      findUnique: async () => ({ id: 'usr_priya', email: 'priya@neoting.test', firstName: 'Priya', lastName: 'Shah' }),
    },
    membership: {
      findMany: async () => [
        { practiceId: 'prac_1', businessId: 'biz_burger', role: 'PRACTICE_STANDARD', isOwner: true },
        { practiceId: 'prac_1', businessId: null, role: 'PRACTICE_ADMIN', isOwner: false },
      ],
    },
    practice: { findUnique: async () => ({ id: 'prac_1', name: 'Neovogent Accounting' }) },
    business: { findMany: async () => [] },
  };
  const prisma = {
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;

  const me = await new AuthService(prisma, env, new InMemorySignInThrottle()).me({
    actorId: 'usr_priya',
    practiceId: 'prac_1',
    sessionScope: 'user',
    grantedItemIds: [],
  });

  expect(me.role).toBe('PRACTICE_ADMIN');
  expect(me.isOwner).toBe(false);
});

test('me() for a session whose user vanished mid-flight is a 401, not a 500', async () => {
  const tx = {
    $executeRaw: async () => 0,
    user: { findUnique: async () => null },
    membership: { findMany: async () => [] },
    practice: { findUnique: async () => null },
    business: { findMany: async () => [] },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
  const err = (await grabAsync(() =>
    new AuthService(prisma, env, new InMemorySignInThrottle()).me({ actorId: 'usr_gone', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] }),
  )) as AppException;
  expect(err).toBeInstanceOf(AppException);
  expect(err.getStatus()).toBe(401);
});

test('pickActingMembership: practice-wide beats practice+business beats business-only; none is null', () => {
  const practiceWide = { practiceId: 'p', businessId: null, role: 'PRACTICE_ADMIN' };
  const practiceScoped = { practiceId: 'p', businessId: 'b', role: 'PRACTICE_STANDARD' };
  const businessOnly = { practiceId: null, businessId: 'b', role: 'BUSINESS_ADMIN' };
  expect(pickActingMembership([businessOnly, practiceScoped, practiceWide])).toBe(practiceWide);
  expect(pickActingMembership([businessOnly, practiceScoped])).toBe(practiceScoped);
  expect(pickActingMembership([businessOnly])).toBe(businessOnly);
  expect(pickActingMembership([])).toBeNull();
});

async function grabAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A2 — the lockout, and what a locked response is allowed to reveal
// ─────────────────────────────────────────────────────────────────────────────

const NOW = 1_756_000_000_000;

/** A service with its OWN throttle, so one test's failures cannot lock another's address. */
function authWith(users: Readonly<Record<string, UserRow>>, overrides: Partial<Env> = {}) {
  const prisma = prismaWithUsers(users);
  return { ...prisma, service: new AuthService(prisma.client, { ...env, ...overrides } as Env, new InMemorySignInThrottle()) };
}

test('A2 REFUSAL: the lockout is keyed on the ADDRESS, so a registered and an unregistered one lock IDENTICALLY', async () => {
  // THE ENUMERATION PROOF. A lockout keyed on `users.id` could only ever fire
  // for an account that exists, which makes "you are locked out" a confirmed
  // yes to "is this firm registered here" — the exact question A1's uniform
  // NT-AUTH-003 refuses to answer. Keyed on the submitted string, the two
  // addresses are indistinguishable at every step, and this asserts it.
  const registered = 'shakib@neoting.test';
  const unregistered = 'nobody-at-all@nowhere.invalid';
  const { service } = authWith(SEEDED_DEMO);

  const shape = (error: unknown) => ({
    kind: error instanceof RateLimitedException ? 'rate-limited' : 'unauthorised',
    code: (error as AppException).code,
    status: (error as AppException).getStatus(),
    detail: (error as AppException).publicDetail,
  });

  const trace: Record<string, unknown[]> = { [registered]: [], [unregistered]: [] };
  for (const email of [registered, unregistered]) {
    for (let attempt = 0; attempt < SIGN_IN_MAX_FAILURES; attempt += 1) {
      trace[email]!.push(shape(await grabAsync(() => service.login({ ...GOOD, email, password: 'wrong' }, NOW))));
    }
  }

  expect(trace[registered]).toEqual(trace[unregistered]);
  // …and the shape itself: nine plain 401s, then the 429 that names the ADDRESS
  // and never an account.
  expect(trace[registered]!.slice(0, SIGN_IN_MAX_FAILURES - 1)).toEqual(
    Array.from({ length: SIGN_IN_MAX_FAILURES - 1 }, () => ({
      kind: 'unauthorised',
      code: 'NT-AUTH-003',
      status: 401,
      detail: 'The email, password or verification code did not match.',
    })),
  );
  expect(trace[registered]!.at(-1)).toEqual({
    kind: 'rate-limited',
    code: 'NT-RATE-001',
    status: 429,
    detail: 'Too many sign-in attempts for this email address. Try again shortly.',
  });
});

test('A2 REFUSAL: once locked, even the CORRECT credentials are refused — and no scrypt is spent finding out', async () => {
  const { service, lookups } = authWith(SEEDED_DEMO);
  for (let attempt = 0; attempt < SIGN_IN_MAX_FAILURES; attempt += 1) {
    await grabAsync(() => service.login({ ...GOOD, password: 'wrong' }, NOW));
  }
  const before = lookups.length;

  const locked = (await grabAsync(() => service.login(GOOD, NOW))) as RateLimitedException;
  expect(locked).toBeInstanceOf(RateLimitedException);
  expect(locked.retryAfterSeconds).toBeGreaterThan(0);
  // The lock is checked BEFORE the user row is read, so a flood costs the
  // database nothing and the event loop no scrypt. A lockout that still does
  // the work is an amplifier, not a defence.
  expect(lookups.length).toBe(before);
});

test('A2: the lock lifts when the window passes, and a success clears the counter before it', async () => {
  const { service } = authWith(SEEDED_DEMO);
  for (let attempt = 0; attempt < SIGN_IN_MAX_FAILURES; attempt += 1) {
    await grabAsync(() => service.login({ ...GOOD, password: 'wrong' }, NOW));
  }
  await expect(service.login(GOOD, NOW + SIGN_IN_WINDOW_MS + 1)).resolves.toBeDefined();

  // Nine failures then a success leaves nothing behind: the tenth failure after
  // it must be an ordinary 401, not the lock the counter would otherwise carry.
  const later = NOW + 2 * SIGN_IN_WINDOW_MS;
  for (let attempt = 0; attempt < SIGN_IN_MAX_FAILURES - 1; attempt += 1) {
    await grabAsync(() => service.login({ ...GOOD, password: 'wrong' }, later));
  }
  await expect(service.login(GOOD, later)).resolves.toBeDefined();
  const next = (await grabAsync(() => service.login({ ...GOOD, password: 'wrong' }, later))) as AppException;
  expect(next.code).toBe('NT-AUTH-003');
});

// ─────────────────────────────────────────────────────────────────────────────
// A2 — the real second factor
// ─────────────────────────────────────────────────────────────────────────────

/** The SERVER's own engine, so a test code is generated with the parameters the server verifies with. */
const codes = totpEngine;
const PASSPHRASE = 'a-perfectly-good-passphrase';

/** An enrolled account, exactly as `TotpEnrolmentService.begin` would leave it. */
function enrolled() {
  const enrolment = createTotpEnrolment('priya@ledgerline.test', SECRET);
  const users = {
    'priya@ledgerline.test': row({ id: 'usr_priya', passwordHash: hashPassword(PASSPHRASE), totpSecretRef: enrolment.ref }),
  };
  return { enrolment, ...authWith(users, { OTP_MODE: 'totp' }) };
}

test('A2: OTP_MODE=totp verifies a REAL RFC 6238 code, and the published 000000 stops working', async () => {
  const { service, enrolment } = enrolled();
  const code = await codes.generate({ secret: enrolment.secret, epoch: Math.floor(NOW / 1000) });

  await expect(service.login({ email: 'priya@ledgerline.test', password: PASSPHRASE, totp: code }, NOW)).resolves.toBeDefined();

  // The fixed demo code is not a code any more. This is the hole A2 exists to
  // close: one string that opened every account in every practice.
  const refused = (await grabAsync(() =>
    service.login({ email: 'priya@ledgerline.test', password: PASSPHRASE, totp: '000000' }, NOW),
  )) as AppException;
  expect(refused.code).toBe('NT-AUTH-003');
});

test('A2 REFUSAL: a code from the WRONG secret, and a code from too long ago, are both refused', async () => {
  const { service, enrolment } = enrolled();
  const stranger = createTotpEnrolment('someone@else.test', SECRET);
  const wrongSecret = await codes.generate({ secret: stranger.secret, epoch: Math.floor(NOW / 1000) });
  const stale = await codes.generate({ secret: enrolment.secret, epoch: Math.floor(NOW / 1000) - 10 * TOTP_PERIOD_SECONDS });

  for (const totp of [wrongSecret, stale]) {
    const error = (await grabAsync(() => service.login({ email: 'priya@ledgerline.test', password: PASSPHRASE, totp }, NOW))) as AppException;
    expect(error.code).toBe('NT-AUTH-003');
    expect(error.getStatus()).toBe(401);
  }
});

test('A2 REFUSAL: under totp, an account with NO enrolment fails closed — there is no "not configured, let them in"', async () => {
  const users = { 'new@firm.test': row({ id: 'usr_new', passwordHash: hashPassword(PASSPHRASE) }) };
  const { service } = authWith(users, { OTP_MODE: 'totp' });
  for (const totp of ['000000', '123456']) {
    const error = (await grabAsync(() => service.login({ email: 'new@firm.test', password: PASSPHRASE, totp }, NOW))) as AppException;
    expect(error.code).toBe('NT-AUTH-003');
  }
});

test('A2 REFUSAL: the SAME code cannot be replayed inside its own window', async () => {
  const { service, enrolment } = enrolled();
  const code = await codes.generate({ secret: enrolment.secret, epoch: Math.floor(NOW / 1000) });
  const credentials = { email: 'priya@ledgerline.test', password: PASSPHRASE, totp: code };

  await expect(service.login(credentials, NOW)).resolves.toBeDefined();
  // A code shoulder-surfed or captured in flight is live for its whole step
  // plus the tolerance either side. Claiming the step spends it.
  const replay = (await grabAsync(() => service.login(credentials, NOW + 1000))) as AppException;
  expect(replay.code).toBe('NT-AUTH-003');
});

test('A2: a recovery code signs in ONCE — it is removed from the envelope, and the second use fails', async () => {
  // ⚠ Service-level, and it has to be: `SessionCreateRequest.totp` is
  // `pattern: '^[0-9]{6}$'` in the contract, so a nineteen-character recovery
  // code is a 400 at the controller and never reaches here over HTTP. The
  // mechanism is correct and unreachable — the gap is recorded in `totp.ts` and
  // in the A2 report, and `packages/contracts` is LAW.
  const { service, enrolment, updates } = enrolled();
  const [first, second] = enrolment.recoveryCodes as readonly [string, string, ...string[]];
  const credentials = { email: 'priya@ledgerline.test', password: PASSPHRASE, totp: first };

  await expect(service.login(credentials, NOW)).resolves.toBeDefined();

  // The ONE write login makes, and it is the thing that makes "single use" a
  // property rather than a promise: the shortened envelope is persisted.
  expect(updates).toHaveLength(1);
  expect(updates[0]?.id).toBe('usr_priya');
  const rewrapped = updates[0]?.data['totpSecretRef'] as string;
  expect(rewrapped).not.toBe(enrolment.ref);
  expect(recoveryCodesRemaining(rewrapped, SECRET)).toBe(enrolment.recoveryCodes.length - 1);

  // No plaintext code survives anywhere in what was stored.
  expect(rewrapped).not.toContain(first);
  expect(rewrapped).not.toContain(second);

  // Asserted against the NEW envelope, because the double does not mutate the
  // row it hands back — which is exactly why the write has to happen at all.
  expect((await verifySecondFactor(rewrapped, first, SECRET, NOW)).ok).toBe(false);
  expect((await verifySecondFactor(rewrapped, second, SECRET, NOW)).ok).toBe(true);
});

test('A2: a successful TOTP sign-in writes NOTHING — only a spent recovery code does', async () => {
  const { service, enrolment, updates } = enrolled();
  const code = await codes.generate({ secret: enrolment.secret, epoch: Math.floor(NOW / 1000) });
  await service.login({ email: 'priya@ledgerline.test', password: PASSPHRASE, totp: code }, NOW);
  expect(updates).toEqual([]);
});
