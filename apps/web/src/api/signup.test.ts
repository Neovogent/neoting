import { afterEach, expect, test, vi } from 'vitest';
import { NtProblemError } from '@neoting/contracts';
import {
  beginTotpEnrolment,
  confirmTotpEnrolment,
  createPractice,
  verifyEmailAddress,
} from '@neoting/contracts/client';

import {
  PASSWORD_MIN_LENGTH,
  TERMS_VERSION,
  beginEnrolment,
  confirmEnrolment,
  faultOf,
  signUpPractice,
  verifyEmail,
} from './signup';

/**
 * The signup boundary (launch stage M9).
 *
 * Mocked at the generated-client seam rather than at `fetch`, because what is
 * under test here is the REQUEST this module composes and the parse it puts
 * the response through — the two places a screen can silently send or believe
 * the wrong thing. The transport itself (`Idempotency-Key`, `/v1`, the cookie)
 * is `http-client.ts`'s and is pinned there.
 *
 * The assertions that earn their place:
 *
 *  - the terms version is `0.1` and is sent on every signup. The server refuses
 *    any other value, and what a person accepted is recorded as an append-only
 *    audit event — so a drifted constant here would file the wrong document
 *    against a real person's name.
 *  - both response parses go through the CONTRACT'S OWN Zod. A body that drifts
 *    must throw with the field named, not render as a plausible screen.
 *  - the email is normalised the way the server normalises it, because
 *    `users.email` is unique on the literal bytes.
 */

vi.mock('@neoting/contracts/client', () => ({
  createPractice: vi.fn(),
  verifyEmailAddress: vi.fn(),
  beginTotpEnrolment: vi.fn(),
  confirmTotpEnrolment: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

const DETAILS = {
  practiceName: '  Northgate Accounts Ltd  ',
  firstName: ' Priya ',
  lastName: ' Raman ',
  email: '  Priya@Northgate.TEST  ',
  password: 'a-long-enough-passphrase',
};

const OFFER_BODY = {
  enrolmentToken: 'ticket.abc.def',
  uri: 'otpauth://totp/Neo%20Accounting:priya@northgate.test?secret=JBSWY3DPEHPK3PXP&issuer=Neo%20Accounting',
  secret: 'JBSWY3DPEHPK3PXP',
  recoveryCodes: Array.from({ length: 10 }, (_, i) => `abcd-efgh-jkmn-pqr${i}`),
};

/* ── the practice ────────────────────────────────────────────────────────── */

test('the terms version in force is 0.1, and every signup carries it', async () => {
  // Pinned as a literal, not read from the module: this is the value
  // `TERMS_VERSION_IN_FORCE` holds in practice-signup.service.ts, and the point
  // of the assertion is that the two agree. A test that read the constant back
  // from the constant would pass however far it had drifted.
  expect(TERMS_VERSION).toBe('0.1');

  vi.mocked(createPractice).mockResolvedValueOnce(undefined as never);
  await signUpPractice(DETAILS);

  expect(vi.mocked(createPractice).mock.calls[0]?.[0]).toEqual({
    practiceName: 'Northgate Accounts Ltd',
    firstName: 'Priya',
    lastName: 'Raman',
    // Lower-cased and trimmed, exactly as `normaliseEmail` does server-side:
    // `users.email` is unique on the literal bytes, so "Priya@…" and "priya@…"
    // would otherwise be two accounts and the second could never receive
    // anything the first one's mail goes to.
    email: 'priya@northgate.test',
    password: 'a-long-enough-passphrase',
    acceptedTermsVersion: '0.1',
  });
});

test('the password minimum is the contract\'s twelve, and a shorter one never reaches the network', async () => {
  expect(PASSWORD_MIN_LENGTH).toBe(12);
  await expect(signUpPractice({ ...DETAILS, password: 'short' })).rejects.toThrow();
  expect(vi.mocked(createPractice)).not.toHaveBeenCalled();
});

test('an empty practice name is refused before the network', async () => {
  await expect(signUpPractice({ ...DETAILS, practiceName: '   ' })).rejects.toThrow();
  expect(vi.mocked(createPractice)).not.toHaveBeenCalled();
});

/* ── verification ────────────────────────────────────────────────────────── */

test('verification returns the proved address and whether it was already proved', async () => {
  vi.mocked(verifyEmailAddress).mockResolvedValueOnce({
    email: 'priya@northgate.test',
    alreadyVerified: true,
  } as never);

  expect(await verifyEmail('a-token')).toEqual({ email: 'priya@northgate.test', alreadyVerified: true });
  expect(vi.mocked(verifyEmailAddress).mock.calls[0]?.[0]).toEqual({ token: 'a-token' });
});

test('verification also reads the envelope shape the generated types describe', async () => {
  // `ntFetch` returns the raw body; the types say `{status, data}`. `unwrapBody`
  // accepts both, so this module stays right if the mutator ever changes.
  vi.mocked(verifyEmailAddress).mockResolvedValueOnce({
    status: 200,
    data: { email: 'priya@northgate.test', alreadyVerified: false },
  } as never);
  expect(await verifyEmail('a-token')).toEqual({ email: 'priya@northgate.test', alreadyVerified: false });
});

test('a verification body that drifts from the contract throws rather than rendering', async () => {
  vi.mocked(verifyEmailAddress).mockResolvedValueOnce({ email: 'not-an-address' } as never);
  await expect(verifyEmail('a-token')).rejects.toThrow();
});

/* ── enrolment ───────────────────────────────────────────────────────────── */

test('beginning an enrolment sends the normalised address and returns the offer intact', async () => {
  vi.mocked(beginTotpEnrolment).mockResolvedValueOnce(OFFER_BODY as never);

  const offer = await beginEnrolment('  Priya@Northgate.TEST ', 'a-long-enough-passphrase');
  expect(offer).toEqual(OFFER_BODY);
  // The array is copied, not aliased — the contract's own type is readonly and
  // nothing downstream may mutate what the server sent.
  expect(offer.recoveryCodes).not.toBe(OFFER_BODY.recoveryCodes);
  expect(vi.mocked(beginTotpEnrolment).mock.calls[0]?.[0]).toEqual({
    email: 'priya@northgate.test',
    password: 'a-long-enough-passphrase',
  });
});

test('the password is NOT length-policed on the enrolment route', async () => {
  // Deliberate, and the contract says why: here a wrong password is a 401, and
  // a client-side minimum would turn a short one into a 400 that announces the
  // password is short — which answers a question about someone else's account.
  vi.mocked(beginTotpEnrolment).mockResolvedValueOnce(OFFER_BODY as never);
  await beginEnrolment('priya@northgate.test', 'x');
  expect(vi.mocked(beginTotpEnrolment)).toHaveBeenCalledTimes(1);
});

test('an offer that drifts from the contract throws rather than drawing a QR of nothing', async () => {
  vi.mocked(beginTotpEnrolment).mockResolvedValueOnce({ ...OFFER_BODY, recoveryCodes: [] } as never);
  await expect(beginEnrolment('priya@northgate.test', 'pw')).rejects.toThrow();
});

test('confirming sends the token back unmodified, and refuses anything but six digits', async () => {
  vi.mocked(confirmTotpEnrolment).mockResolvedValueOnce(undefined as never);
  await confirmEnrolment({
    email: 'PRIYA@northgate.test',
    password: 'pw',
    enrolmentToken: OFFER_BODY.enrolmentToken,
    totp: '123456',
  });
  expect(vi.mocked(confirmTotpEnrolment).mock.calls[0]?.[0]).toEqual({
    email: 'priya@northgate.test',
    password: 'pw',
    enrolmentToken: OFFER_BODY.enrolmentToken,
    totp: '123456',
  });

  // A recovery code is refused here on purpose — it would confirm an enrolment
  // without proving the authenticator ever received the seed.
  await expect(
    confirmEnrolment({
      email: 'priya@northgate.test',
      password: 'pw',
      enrolmentToken: OFFER_BODY.enrolmentToken,
      totp: 'abcd-efgh-jkmn-pqrs',
    }),
  ).rejects.toThrow();
  expect(vi.mocked(confirmTotpEnrolment)).toHaveBeenCalledTimes(1);
});

/* ── faults ──────────────────────────────────────────────────────────────── */

test('a problem response keeps its code and its named fields; anything else is "unreachable"', () => {
  expect(
    faultOf(
      new NtProblemError({
        status: 400,
        code: 'NT-VAL-001',
        title: 'Validation failed',
        errors: [{ field: 'password', message: 'too short' }],
      }),
    ),
  ).toEqual({ code: 'NT-VAL-001', fields: ['password'] });

  // A transport failure has no code, and the screens key on exactly that to
  // say "we could not reach the server" instead of blaming the credentials.
  expect(faultOf(new Error('offline'))).toEqual({ code: null, fields: [] });
});
