import { expect, test } from 'vitest';

import { AppException } from '../../common/problem/problem.js';
import type { PrismaClient } from '../../common/db/prisma.js';
import type { Env } from '../../config/env.js';
import { AuthService } from './auth.service.js';
import { hashPassword } from './password.js';
import { verifySessionCookieHeader } from './session-cookie.js';
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
}

function row(overrides: Partial<UserRow> & Pick<UserRow, 'id'>): UserRow {
  return { kind: 'HUMAN', passwordHash: null, emailVerified: true, deactivatedAt: null, ...overrides };
}

/**
 * Login READS one user row (A1) and WRITES nothing. This double allows exactly
 * that read and throws on every other client member, so a write — or a second
 * query — fails the test rather than passing unnoticed. `lookups` records the
 * normalised email the service asked for.
 */
function prismaWithUsers(users: Readonly<Record<string, UserRow>>): { client: PrismaClient; lookups: string[] } {
  const lookups: string[] = [];
  const client = new Proxy({} as PrismaClient, {
    get(_target, property) {
      if (property === 'user') {
        return {
          findUnique: async ({ where }: { where: { email: string } }) => {
            lookups.push(where.email);
            return users[where.email] ?? null;
          },
        };
      }
      throw new Error(`login touched prisma.${String(property)} — it may read the user row and nothing else`);
    },
  });
  return { client, lookups };
}

/** The seeded fixture user behind the demo credential table (prisma/seed.ts). */
const SEEDED_DEMO = { 'shakib@neoting.test': row({ id: 'usr_shakib_demo' }) };

const service = new AuthService(prismaWithUsers(SEEDED_DEMO).client, env);
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
  const session = await new AuthService(prismaWithUsers(users).client, env).login({
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
  const auth = new AuthService(prismaWithUsers(users).client, env);

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
  const auth = new AuthService(prismaWithUsers(users).client, env);
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
  const auth = new AuthService(prismaWithUsers(SEEDED_DEMO).client, production);
  const err = (await grabAsync(() => auth.login(GOOD))) as AppException;
  expect(err).toBeInstanceOf(AppException);
  expect(err.code).toBe('NT-AUTH-003');
  // …and the same credentials still work outside production, so this is a gate,
  // not a broken fixture.
  await expect(new AuthService(prismaWithUsers(SEEDED_DEMO).client, env).login(GOOD)).resolves.toBeDefined();
});

test('email matching is case-insensitive, and normalised ONCE before the lookup', async () => {
  const { client, lookups } = prismaWithUsers(SEEDED_DEMO);
  const session = await new AuthService(client, env).login({ ...GOOD, email: '  Shakib@Neoting.test ' });
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
        { practiceId: 'prac_1', businessId: 'biz_burger', role: 'PRACTICE_STANDARD' },
        { practiceId: 'prac_1', businessId: null, role: 'PRACTICE_ADMIN' },
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

  const me = await new AuthService(prisma, env).me({
    actorId: 'usr_shakib_demo',
    practiceId: 'prac_1',
    sessionScope: 'user',
    grantedItemIds: [],
  });

  expect(transactions).toBe(1);
  expect(me.user).toEqual({ id: 'usr_shakib_demo', email: 'shakib@neoting.test', firstName: 'Shakib', lastName: 'Bin Kabir' });
  expect(me.practice).toEqual({ id: 'prac_1', name: 'Neovogent Accounting' });
  expect(me.role).toBe('PRACTICE_ADMIN');
  expect(me.businesses).toEqual([{ id: 'biz_burger', name: 'American Burger Ltd' }]);
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
    new AuthService(prisma, env).me({ actorId: 'usr_gone', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] }),
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
