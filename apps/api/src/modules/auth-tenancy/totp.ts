import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import { NobleCryptoPlugin, ScureBase32Plugin, TOTP } from 'otplib';

import { type TotpMaterial, unwrapTotpMaterial, wrapTotpMaterial } from './totp-secret.js';

/**
 * The real second factor (launch stage A2) — RFC 6238 TOTP through `otplib`,
 * plus single-use recovery codes.
 *
 * **What this replaces.** `auth.service.ts` checked the literal string
 * `'000000'`, and `portal-session.service.ts` checked the same one. One code, on
 * every account, in every practice, published in the source and in the seed — a
 * second factor that is really a longer password field, on a workspace holding
 * other people's financial records. `OTP_MODE` admitted no other value, so it
 * could not even be turned off.
 *
 * **The switch, not a rewrite.** `OTP_MODE=demo` still accepts the fixed code so
 * a fresh clone and CI sign in offline; `OTP_MODE=totp` runs this file. `demo`
 * is REFUSED at boot under `NODE_ENV=production` (`config/env.ts`), which is
 * what makes the fixture structurally unable to reach a customer.
 *
 * ## The parameters, and why each is what it is
 *
 * - **SHA-1, 6 digits, 30 s** — otplib's defaults and RFC 6238's, which is what
 *   Google Authenticator, 1Password, Authy and every hardware token assume. A
 *   "stronger" SHA-256 or 8-digit configuration is a QR code that scans and then
 *   produces codes that never verify, in an app whose vendor we do not control.
 *   Interoperability is the security property here.
 * - **±1 step of tolerance (30 s)**, not the more common ±2. A phone clock is
 *   NTP-synced; two steps buys almost nothing for a real user and doubles the
 *   codes an attacker's guess can land on. Asymmetric past-only tolerance is
 *   available in otplib (`[30, 0]`) and is deliberately NOT used: a slow client
 *   clock is the common case and a symmetric window is what a user experiences
 *   as "it just works".
 *
 * ## ⚠ TWO CONTRACT GAPS THIS FILE CANNOT CLOSE (G7)
 *
 * 1. **No enrolment operation exists.** `openapi.yaml` publishes no
 *    `POST /v1/me/totp` and no confirmation path, so nothing can hand a user
 *    the QR code — see `totp-enrolment.service.ts`, which is written and tested
 *    against the day it does.
 * 2. **A recovery code cannot be SUBMITTED.** `SessionCreateRequest.totp` is
 *    `pattern: '^[0-9]{6}$'`, and the generated Zod enforces it at the
 *    controller, so a nineteen-character recovery code is a `400` before it
 *    reaches the service. The codes are minted, hashed, verified and spent
 *    correctly below and are exercised by the service tests; the route in is
 *    either a widened `totp` field or a recovery operation of its own, and
 *    either is a contract-change issue.
 *
 * Both are raised in the A2 report. `packages/contracts` is LAW.
 *
 * ## Replay, stated rather than implied
 *
 * ⚠ **A code intercepted inside its own 30-second window can be replayed.**
 * Suppressing that needs the last-accepted time step persisted per user
 * (`otplib` takes it as `afterTimeStep`), and `users` has no column for it —
 * `prisma/` is LAW and A2 may not add one. The in-process guard in
 * `sign-in-throttle.ts` closes the common case; a second API task would not see
 * it. Recorded in this module's `CLAUDE.md` as the follow-up it is.
 */

/** RFC 6238 defaults, restated so a change here is a change a reviewer sees. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** ±1 step. See the header for why not ±2. */
export const TOTP_TOLERANCE_SECONDS = TOTP_PERIOD_SECONDS;

/**
 * What an authenticator app shows above the digits. The product name, not the
 * practice name: a firm with two workspaces would otherwise get two entries
 * that both say "Ledgerline" and neither says what for.
 *
 * ⚠ Kept in step with `notifications/email-copy.ts`'s `SENDER_DISPLAY_NAME` by
 * hand, not by import — that module's seam publishes copy for *email*, and a
 * cross-module import for one string would put auth-tenancy behind
 * notifications at boot. M1's rename touches both.
 */
export const TOTP_ISSUER = 'Neo Accounting';

/** How many recovery codes an enrolment mints. Ten is the industry norm and fits on one printed line each. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * The recovery-code alphabet: lower-case letters and digits, minus `i`, `l`,
 * `o`, `0` and `1`. Those five are the pairs a human transcribes wrongly off a
 * screenshot or a printout, and a recovery code is by definition typed by
 * someone who has already lost their normal route in.
 */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const RECOVERY_GROUPS = 4;
const RECOVERY_GROUP_LENGTH = 4;

/**
 * Burned when there is no enrolment to check against, so that "no such user"
 * costs the same HMAC as "wrong code" — `DUMMY_PASSWORD_HASH`'s job, for the
 * other factor. It is a fixed, published base32 string and it is NOT a secret:
 * nothing verifies against it, no account holds it, and a code that matches it
 * is discarded unread.
 */
const DUMMY_TOTP_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/**
 * One configured verifier for the whole process, rather than repeating the
 * parameters at each call site — the digits and the period must be identical
 * everywhere or an enrolment verifies against a different clock than it was
 * minted for.
 *
 * ⚠ **`otplib`'s CLASS, not its top-level `verify`.** The functional export
 * returns a TOTP-or-HOTP union whose HOTP half carries no `timeStep`, so the
 * replay claim in `auth.service.ts` cannot be typed off it. `TOTP` is the same
 * code with the strategy already fixed, and `timeStep` is the field RFC 6238
 * §5.2 replay suppression is built on.
 *
 * ⚠ **The plugins are PASSED, not defaulted.** otplib's functional API supplies
 * `NobleCryptoPlugin` and `ScureBase32Plugin` for you; the class does not, and
 * omitting them throws `CryptoPluginMissingError` at the first call — at
 * runtime, not at compile time. Both are pure JavaScript and ship inside
 * `otplib`, so this adds no dependency and no native build.
 *
 * Exported because a TEST that generates codes must generate them with these
 * exact parameters. A test that builds its own `TOTP` proves that two
 * configurations agree, not that the server's one works.
 */
export const totpEngine = new TOTP({
  issuer: TOTP_ISSUER,
  digits: TOTP_DIGITS,
  period: TOTP_PERIOD_SECONDS,
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
});

/** What an enrolment produces. Everything except `ref` is shown ONCE and never stored. */
export interface TotpEnrolment {
  /** The base32 seed, for the manual-entry fallback under the QR code. */
  readonly secret: string;
  /** `otpauth://totp/...` — render this as the QR code. */
  readonly uri: string;
  /** Plaintext, shown once. Only their hashes survive, inside `ref`. */
  readonly recoveryCodes: readonly string[];
  /** What goes in `users.totp_secret_ref`. */
  readonly ref: string;
}

/**
 * The outcome of checking a second factor.
 *
 * `updatedRef` is non-null only when a RECOVERY code was spent: the code is
 * removed from the material, so the caller must persist the new ref or the code
 * stays live. That is the whole of what makes a recovery code single-use, and it
 * is why this returns a value the caller has to do something with rather than a
 * boolean it can ignore.
 */
export type SecondFactorVerdict =
  | { readonly ok: false }
  | {
      readonly ok: true;
      readonly usedRecoveryCode: boolean;
      /** Non-null ONLY when a recovery code was spent. Persist it, or the code stays live. */
      readonly updatedRef: string | null;
      /**
       * The RFC 6238 time step the code matched, for replay suppression. Null
       * for a recovery code (there is no step) and for the `demo` fixture.
       */
      readonly timeStep: number | null;
    };

/**
 * Mint a fresh enrolment: a seed, the QR URI, ten recovery codes, and the
 * envelope to store.
 *
 * `label` is what the app shows under the issuer — the user's own address, so
 * someone with two accounts can tell them apart. It is untrusted text going into
 * a URI; `generateURI` percent-encodes it, and a test pins that.
 */
export function createTotpEnrolment(label: string, wrappingSecret: string): TotpEnrolment {
  const secret = totpEngine.generateSecret();
  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  const material: TotpMaterial = { secret, recoveryHashes: recoveryCodes.map(hashRecoveryCode) };
  return {
    secret,
    uri: totpEngine.toURI({ label, secret }),
    recoveryCodes,
    ref: wrapTotpMaterial(material, wrappingSecret),
  };
}

/**
 * Check a submitted second factor against what `users.totp_secret_ref` holds:
 * the time-based code first, then the recovery codes.
 *
 * ⚠ **Both checks always run, and neither short-circuits the other.** A wrong
 * TOTP that is also not a recovery code must cost the same work as a wrong TOTP
 * that might have been one — otherwise the response time says which kind of
 * secret the caller was guessing at, and an attacker learns to stop wasting
 * guesses on the six-digit space.
 *
 * Returns `{ok: false}` — never a throw — for an absent, unreadable or
 * key-mismatched ref. A user with no enrolment simply has no second factor that
 * can pass, which is the fail-closed state `OTP_MODE=totp` is meant to produce.
 */
export async function verifySecondFactor(
  ref: string | null,
  code: string,
  wrappingSecret: string,
  nowMs: number = Date.now(),
): Promise<SecondFactorVerdict> {
  const material = unwrapTotpMaterial(ref, wrappingSecret);
  if (material === null) {
    // ⚠ SPEND THE SAME HMAC ANYWAY. Returning here without it would make an
    // address with no enrolment — which, given A1's uniform `NT-AUTH-003`, is
    // mostly an address with no ACCOUNT — measurably faster to refuse than a
    // real one. That is the enumeration oracle `DUMMY_PASSWORD_HASH` exists to
    // close on the password half, and it would be reopened on this half. The
    // burn is inside this function rather than at the call site so a caller
    // cannot forget it.
    await verifyTimed(DUMMY_TOTP_SECRET, code, nowMs);
    return { ok: false };
  }

  const timed = await verifyTimed(material.secret, code, nowMs);
  const recoveryIndex = findRecoveryCode(material.recoveryHashes, code);

  if (timed !== null) {
    return { ok: true, usedRecoveryCode: false, updatedRef: null, timeStep: timed };
  }
  if (recoveryIndex === -1) return { ok: false };

  // Spend it. The remaining hashes are re-wrapped under a FRESH nonce, so two
  // envelopes for the same account never share an IV — which is the one thing
  // AES-GCM does not forgive.
  const remaining = material.recoveryHashes.filter((_, index) => index !== recoveryIndex);
  return {
    ok: true,
    usedRecoveryCode: true,
    updatedRef: wrapTotpMaterial({ secret: material.secret, recoveryHashes: remaining }, wrappingSecret),
    timeStep: null,
  };
}

/** How many unspent recovery codes an enrolment has left. For the settings screen, when it exists. */
export function recoveryCodesRemaining(ref: string | null, wrappingSecret: string): number {
  return unwrapTotpMaterial(ref, wrappingSecret)?.recoveryHashes.length ?? 0;
}

/**
 * The RFC 6238 check: the matched time step, or null.
 *
 * ⚠ **otplib THROWS on a token that is not six digits** (`TokenLengthError`,
 * from its guardrails) rather than returning `{valid: false}`. On a login path
 * that would be a `500` for a mistyped code — and, since a RECOVERY code is
 * nineteen characters, it would have made the recovery branch below
 * unreachable. So the shape is checked first and any guardrail throw is
 * swallowed into "did not verify": a malformed credential is a failed login,
 * never a server error that says something broke.
 *
 * The shape test leaks nothing. It reads only the caller's own input, and a
 * caller knows what they typed.
 */
async function verifyTimed(secret: string, code: string, nowMs: number): Promise<number | null> {
  const token = code.trim();
  if (!/^[0-9]{6}$/.test(token)) return null;
  try {
    const result = await totpEngine.verify(token, {
      secret,
      epoch: Math.floor(nowMs / 1000),
      epochTolerance: TOTP_TOLERANCE_SECONDS,
    });
    return result.valid ? result.timeStep : null;
  } catch {
    return null;
  }
}

/**
 * `abcd-efgh-jkmn-pqrs`. Sixteen characters from a 31-symbol alphabet is ~79
 * bits — far beyond guessing, which is what lets the storage hash be a plain
 * SHA-256 rather than a password KDF (see `hashRecoveryCode`).
 *
 * `randomInt` rather than `randomBytes(1) % 31`: the modulo is biased towards
 * the first symbols of the alphabet, and `randomInt` rejection-samples for us.
 */
function generateRecoveryCode(): string {
  return Array.from({ length: RECOVERY_GROUPS }, () =>
    Array.from({ length: RECOVERY_GROUP_LENGTH }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join(''),
  ).join('-');
}

/**
 * `sha256(normalised code)`, hex.
 *
 * ⚠ **NOT the scrypt in `password.ts`, and the difference is deliberate.** A
 * password is short, human-chosen and drawn from a guessable distribution, so it
 * needs a slow KDF to make an offline dictionary attack expensive. A recovery
 * code is 79 bits of CSPRNG output from an alphabet nobody chose — there is no
 * dictionary to attack and nothing for the work factor to buy. What a fast hash
 * buys instead is real: a login attempt compares against ten stored hashes, and
 * ten scrypts is a full second of blocked event loop per wrong code, which is a
 * denial-of-service anyone can trigger for free. This is the same argument
 * `portal-session.service.ts` records for `link_token_hash`, and it is the same
 * class of secret.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}

/**
 * Lower-cased, and with every character outside the alphabet stripped — so
 * `ABCD EFGH-JKMN pqrs` matches `abcd-efgh-jkmn-pqrs`. A recovery code is typed
 * by a person who has lost their phone; punctuation they added or dropped is not
 * a reason to refuse them.
 */
function normaliseRecoveryCode(code: string): string {
  return [...code.toLowerCase()].filter((character) => RECOVERY_ALPHABET.includes(character)).join('');
}

/**
 * Which stored hash the code matches, or -1.
 *
 * EVERY hash is compared, with no early return, and each comparison is
 * `timingSafeEqual`: a loop that breaks on the first match would take longer for
 * a code stored late in the list than early, which leaks the position of a
 * matching code and, over many attempts, how many are left.
 */
function findRecoveryCode(hashes: readonly string[], code: string): number {
  const candidate = Buffer.from(hashRecoveryCode(code), 'hex');
  let found = -1;
  hashes.forEach((stored, index) => {
    const storedBuffer = Buffer.from(stored, 'hex');
    if (storedBuffer.length === candidate.length && timingSafeEqual(storedBuffer, candidate)) found = index;
  });
  return found;
}
