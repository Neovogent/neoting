import { NtProblemError } from '@neoting/contracts';
import { beginTotpEnrolment, confirmTotpEnrolment, createPractice, verifyEmailAddress } from '@neoting/contracts/client';
import {
  beginTotpEnrolmentBody,
  beginTotpEnrolmentResponse,
  confirmTotpEnrolmentBody,
  createPracticeBody,
  verifyEmailAddressBody,
  verifyEmailAddressResponse,
} from '@neoting/contracts/zod';
import { unwrapBody } from './envelope';

/**
 * The practice signup chain (launch stage M9), over the four operations A1 and
 * A14 shipped:
 *
 *   POST /v1/practices                     the account          → 202, empty
 *   POST /v1/auth/email-verification       the emailed link     → 200 {email}
 *   POST /v1/auth/totp-enrolment           the QR and the codes → 200, writes nothing
 *   POST /v1/auth/totp-enrolment/confirm   the code from the app → 204, writes it
 *
 * Until this stage the API had all four and `apps/web/src` called none of them:
 * the product had a login screen and no way to reach one.
 *
 * ⚠ **THE `202` SAYS NOTHING, AND THE SCREEN MUST NOT EITHER.** `createPractice`
 * answers the same empty `202` whether or not an account was created, because
 * saying which would answer "is this address registered here" for anyone who
 * asks. The verification email is the channel that distinguishes the two
 * outcomes, and it goes to the address rather than to the caller. So this
 * module returns `void`, not a boolean anyone could render — there is nothing
 * true to say beyond what happens next.
 *
 * ⚠ **NOTHING HERE IS PERSISTED, AND THAT IS THE WHOLE RULE OF THE ENROLMENT
 * STEP.** The seed, the ten recovery codes and the enrolment token live in
 * React state for the length of one setup and nowhere else — not
 * `localStorage`, not a query cache, not the address bar. The contract's own
 * words: every field of `TotpEnrolmentOffer` except the token is secret
 * material the user is responsible for capturing before they navigate away.
 *
 * ⚠ **THE ENROLMENT IS NOT WRITTEN BY `begin`.** `begin` mints a candidate and
 * stores nothing; `confirm` is what makes the factor live. An abandoned attempt
 * therefore costs nothing and can simply be started again — which is what stops
 * one mis-scanned QR from locking an account out for ever, because this release
 * has no reset flow to rescue it. The screens must preserve that: a failure at
 * confirm offers another go, never a dead end.
 */

/**
 * The terms version the signup form must send.
 *
 * `TERMS_VERSION_IN_FORCE` in `apps/api/src/modules/auth-tenancy/
 * practice-signup.service.ts`. Any other value is a `400 NT-VAL-001` — the
 * server refuses a signup that names a version that is not in force, because
 * what a person agreed to and when is recorded as an audit event and an audit
 * event naming the wrong document is worse than none.
 */
export const TERMS_VERSION = '0.1';

/** The contract's own minimum. Length only — see `PracticeSignupRequest`. */
export const PASSWORD_MIN_LENGTH = 12;

/** The contract's `^[0-9]{6}$`. */
export const TOTP_LENGTH = 6;

export interface SignupDetails {
  practiceName: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

/**
 * Create the practice, its first user and the membership that binds them.
 *
 * Resolves on the `202` and returns nothing — see the module note. A thrown
 * `NtProblemError` is a `400` (the caller's own input: a short password, a
 * terms version that is not the one in force) or a `429`. It is never "that
 * address is already registered": the account holder learns that at their
 * address, and nobody else learns it at all.
 */
export async function signUpPractice(details: SignupDetails): Promise<void> {
  const request = createPracticeBody.parse({
    practiceName: details.practiceName.trim(),
    firstName: details.firstName.trim(),
    lastName: details.lastName.trim(),
    // Normalised here as well as on the server: `users.email` is unique on the
    // literal bytes, and the API lower-cases before it looks. Sending what the
    // server will store keeps the two from ever disagreeing about which
    // account this is.
    email: details.email.trim().toLowerCase(),
    password: details.password,
    acceptedTermsVersion: TERMS_VERSION,
  });
  await createPractice(request);
}

export interface VerifiedAddress {
  /** The address now proved. Prefill the enrolment form with it. */
  email: string;
  /** True when it was already verified before this call — same outcome either way. */
  alreadyVerified: boolean;
}

/**
 * Spend the token from the signup email.
 *
 * Idempotent by contract: a corporate mail scanner that fetches the link before
 * the human clicks it must not turn a working account into an error page, so a
 * second call is a `200` with `alreadyVerified: true` rather than a conflict.
 *
 * Two failures, and the split is the server's: `NT-AUTH-004` is every kind of
 * "not valid" collapsed into one verdict so a guesser learns nothing;
 * `NT-AUTH-005` is specifically expired, which is safe to say because the token
 * was ours and its holder already had it.
 */
export async function verifyEmail(token: string): Promise<VerifiedAddress> {
  const request = verifyEmailAddressBody.parse({ token });
  const body = verifyEmailAddressResponse.parse(unwrapBody(await verifyEmailAddress(request)));
  return { email: body.email, alreadyVerified: body.alreadyVerified };
}

export interface EnrolmentOffer {
  /** Post back with the first code the authenticator produces. Not secret, but not persisted either. */
  enrolmentToken: string;
  /** `otpauth://totp/…` — drawn as the QR. */
  uri: string;
  /** The base32 seed, for a device that cannot scan. */
  secret: string;
  /** Ten single-use codes, shown exactly once and never retrievable. */
  recoveryCodes: string[];
}

/**
 * Mint a candidate second factor: the QR, the seed and the recovery codes.
 *
 * Authenticated by password only, and it is the one route that has to be — the
 * whole point is that the caller has no second factor yet. It writes nothing,
 * so an abandoned attempt is free.
 */
export async function beginEnrolment(email: string, password: string): Promise<EnrolmentOffer> {
  const request = beginTotpEnrolmentBody.parse({ email: email.trim().toLowerCase(), password });
  const body = beginTotpEnrolmentResponse.parse(unwrapBody(await beginTotpEnrolment(request)));
  return {
    enrolmentToken: body.enrolmentToken,
    uri: body.uri,
    secret: body.secret,
    recoveryCodes: [...body.recoveryCodes],
  };
}

/**
 * Write the enrolment. The only call that does.
 *
 * A recovery code is refused here on purpose: it would confirm an enrolment
 * without ever proving the authenticator received the seed, which is precisely
 * the mis-scan this step exists to catch.
 */
export async function confirmEnrolment(input: {
  email: string;
  password: string;
  enrolmentToken: string;
  totp: string;
}): Promise<void> {
  const request = confirmTotpEnrolmentBody.parse({
    email: input.email.trim().toLowerCase(),
    password: input.password,
    enrolmentToken: input.enrolmentToken,
    totp: input.totp,
  });
  await confirmTotpEnrolment(request);
}

/**
 * What went wrong, in the shape the screens render.
 *
 * `code` is the API's stable `NT-` code where there is one and `null` when the
 * request never got an answer at all — which is a real and different thing to
 * tell somebody, and the frontend ten's item 5 asks for plain English plus the
 * code rather than either alone.
 */
export interface SignupFault {
  code: string | null;
  /** The server's own field-level complaints, when it named any. */
  fields: readonly string[];
}

export function faultOf(error: unknown): SignupFault {
  if (error instanceof NtProblemError) {
    // `fieldErrors` is what a `400 NT-VAL-001` carries. Only the names are
    // taken: the server's messages are written for an API caller, and the
    // screen has its own sentence for each field it can highlight.
    return { code: error.code, fields: (error.fieldErrors ?? []).map((entry) => entry.field) };
  }
  return { code: null, fields: [] };
}
