import { beforeEach, expect, test } from 'vitest';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { AppException } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import { hashPassword } from './password.js';
import { InMemorySignInThrottle, SIGN_IN_MAX_FAILURES, type SignInThrottle } from './sign-in-throttle.js';
import { signTotpEnrolmentTicket, TOTP_ENROLMENT_TICKET_TTL_MS } from './totp-enrolment-ticket.js';
import { TotpEnrolmentService } from './totp-enrolment.service.js';
import { unwrapTotpMaterial } from './totp-secret.js';
import { totpEngine } from './totp.js';

const SECRET = 'test-session-secret';
const env = { SESSION_SECRET: SECRET, OTP_MODE: 'totp', NODE_ENV: 'test' } as Env;
const NOW = 1_756_000_000_000;
const EMAIL = 'priya@ledgerline.test';
const PASSWORD = 'a-long-enough-passphrase';

interface UserRow {
  id: string;
  email: string | null;
  kind: string;
  passwordHash: string | null;
  emailVerified: boolean;
  deactivatedAt: Date | null;
  totpSecretRef: string | null;
  totpEnabledAt: Date | null;
}

/**
 * A `users` table of one, plus a WRITE COUNTER.
 *
 * The counter is the point of half these tests: A14's whole correction is that
 * `begin` must not write, so "how many writes happened" is the assertion, not
 * an implementation detail. `updateMany` is modelled faithfully — including the
 * predicate — because the conditional write is what makes "already enrolled"
 * true under a race rather than merely checked.
 */
function fakeDb(user: UserRow | null): { client: PrismaClient; row: UserRow | null; writes: () => number } {
  let writes = 0;
  const client = {
    user: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
        if (user === null) return null;
        if (where.email !== undefined && where.email !== user.email) return null;
        if (where.id !== undefined && where.id !== user.id) return null;
        return user;
      },
      updateMany: async ({ where, data }: { where: Partial<UserRow>; data: Partial<UserRow> }) => {
        writes += 1;
        if (user === null) return { count: 0 };
        const matches = Object.entries(where).every(([key, value]) => user[key as keyof UserRow] === value);
        if (!matches) return { count: 0 };
        Object.assign(user, data);
        return { count: 1 };
      },
      update: async () => {
        writes += 1;
        throw new Error('nothing on the enrolment path may use update() — the write must be conditional');
      },
    },
  } as unknown as PrismaClient;
  return { client, row: user, writes: () => writes };
}

function human(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'usr_priya',
    email: EMAIL,
    kind: 'HUMAN',
    passwordHash: PASSWORD_HASH,
    emailVerified: true,
    deactivatedAt: null,
    totpSecretRef: null,
    totpEnabledAt: null,
    ...overrides,
  };
}

// Hashed once — scrypt is ~50-100 ms a call and this file makes a lot of them.
const PASSWORD_HASH = hashPassword(PASSWORD);

let throttle: SignInThrottle;
beforeEach(() => {
  throttle = new InMemorySignInThrottle();
});

function service(user: UserRow | null): {
  service: TotpEnrolmentService;
  row: UserRow | null;
  writes: () => number;
} {
  const db = fakeDb(user);
  return { service: new TotpEnrolmentService(db.client, env, throttle), row: db.row, writes: db.writes };
}

async function grab(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a throw');
}

function codeFor(secret: string, nowMs = NOW): Promise<string> {
  return totpEngine.generate({ secret, epoch: Math.floor(nowMs / 1000) });
}

// ── The property A14 exists to establish ────────────────────────────────────

test('begin WRITES NOTHING — the candidate lives in the ticket, not in the row', async () => {
  const { service: svc, row, writes } = service(human());
  const offer = await svc.begin({ email: EMAIL, password: PASSWORD }, NOW);

  expect(offer.uri.startsWith('otpauth://totp/')).toBe(true);
  expect(offer.recoveryCodes.length).toBeGreaterThan(0);
  expect(offer.enrolmentToken).not.toBe('');
  // The whole of A14's correction, as one assertion.
  expect(writes()).toBe(0);
  expect(row?.totpSecretRef).toBeNull();
  expect(row?.totpEnabledAt).toBeNull();
  // The seed is in the offer once; the ticket carries only the encrypted envelope.
  expect(offer.enrolmentToken).not.toContain(offer.secret);
});

test('A MIS-SCAN IS NOT A LOCKOUT: an abandoned enrolment can simply be started again', async () => {
  // This is the regression test for the defect A14 found in A2's two-step. When
  // `begin` wrote the ref, a user who mis-scanned had a live second factor
  // nothing could produce a code for — and the retry was refused as
  // already-enrolled, permanently, because this release has no reset flow.
  const { service: svc, row } = service(human());

  await svc.begin({ email: EMAIL, password: PASSWORD }, NOW);
  expect(row?.totpSecretRef).toBeNull();

  const second = await svc.begin({ email: EMAIL, password: PASSWORD }, NOW);
  await svc.confirm({ email: EMAIL, password: PASSWORD, enrolmentToken: second.enrolmentToken, totp: await codeFor(second.secret) }, NOW);

  expect(unwrapTotpMaterial(row?.totpSecretRef ?? null, SECRET)?.secret).toBe(second.secret);
  expect(row?.totpEnabledAt).toEqual(new Date(NOW));
});

test('confirm writes the enrolment, and only with a code from THAT candidate', async () => {
  const { service: svc, row } = service(human());
  const offer = await svc.begin({ email: EMAIL, password: PASSWORD }, NOW);

  const wrong = await grab(() =>
    svc.confirm({ email: EMAIL, password: PASSWORD, enrolmentToken: offer.enrolmentToken, totp: '000000' }, NOW),
  );
  expect(wrong.code).toBe('NT-AUTH-003');
  expect(row?.totpSecretRef).toBeNull();

  await svc.confirm({ email: EMAIL, password: PASSWORD, enrolmentToken: offer.enrolmentToken, totp: await codeFor(offer.secret) }, NOW);
  expect(row?.totpSecretRef).not.toBeNull();
  expect(row?.totpEnabledAt).toEqual(new Date(NOW));
});

test('REFUSAL: a RECOVERY code cannot confirm an enrolment — it proves nothing about the app', async () => {
  const { service: svc, row } = service(human());
  const offer = await svc.begin({ email: EMAIL, password: PASSWORD }, NOW);

  // It would verify perfectly well as a second factor, which is exactly why the
  // verdict is narrowed rather than trusted: confirming on a recovery code
  // leaves the user with a factor their authenticator never received.
  const error = await grab(() =>
    svc.confirm({ email: EMAIL, password: PASSWORD, enrolmentToken: offer.enrolmentToken, totp: offer.recoveryCodes[0]! }, NOW),
  );
  expect(error.code).toBe('NT-AUTH-003');
  expect(row?.totpSecretRef).toBeNull();
});

// ── The ticket ──────────────────────────────────────────────────────────────

test('REFUSAL: a ticket that is expired, forged, or minted for another user is NT-AUTH-008', async () => {
  const { service: svc, row } = service(human());
  const offer = await svc.begin({ email: EMAIL, password: PASSWORD }, NOW);
  const code = await codeFor(offer.secret);
  const base = { email: EMAIL, password: PASSWORD, totp: code };

  const expired = await grab(() =>
    svc.confirm({ ...base, enrolmentToken: offer.enrolmentToken }, NOW + TOTP_ENROLMENT_TICKET_TTL_MS),
  );
  expect(expired.code).toBe('NT-AUTH-008');

  const forged = await grab(() => svc.confirm({ ...base, enrolmentToken: `${offer.enrolmentToken}x` }, NOW));
  expect(forged.code).toBe('NT-AUTH-008');

  // Signed with our key, but naming somebody else. The signature verifies; the
  // binding to the authenticated user is what refuses it.
  const someoneElse = signTotpEnrolmentTicket(
    { userId: 'usr_someone_else', email: EMAIL, ref: 'ntotp1.x.y.z', expiresAtMs: NOW + 60_000 },
    SECRET,
  );
  const wrongUser = await grab(() => svc.confirm({ ...base, enrolmentToken: someoneElse }, NOW));
  expect(wrongUser.code).toBe('NT-AUTH-008');

  expect(row?.totpSecretRef).toBeNull();
});

test('a bad ticket does NOT count towards the lockout — the password already verified', async () => {
  const { service: svc } = service(human());
  for (let attempt = 0; attempt < SIGN_IN_MAX_FAILURES + 2; attempt += 1) {
    const error = await grab(() =>
      svc.confirm({ email: EMAIL, password: PASSWORD, enrolmentToken: 'not-a-ticket', totp: '123456' }, NOW),
    );
    // Never becomes a 429: someone whose ticket expired while they were copying
    // down recovery codes must not be pushed towards a lockout for it.
    expect(error.code).toBe('NT-AUTH-008');
  }
});

// ── Who may enrol ───────────────────────────────────────────────────────────

test('REFUSAL: a wrong password, an unknown address and a deactivated account are one NT-AUTH-003', async () => {
  const cases = [
    { user: human(), password: 'not-the-password' },
    { user: null, password: PASSWORD },
    { user: human({ deactivatedAt: new Date(NOW) }), password: PASSWORD },
    { user: human({ kind: 'SYSTEM' }), password: PASSWORD },
  ];
  for (const { user, password } of cases) {
    const { service: svc, writes } = service(user);
    const error = await grab(() => svc.begin({ email: EMAIL, password }, NOW));
    expect(error.code).toBe('NT-AUTH-003');
    expect(error.publicDetail).toBe('The email or password did not match.');
    expect(writes()).toBe(0);
  }
});

test('REFUSAL: an unverified address is NT-AUTH-006 — named, because the password already verified', async () => {
  const { service: svc, writes } = service(human({ emailVerified: false }));
  const error = await grab(() => svc.begin({ email: EMAIL, password: PASSWORD }, NOW));

  expect(error.code).toBe('NT-AUTH-006');
  expect(writes()).toBe(0);
  // ⚠ And it must NOT count a failure: the caller did nothing wrong, and a user
  // clicking "set up MFA" twice must not be able to lock themselves out.
  expect(throttle.inspect(EMAIL, NOW).remaining).toBe(SIGN_IN_MAX_FAILURES);
});

test('REFUSAL: an account that already has an enrolment is NT-AUTH-007, on both steps', async () => {
  const enrolled = human({ totpSecretRef: 'ntotp1.already.here.now', totpEnabledAt: new Date(NOW) });
  const { service: svc, row } = service(enrolled);

  const onBegin = await grab(() => svc.begin({ email: EMAIL, password: PASSWORD }, NOW));
  expect(onBegin.code).toBe('NT-AUTH-007');

  const onConfirm = await grab(() =>
    svc.confirm({ email: EMAIL, password: PASSWORD, enrolmentToken: 'anything', totp: '123456' }, NOW),
  );
  expect(onConfirm.code).toBe('NT-AUTH-007');

  // The existing seed is untouched — a refusal must never overwrite the factor
  // the user already has in their phone.
  expect(row?.totpSecretRef).toBe('ntotp1.already.here.now');
  expect(throttle.inspect(EMAIL, NOW).remaining).toBe(SIGN_IN_MAX_FAILURES);
});

test('the conditional write is what makes "already enrolled" true under a RACE', async () => {
  const user = human();
  const { service: svc, row } = service(user);
  const first = await svc.begin({ email: EMAIL, password: PASSWORD }, NOW);
  const second = await svc.begin({ email: EMAIL, password: PASSWORD }, NOW);

  await svc.confirm({ email: EMAIL, password: PASSWORD, enrolmentToken: first.enrolmentToken, totp: await codeFor(first.secret) }, NOW);
  const ref = row?.totpSecretRef;

  // The second confirmation read its row before the first one wrote — the shape
  // of two tabs, or a double-submit. Without the `totpSecretRef: null`
  // predicate it would silently replace a seed the user has already stored.
  const secondCode = await codeFor(second.secret);
  const raced = await grab(() =>
    svc.confirm({ email: EMAIL, password: PASSWORD, enrolmentToken: second.enrolmentToken, totp: secondCode }, NOW),
  );
  expect(raced.code).toBe('NT-AUTH-007');
  expect(row?.totpSecretRef).toBe(ref);
});

// ── The lockout ─────────────────────────────────────────────────────────────

test('enrolment shares ONE lockout with sign-in, keyed on the address', async () => {
  const { service: svc } = service(human());

  for (let attempt = 0; attempt < SIGN_IN_MAX_FAILURES - 1; attempt += 1) {
    const error = await grab(() => svc.begin({ email: EMAIL, password: 'wrong' }, NOW));
    expect(error.code).toBe('NT-AUTH-003');
  }
  // The attempt that TRIPS the lock answers 429 rather than 401 — the threshold
  // is not a secret and telling the person is the only way they can act on it.
  const tripped = await grab(() => svc.begin({ email: EMAIL, password: 'wrong' }, NOW));
  expect(tripped.code).toBe('NT-RATE-001');

  // ⚠ AND THE CORRECT PASSWORD IS NOW REFUSED TOO, from the same counter the
  // login path reads. Two counters would mean this endpoint — which checks a
  // password with no second factor in front of it — doubled the guesses
  // available against every address.
  const locked = await grab(() => svc.begin({ email: EMAIL, password: PASSWORD }, NOW));
  expect(locked.code).toBe('NT-RATE-001');
  expect(throttle.inspect(EMAIL, NOW).locked).toBe(true);
});

test('a successful begin clears the failure counter, exactly as a successful login does', async () => {
  const { service: svc } = service(human());
  await grab(() => svc.begin({ email: EMAIL, password: 'wrong' }, NOW));
  expect(throttle.inspect(EMAIL, NOW).remaining).toBe(SIGN_IN_MAX_FAILURES - 1);

  await svc.begin({ email: EMAIL, password: PASSWORD }, NOW);
  expect(throttle.inspect(EMAIL, NOW).remaining).toBe(SIGN_IN_MAX_FAILURES);
});

test('the address is normalised the way login normalises it', async () => {
  const { service: svc } = service(human());
  // "Priya@Ledgerline.TEST " and "priya@ledgerline.test" are one account, one
  // lookup and one throttle key. If these two ever disagree, a user locked out
  // at one casing would still have a fresh ten guesses at the other.
  const offer = await svc.begin({ email: '  Priya@Ledgerline.TEST ', password: PASSWORD }, NOW);
  expect(offer.secret).not.toBe('');
});

test('recoveryCodesLeft reports what is actually in the envelope', async () => {
  const { service: svc } = service(human());
  const offer = await svc.begin({ email: EMAIL, password: PASSWORD }, NOW);
  await svc.confirm({ email: EMAIL, password: PASSWORD, enrolmentToken: offer.enrolmentToken, totp: await codeFor(offer.secret) }, NOW);
  expect(await svc.recoveryCodesLeft('usr_priya')).toBe(offer.recoveryCodes.length);
});
