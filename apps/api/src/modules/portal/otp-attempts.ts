import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The portal OTP's attempt counter and lockout (launch stage A2) — the pure
 * half, so the policy is testable without a database and stated in one place.
 *
 * ## The columns were always there
 *
 * `otp_sessions.attempts` and `otp_sessions.locked_until` have existed since the
 * schema was written, and until this stage **nothing read or wrote either of
 * them**. This module's own `CLAUDE.md` said so out loud — *"METH Stage 9 says
 * 'Rate-limit nothing', so `otp_sessions.attempts` / `locked_until` are
 * deliberately unused"* — which was an acceptable demo decision and is not an
 * acceptable shipping one. A six-digit code with unlimited attempts is a
 * four-digit code by lunchtime: 10^6 guesses at even ten per second is under a
 * day, and nothing was counting.
 *
 * ## Five attempts, not ten
 *
 * Tighter than `auth-tenancy/sign-in-throttle.ts`'s ten, on purpose. A workspace
 * sign-in has a passphrase in front of the six digits, so the code is the
 * SECOND factor and an attacker must already hold the first. A portal session
 * has no password at all — the link plus the code IS the whole credential — so
 * the code is the only factor and the budget for guessing it has to be smaller.
 *
 * ## What a locked response says: nothing new
 *
 * `openapi.yaml` requires every verification failure on `POST /portal/sessions`
 * to be the same `401 NT-OTP-001` — *"distinguishing them would tell a guesser
 * which links exist"* — so a lockout is that same 401, with the same words, and
 * it is NOT the `429` the sign-in path returns. That is not an inconsistency
 * between the two lanes; it follows from what the key is in each. The sign-in
 * counter is keyed on a string the caller typed, so saying "too many attempts"
 * reveals only their own behaviour. This counter is keyed on a **link the
 * caller holds**, and the row it lives on exists only for a real chase — so
 * "this link is locked" would confirm that the link names something, which is
 * precisely the question the uniform 401 exists to refuse.
 *
 * ## What is NOT counted, and why
 *
 * A link token that does not verify — forged, truncated, expired — is not
 * counted at all: there is no chase behind it, so there is no tenant to write a
 * row under, and inventing one would let an unauthenticated caller create rows
 * by sending noise. It also has nothing to brute-force; the token is 256 bits of
 * HMAC output and guessing it is not the attack. What IS the attack is a valid
 * link plus six digits, and that is exactly what this counts.
 */

/** Wrong codes tolerated on one link before it stops accepting any. */
export const PORTAL_OTP_MAX_ATTEMPTS = 5;

/**
 * How long the lock holds. Fifteen minutes matches the sign-in lane so there is
 * one number in the product rather than two, and it turns 10^6 guesses into
 * roughly nine years of wall clock on a single link.
 */
export const PORTAL_OTP_LOCKOUT_MS = 15 * 60 * 1000;

/** The two columns, as the service reads them off the row. */
export interface OtpAttemptState {
  readonly attempts: number;
  readonly lockedUntil: Date | null;
}

/** What to write after a wrong code. */
export interface OtpAttemptWrite {
  readonly attempts: number;
  readonly lockedUntil: Date | null;
}

/** Reset — what a SUCCESSFUL verification writes, so a client who mistyped twice is not punished for it later. */
export const OTP_ATTEMPTS_CLEARED: OtpAttemptWrite = Object.freeze({ attempts: 0, lockedUntil: null });

/** Is this link barred right now? A lock in the past has simply lapsed; nothing sweeps it. */
export function isOtpLocked(state: OtpAttemptState | null, nowMs: number): boolean {
  return state?.lockedUntil != null && state.lockedUntil.getTime() > nowMs;
}

/**
 * The counter after one more wrong code.
 *
 * A lapsed lock restarts the count rather than resuming it: a client who was
 * locked out this morning, waited, and mistyped once this afternoon must not be
 * locked again on that single mistake. An attacker gains five guesses per
 * fifteen minutes from the same rule, which is the trade and is the point of the
 * lock rather than a hole in it.
 */
export function nextOtpAttempt(state: OtpAttemptState | null, nowMs: number): OtpAttemptWrite {
  const lapsed = state !== null && state.lockedUntil !== null && state.lockedUntil.getTime() <= nowMs;
  const attempts = (lapsed || state === null ? 0 : state.attempts) + 1;
  return attempts >= PORTAL_OTP_MAX_ATTEMPTS
    ? { attempts, lockedUntil: new Date(nowMs + PORTAL_OTP_LOCKOUT_MS) }
    : { attempts, lockedUntil: null };
}

/**
 * `sha256(otp)`, hex — what `otp_sessions.otp_hash` holds.
 *
 * A six-digit code is only 20 bits, so a hash of it is trivially reversible by
 * anyone holding the column, and this is NOT pretending otherwise. What it buys
 * is that the code is not sitting in the database in the clear next to the row
 * that says who it was sent to, and that a log or a backup of the table is not a
 * list of live credentials. The real defence against guessing is the counter
 * above and the short `otp_expires_at`; the hash is hygiene, and saying so is
 * better than implying a strength it does not have.
 */
export function hashOtp(otp: string): string {
  return createHash('sha256').update(otp.trim()).digest('hex');
}

/**
 * Constant-time compare of a submitted code against the stored hash, honouring
 * the expiry.
 *
 * The hash is computed BEFORE any of the absent/expired branches, so a session
 * with no minted code costs the same as one with a wrong code. Returns false —
 * never throws — for every failure, because the caller turns all of them into
 * one 401.
 */
export function otpMatches(storedHash: string | null, expiresAt: Date | null, otp: string, nowMs: number): boolean {
  const candidate = Buffer.from(hashOtp(otp), 'hex');
  if (storedHash === null || storedHash === '') return false;
  // A code with no expiry is a code that never stops being valid. Refuse it
  // rather than treat "unset" as "for ever" — fail closed, the house stance.
  if (expiresAt === null || expiresAt.getTime() <= nowMs) return false;
  const stored = Buffer.from(storedHash, 'hex');
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}
