import { expect, test } from 'vitest';

import { AppException } from '../../common/problem/problem.js';
import type { PrismaClient } from '../../common/db/prisma.js';
import type { Env } from '../../config/env.js';
import { AuthService } from './auth.service.js';
import { verifySessionCookieHeader } from './session-cookie.js';
import { pickActingMembership } from './session-scope.js';

const SECRET = 'test-session-secret';
const env = { SESSION_SECRET: SECRET, OTP_MODE: 'demo', NODE_ENV: 'test' } as Env;

/** Login never touches the database (stateless by design) — a throwing client proves it. */
const untouchablePrisma = new Proxy({} as PrismaClient, {
  get() {
    throw new Error('login must not touch the database — the session is stateless');
  },
});

const service = new AuthService(untouchablePrisma, env);
const GOOD = { email: 'shakib@neoting.test', password: 'demo-neoting-2026', totp: '000000' };

test('valid demo credentials issue a token that verifies back to the mapped userId', () => {
  const session = service.login(GOOD);
  const verdict = verifySessionCookieHeader(`nt_session=${session.token}`, SECRET);
  expect(verdict).toEqual({ ok: true, userId: 'usr_shakib_demo' });
  // 12 h ± test slack — the TTL is the stage's number, not a magic constant to drift.
  expect(session.expiresAt.getTime() - Date.now()).toBeGreaterThan(11.9 * 60 * 60 * 1000);
});

test('every failure mode is the SAME 401 NT-AUTH-003 — no oracle between email, password and TOTP', () => {
  const attempts = [
    { ...GOOD, email: 'nobody@neoting.test' },
    { ...GOOD, password: 'wrong' },
    { ...GOOD, totp: '111111' },
  ];
  for (const attempt of attempts) {
    const err = grab(() => service.login(attempt)) as AppException;
    expect(err).toBeInstanceOf(AppException);
    expect(err.code).toBe('NT-AUTH-003');
    expect(err.getStatus()).toBe(401);
    // Identical public detail across all three — the message must not narrow it.
    expect(err.publicDetail).toBe('The email, password or verification code did not match.');
  }
});

test('email matching is case-insensitive (people type their own address many ways)', () => {
  const session = service.login({ ...GOOD, email: 'Shakib@Neoting.test' });
  expect(verifySessionCookieHeader(`nt_session=${session.token}`, SECRET)).toEqual({ ok: true, userId: 'usr_shakib_demo' });
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

function grab(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function grabAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}
