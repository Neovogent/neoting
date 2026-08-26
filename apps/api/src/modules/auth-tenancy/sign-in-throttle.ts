import { HttpStatus } from '@nestjs/common';

import { AppException } from '../../common/problem/problem.js';

/**
 * The sign-in lockout (launch stage A2).
 *
 * Before this, `POST /v1/auth/sessions` had no ceiling of any kind — a six-digit
 * second factor with unlimited attempts is a four-digit one by lunchtime, and a
 * password with unlimited attempts is a dictionary away from being nobody's
 * password at all. Nothing anywhere in the API counted a failure.
 *
 * ## ⚠ THE KEY IS THE SUBMITTED ADDRESS, NEVER THE USER ROW. READ THIS FIRST.
 *
 * This is the whole security argument, and getting it wrong re-opens the
 * enumeration hole A1 went to trouble to close.
 *
 * A1 answers an unknown address, a wrong password, an unverified address and a
 * deactivated account with the SAME `401 NT-AUTH-003`, so that a caller cannot
 * learn whether an address is registered. A lockout keyed on `users.id` would
 * undo that in one step: only a real account can have a counter, so "this
 * account is locked" — or any response that only ever appears for real accounts
 * — is a confirmed yes to "does this firm have a workspace here".
 *
 * So the counter is keyed on **the normalised string the caller typed**. It is
 * created, incremented and locked identically for `priya@ledgerline.test` and
 * for `nobody@nowhere.invalid`, and `sign-in-throttle.test.ts` asserts the two
 * are byte-identical at every step. A `429` therefore says only *"this address
 * has been tried too many times recently"*, which is a fact about the CALLER's
 * own behaviour and true of any string they type. It says nothing about who
 * exists.
 *
 * ## Why a visible 429 rather than another silent 401
 *
 * A silent 401 would hide the lockout from the attacker — and equally from the
 * accountant who fat-fingered their passphrase, who would then be told their
 * correct password is wrong, with no way to find out why. Given the key reveals
 * nothing (above), the honest answer is strictly better: it is the only failure
 * on this endpoint that a legitimate user can act on. It is also what the
 * contract declares — `openapi.yaml` publishes `429` on `createSession` and
 * `NT-RATE-001`, and nothing implemented it.
 *
 * The residual cost, stated because it is real: anyone who knows an
 * accountant's address can lock it for the window by failing ten times. That is
 * the standard lockout trade, the window is deliberately short, and the
 * alternative — no ceiling at all — is what we have today.
 *
 * ## Counting failures, not attempts
 *
 * Only a FAILED sign-in increments, and a success clears the entry. A ceiling on
 * total attempts would lock out an office sharing one workspace on a busy
 * morning; a ceiling on failures only ever bites someone who is guessing. The
 * success reset is not an oracle either — producing one requires the credentials
 * the attacker is trying to find.
 *
 * ## ⚠ IN-PROCESS, AND THAT IS A REAL LIMIT
 *
 * The counters live in a `Map` in one Node process. Production runs more than
 * one API task, so ten-per-address is really ten per task per window and the
 * numbers below are optimistic by the task count. `notifications/email-rate-limit.ts`
 * hit exactly this and answered it with a Redis implementation behind an
 * `EMAIL_RATE_LIMIT` switch — the same answer belongs here, and it needs a new
 * variable in `config/env.ts`, which is outside this stage's owned paths (A2
 * may touch that file only for the `OTP_MODE` refusal). The interface below is
 * shaped so a `RedisSignInThrottle` drops in beside `InMemorySignInThrottle`
 * without a call-site change. Recorded in the module `CLAUDE.md`.
 */

/** Failures per address before the address is locked. */
export const SIGN_IN_MAX_FAILURES = 10;

/**
 * How long a failure counts for, and how long a lockout lasts. Fifteen minutes
 * is long enough to make ten-guesses-per-quarter-hour useless against a
 * six-digit code (it is ~1 in 6,900 per window against a live TOTP) and short
 * enough that a locked-out accountant is not locked out of their working day.
 */
export const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;

export interface ThrottleVerdict {
  readonly locked: boolean;
  /** Seconds until the lock lifts. 0 when not locked. */
  readonly retryAfterSeconds: number;
  /** Failures left before the lock. 0 once locked. */
  readonly remaining: number;
}

const OPEN: ThrottleVerdict = Object.freeze({ locked: false, retryAfterSeconds: 0, remaining: SIGN_IN_MAX_FAILURES });

/**
 * The seam. One implementation today; a Redis one lands beside it the day
 * `config/env.ts` grows the switch for it (see the header).
 */
export interface SignInThrottle {
  /** Is this address locked right now? Called BEFORE any scrypt is spent. */
  inspect(identity: string, nowMs?: number): ThrottleVerdict;
  /** A sign-in that did not verify. Returns the verdict AFTER the increment. */
  recordFailure(identity: string, nowMs?: number): ThrottleVerdict;
  /** A sign-in that did verify. Clears the entry. */
  recordSuccess(identity: string): void;
  /**
   * Claim a TOTP time step for a user, once. `false` means this exact code has
   * already been spent in this window — a replay.
   */
  claimTimeStep(userId: string, timeStep: number, nowMs?: number): boolean;
}

interface Entry {
  failures: number;
  /** When the entry stops counting — refreshed on each failure. */
  expiresAtMs: number;
  lockedUntilMs: number;
}

export class InMemorySignInThrottle implements SignInThrottle {
  readonly #entries = new Map<string, Entry>();
  /** `userId:timeStep` → when the claim may be forgotten. See `claimTimeStep`. */
  readonly #spentSteps = new Map<string, number>();

  inspect(identity: string, nowMs: number = Date.now()): ThrottleVerdict {
    this.#sweep(nowMs);
    const entry = this.#entries.get(identity);
    if (entry === undefined) return OPEN;
    if (entry.lockedUntilMs > nowMs) {
      return { locked: true, retryAfterSeconds: secondsUntil(entry.lockedUntilMs, nowMs), remaining: 0 };
    }
    return { locked: false, retryAfterSeconds: 0, remaining: Math.max(0, SIGN_IN_MAX_FAILURES - entry.failures) };
  }

  recordFailure(identity: string, nowMs: number = Date.now()): ThrottleVerdict {
    this.#sweep(nowMs);
    const existing = this.#entries.get(identity);
    // An entry whose window has already passed starts again from one rather than
    // resuming — otherwise a failure a fortnight ago still counts today.
    const entry: Entry =
      existing === undefined || existing.expiresAtMs <= nowMs
        ? { failures: 0, expiresAtMs: 0, lockedUntilMs: 0 }
        : existing;

    entry.failures += 1;
    entry.expiresAtMs = nowMs + SIGN_IN_WINDOW_MS;
    if (entry.failures >= SIGN_IN_MAX_FAILURES) {
      entry.lockedUntilMs = nowMs + SIGN_IN_WINDOW_MS;
    }
    this.#entries.set(identity, entry);
    return this.inspect(identity, nowMs);
  }

  recordSuccess(identity: string): void {
    this.#entries.delete(identity);
  }

  /**
   * Single-use TOTP codes, within the reach of one process.
   *
   * RFC 6238 §5.2 asks that an accepted code not be accepted twice: a code shoulder-surfed
   * or captured mid-flight is live for up to its whole 30-second step plus the
   * tolerance either side. Suppressing it properly needs the last-accepted step
   * persisted on the user, and `users` has no column for it (`prisma/` is LAW),
   * so this is the reachable half: a claim held in memory for two windows.
   *
   * ⚠ It does NOT hold across API tasks or restarts — the same caveat as the
   * counters above, from the same cause, with the same fix.
   */
  claimTimeStep(userId: string, timeStep: number, nowMs: number = Date.now()): boolean {
    this.#sweep(nowMs);
    const key = `${userId}:${timeStep}`;
    if (this.#spentSteps.has(key)) return false;
    this.#spentSteps.set(key, nowMs + SIGN_IN_WINDOW_MS);
    return true;
  }

  /**
   * Drop everything that can no longer be read. Without it the maps grow for the
   * life of the container, one entry per address ever typed — a leak that only
   * shows up in a long-lived process, which is exactly where nobody is watching
   * (`email-rate-limit.ts` records the same reasoning for the same reason).
   */
  #sweep(nowMs: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAtMs <= nowMs && entry.lockedUntilMs <= nowMs) this.#entries.delete(key);
    }
    for (const [key, expiresAtMs] of this.#spentSteps) {
      if (expiresAtMs <= nowMs) this.#spentSteps.delete(key);
    }
  }
}

/**
 * The contract's `429` for a throttled sign-in, carrying the seconds the
 * controller renders as `Retry-After`.
 *
 * ⚠ The detail names the ADDRESS's recent attempts and never an account, a
 * password or a user. "Too many sign-in attempts for this email address" is true
 * of any string the caller typed; "this account is locked" would be a confirmed
 * answer to the question the whole login lane refuses to answer.
 */
export class RateLimitedException extends AppException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      'NT-RATE-001',
      HttpStatus.TOO_MANY_REQUESTS,
      'Too many attempts',
      'Too many sign-in attempts for this email address. Try again shortly.',
    );
  }
}

function secondsUntil(atMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((atMs - nowMs) / 1000));
}
