import { expect, test } from 'vitest';

import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { PrismaClient } from '../../common/db/prisma.js';
import { AppException } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import { verifyEmailVerificationToken } from './email-verification.js';
import { verifyPasswordHash } from './password.js';
import { PracticeSignupService, TERMS_VERSION_IN_FORCE, type PracticeSignupInput } from './practice-signup.service.js';
import { RecordingSignupMailer, type SignupMailer } from './signup-mailer.js';

/**
 * Practice signup, offline (launch stage A1). The database is a double here;
 * the real transaction, the real RLS and the real unique index are proven in
 * `practice-signup.integration.test.ts`.
 *
 * Weighted towards REFUSALS on purpose — this is the auth path, and the happy
 * case is the one everybody writes.
 */

const SECRET = 'test-session-secret';
const env = { SESSION_SECRET: SECRET, OTP_MODE: 'demo', NODE_ENV: 'test' } as Env;

const INPUT: PracticeSignupInput = {
  practiceName: 'Ledgerline Accounting LLP',
  firstName: 'Priya',
  lastName: 'Raman',
  email: 'Priya@Ledgerline.test',
  password: 'a-perfectly-good-passphrase',
  acceptedTermsVersion: TERMS_VERSION_IN_FORCE,
};

const META = { idempotencyKey: '11111111-1111-4111-8111-111111111111', traceId: 'trace-1' };

interface Written {
  practices: { name: string }[];
  users: {
    id: string;
    kind?: string;
    email?: string | null;
    emailVerified?: boolean;
    passwordHash?: string | null;
    firstName: string;
    lastName: string;
  }[];
  memberships: { userId: string; practiceId: string | null; role: string; isOwner: boolean; businessId?: string | null }[];
  auditEvents: { event: string; businessId: string | null; seq: bigint; outcome: Record<string, unknown> }[];
  transactions: number;
  rolledBack: number;
}

/**
 * A Prisma double that behaves like the real thing on the two properties this
 * service depends on: the transaction is atomic (a throw discards every write
 * made inside it), and `users.email` is unique.
 */
function fakePrisma(options: { existingEmails?: readonly string[]; failUserCreateWithP2002?: boolean } = {}): {
  client: PrismaClient;
  written: Written;
} {
  const existing = new Set(options.existingEmails ?? []);
  const written: Written = { practices: [], users: [], memberships: [], auditEvents: [], transactions: 0, rolledBack: 0 };
  let ids = 0;

  const client = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      written.transactions += 1;
      const staged: Written = { practices: [], users: [], memberships: [], auditEvents: [], transactions: 0, rolledBack: 0 };
      const tx = {
        $executeRaw: async () => 0,
        user: {
          findUnique: async ({ where }: { where: { email: string } }) =>
            existing.has(where.email) ? { id: `usr_existing` } : null,
          create: async ({ data }: { data: Omit<Written['users'][number], 'id'> }) => {
            if (options.failUserCreateWithP2002 === true) {
              throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['email'] } });
            }
            const id = `usr_${(ids += 1)}`;
            staged.users.push({ ...data, id });
            return { id };
          },
        },
        practice: {
          create: async ({ data }: { data: { name: string } }) => {
            staged.practices.push(data);
            return { id: `prac_${(ids += 1)}` };
          },
        },
        membership: {
          create: async ({ data }: { data: Written['memberships'][number] }) => {
            staged.memberships.push(data);
            return { id: `mem_${(ids += 1)}` };
          },
        },
        auditEvent: {
          findFirst: async () => null,
          create: async ({ data }: { data: Written['auditEvents'][number] }) => {
            staged.auditEvents.push(data);
            return data;
          },
        },
      };
      try {
        const result = await fn(tx);
        written.practices.push(...staged.practices);
        written.users.push(...staged.users);
        written.memberships.push(...staged.memberships);
        written.auditEvents.push(...staged.auditEvents);
        return result;
      } catch (error) {
        // Atomic: nothing staged is kept. This is what makes the duplicate-race
        // assertion below meaningful rather than decorative.
        written.rolledBack += 1;
        throw error;
      }
    },
  } as unknown as PrismaClient;

  return { client, written };
}

function build(options: Parameters<typeof fakePrisma>[0] = {}, overrides: { env?: Env; mailer?: SignupMailer } = {}) {
  const { client, written } = fakePrisma(options);
  const mailer = overrides.mailer ?? new RecordingSignupMailer();
  const service = new PracticeSignupService(client, overrides.env ?? env, mailer, new InMemoryIdempotencyStore());
  return { service, written, mailer: mailer as RecordingSignupMailer };
}

test('the happy path writes practice + human + SYSTEM actor in ONE transaction, and nothing else', async () => {
  const { service, written } = build();
  await service.signUp(INPUT, META);

  expect(written.transactions).toBe(1);
  expect(written.practices).toEqual([{ name: 'Ledgerline Accounting LLP' }]);
  // TWO of each: the person signing up, and the practice's machine actor.
  expect(written.users).toHaveLength(2);
  expect(written.memberships).toHaveLength(2);
});

/**
 * ⚠ **The counts above read `1` until 28 Aug 2026, and that pin is what let
 * this ship.** The only thing that ever created a `SYSTEM` user was
 * `prisma/seed.ts`, so a practice born here had none — and everything with no
 * human behind it resolves one per practice: the ingest and extract workers, the
 * chase portal's session lookup, the capability-link resolver, and the invited
 * client's `POST /portal/sign-in-codes`. `resolveSystemActor` THROWS in that
 * state.
 *
 * It was invisible because every seeded demo has one. The symptom that finally
 * surfaced it was an invited client pressing "send me a code" and nothing
 * arriving, with a `202` on screen and not one line in the logs.
 *
 * So this asserts the actor's SHAPE, not merely that a second row exists: a
 * SYSTEM user that could sign in, or one whose membership named a business
 * rather than the practice, would satisfy a count and still be wrong.
 */
test('the practice gets its machine actor, and it cannot sign in', async () => {
  const { service, written } = build();
  await service.signUp(INPUT, META);

  const system = written.users.find((u) => u.kind === 'SYSTEM');
  expect(system).toBeDefined();
  // No email and no password hash, so it cannot authenticate even if it leaks
  // onto a screen — and a null email never collides on the unique key.
  expect(system!.email ?? null).toBeNull();
  expect(system!.passwordHash ?? null).toBeNull();

  const membership = written.memberships.find((m) => m.userId === system!.id);
  expect(membership).toBeDefined();
  // Practice-WIDE, so `resolveSystemActor`'s lookup by practice finds it.
  expect(membership!.practiceId).not.toBeNull();
  expect(membership!.businessId ?? null).toBeNull();
  // PRACTICE_STANDARD, never an admin role: D44 reserves release authority for a
  // human super admin, and a machine that could release could publish.
  expect(membership!.role).toBe('PRACTICE_STANDARD');
  expect(membership!.isOwner ?? false).toBe(false);
});

test('the first HUMAN is PRACTICE_ADMIN, practice-WIDE, and the super admin (D44 release authority)', async () => {
  const { service, written } = build();
  await service.signUp(INPUT, META);

  const human = written.users.find((u) => u.kind !== 'SYSTEM')!;
  const membership = written.memberships.find((m) => m.userId === human.id)!;
  expect(membership.role).toBe('PRACTICE_ADMIN');
  expect(membership.isOwner).toBe(true);
  // businessId stays absent so `pickActingMembership` resolves this user to the
  // whole workspace, not to one client.
  expect(membership.businessId ?? null).toBeNull();
  expect(membership.practiceId).not.toBeNull();
});

test('the account starts UNVERIFIED and the password is stored as a scrypt hash, never in clear', async () => {
  const { service, written } = build();
  await service.signUp(INPUT, META);

  const user = written.users.find((u) => u.kind !== 'SYSTEM')!;
  expect(user.emailVerified).toBe(false);
  expect(user.email).toBe('priya@ledgerline.test'); // normalised once, at the boundary
  expect(user.passwordHash).not.toBeNull();
  expect(user.passwordHash).not.toContain(INPUT.password);
  expect(user.passwordHash!.startsWith('scrypt$')).toBe(true);
  expect(verifyPasswordHash(INPUT.password, user.passwordHash!)).toBe(true);
  expect(verifyPasswordHash('not the password', user.passwordHash!)).toBe(false);
});

test('the verification mail carries a token that verifies back to the new user and address', async () => {
  const { service, mailer } = build();
  await service.signUp(INPUT, META);

  const sent = mailer.sentVerifications();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toBe('priya@ledgerline.test');

  const verdict = verifyEmailVerificationToken(sent[0]!.token, SECRET);
  expect(verdict.ok).toBe(true);
  if (!verdict.ok) return;
  expect(verdict.claims.email).toBe('priya@ledgerline.test');
  expect(verdict.claims.userId).toMatch(/^usr_/);
  expect(verdict.claims.expiresAtMs).toBeGreaterThan(Date.now());

  // A token signed with a different secret must not verify — the signature is
  // the whole authorisation, there is no row to check it against.
  expect(verifyEmailVerificationToken(sent[0]!.token, 'some-other-secret')).toEqual({ ok: false, reason: 'invalid' });
});

test('terms acceptance is recorded as an append-only audit row, and the ADDRESS is not in it', async () => {
  const { service, written } = build();
  await service.signUp(INPUT, META);

  expect(written.auditEvents).toHaveLength(1);
  const event = written.auditEvents[0]!;
  expect(event.event).toBe('practice.terms-accepted');
  expect(event.businessId).toBeNull();
  expect(event.seq).toBe(1n);
  expect(event.outcome['acceptedTermsVersion']).toBe(TERMS_VERSION_IN_FORCE);
  // `audit_events` can never be erased — so the mailbox lives in `users.email`,
  // which can be, and only its hash lives here.
  expect(JSON.stringify(event.outcome)).not.toContain('ledgerline.test');
});

test('REFUSAL: a duplicate address creates NOTHING, still answers 202, and tells the account holder', async () => {
  const { service, written, mailer } = build({ existingEmails: ['priya@ledgerline.test'] });

  // Resolves — no throw. The caller must not be able to tell this apart from a
  // successful signup, or the endpoint becomes an "is this firm a customer"
  // oracle for anyone who asks.
  await expect(service.signUp(INPUT, META)).resolves.toBeUndefined();

  expect(written.practices).toEqual([]);
  expect(written.users).toEqual([]);
  expect(written.memberships).toEqual([]);
  expect(written.auditEvents).toEqual([]);
  // No verification mail — that would be a working link into someone else's account.
  expect(mailer.sentVerifications()).toEqual([]);
  expect(mailer.sentDuplicateNotices()).toEqual([{ to: 'priya@ledgerline.test' }]);
});

test('REFUSAL: losing the unique-index race is the same silent outcome, with no orphan practice left behind', async () => {
  // The address is free at the findUnique and taken by the insert — the window
  // a concurrent signup lands in.
  const { service, written, mailer } = build({ failUserCreateWithP2002: true });

  await expect(service.signUp(INPUT, META)).resolves.toBeUndefined();

  expect(written.rolledBack).toBe(1);
  // The practice row was created inside the transaction and must NOT survive
  // it. A practice with no owner is unreachable forever.
  expect(written.practices).toEqual([]);
  expect(written.users).toEqual([]);
  expect(mailer.sentDuplicateNotices()).toHaveLength(1);
});

test('REFUSAL: a weak password is a 400 the caller may be told about, and writes nothing', async () => {
  const { service, written } = build();
  const err = (await grabAsync(() => service.signUp({ ...INPUT, password: 'short' }, META))) as AppException;

  expect(err).toBeInstanceOf(AppException);
  expect(err.getStatus()).toBe(400);
  expect(err.code).toBe('NT-VAL-001');
  // Naming the caller's OWN bad input reveals nothing about anyone else — the
  // contract says so explicitly. Contrast the duplicate-email case above.
  expect(err.fieldErrors?.[0]?.field).toBe('password');
  expect(written.transactions).toBe(0);
});

test('REFUSAL: a terms version that is not the one in force', async () => {
  const { service, written } = build();
  const err = (await grabAsync(() => service.signUp({ ...INPUT, acceptedTermsVersion: '0.0' }, META))) as AppException;

  expect(err).toBeInstanceOf(AppException);
  expect(err.getStatus()).toBe(400);
  expect(err.fieldErrors?.[0]?.field).toBe('acceptedTermsVersion');
  expect(written.transactions).toBe(0);
});

test('REFUSAL: a name that is only whitespace passes the contract minLength and is still refused', async () => {
  const { service, written } = build();
  const err = (await grabAsync(() => service.signUp({ ...INPUT, practiceName: '   ' }, META))) as AppException;

  expect(err).toBeInstanceOf(AppException);
  expect(err.fieldErrors?.[0]?.field).toBe('practiceName');
  expect(written.transactions).toBe(0);
});

test('REFUSAL: production will not create an account it cannot send a verification mail for', async () => {
  const production = { ...env, NODE_ENV: 'production' } as Env;
  const { service, written } = build({}, { env: production });

  const err = (await grabAsync(() => service.signUp(INPUT, META))) as AppException;
  expect(err).toBeInstanceOf(AppException);
  expect(err.code).toBe('NT-SRV-001');
  expect(written.transactions).toBe(0);

  // …and a real transport lifts the refusal. The gate is on the STAND-IN, not
  // on production, so S2 merging is the only change needed.
  const real: SignupMailer = { sendEmailVerification: async () => undefined, sendDuplicateSignupNotice: async () => undefined };
  const withReal = build({}, { env: production, mailer: real });
  await expect(withReal.service.signUp(INPUT, META)).resolves.toBeUndefined();
  // The human and the practice's machine actor.
  expect(withReal.written.users).toHaveLength(2);
});

test('a replayed Idempotency-Key does the work once; the same key with a different body is 409', async () => {
  const { service, written } = build();
  await service.signUp(INPUT, META);
  await service.signUp(INPUT, META);
  expect(written.transactions).toBe(1);

  const err = (await grabAsync(() => service.signUp({ ...INPUT, practiceName: 'Somebody Else LLP' }, META))) as AppException;
  expect(err).toBeInstanceOf(AppException);
  expect(err.code).toBe('NT-IDM-001');
  expect(err.getStatus()).toBe(409);
  expect(written.transactions).toBe(1);
});

async function grabAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}
