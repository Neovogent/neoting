import { HttpStatus } from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { PrismaClient } from '../../common/db/prisma.js';
import { AppException } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import { verifyEmailVerificationToken } from './email-verification.js';
import { RateLimitedException, type SignInThrottle } from './sign-in-throttle.js';

/**
 * `POST /v1/auth/email-verification` — the endpoint that turns a signed-up
 * account into a usable one (launch stage A14, issue #195).
 *
 * A1 minted and mailed the token and left a note here saying nothing consumed
 * it and that this was a contract gap rather than an oversight. It was: with no
 * consumer, `users.email_verified` could only ever be set by `prisma/seed.ts`,
 * and `auth.service.ts` refuses a session to an unverified address. Every
 * account created through the product's own front door was therefore permanent
 * scenery — a practice with an owner nobody could log in as.
 *
 * ## What it may and may not say
 *
 * The token IS the authorisation, so the operation is unauthenticated — the
 * account it proves is by definition one nobody can log into yet.
 *
 * - **`NT-AUTH-004` is uniform.** Missing, malformed, forged, minted for
 *   another purpose, naming a user that has been deleted or deactivated, or
 *   naming an address that has since changed — one verdict for all of them. Any
 *   split here is a probe: "this token names a real user" is a fact about
 *   somebody, and the whole login lane goes to trouble not to answer it.
 * - **`NT-AUTH-005` names expiry**, and only expiry. It is safe because the
 *   token was genuinely ours and its holder already had it, so it discloses
 *   nothing they did not have; and it is necessary because "ask for another
 *   one" is the sole action available to someone who let a link go stale.
 *   This is the same split, for the same reason, as `NT-AUTH-001` versus
 *   `NT-AUTH-002` on the session cookie.
 *
 * ## Idempotent, deliberately
 *
 * Verifying an already-verified address is a `200`, not a `409`. Corporate mail
 * scanners fetch links before humans click them, and clients retry. A second
 * visit must not turn a working account into an error page — and there is
 * nothing to protect: the flip is one-way and re-asserting it changes nothing.
 */

/** What the verify-link screen gets back. See `EmailVerificationResult` in the contract. */
export interface EmailVerificationOutcome {
  readonly email: string;
  readonly alreadyVerified: boolean;
}

/**
 * The throttle namespace for this path.
 *
 * ⚠ The counter is keyed on a HASH of the token, never the token itself: the
 * throttle keeps its keys in a process-wide `Map`, and a live credential is not
 * something to leave lying in one. The prefix keeps this key space disjoint
 * from the login counter's, which is keyed on a normalised email address —
 * `ev:` followed by hex is not an address the contract's `format: email` would
 * ever admit.
 */
function throttleKey(token: string): string {
  return `ev:${createHash('sha256').update(token).digest('hex')}`;
}

export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: Env,
    /**
     * ⚠ **PER TOKEN, AND THAT IS NOT THE SAME AS PER CALLER.** It bounds
     * repeated work against one link — a scanner in a loop, a user hammering
     * refresh on a dead one — and it does NOT bound a flood, because an
     * attacker varies the token for free. The ceiling that would is per-IP, and
     * this API cannot have one yet: `main.ts` never calls
     * `app.set('trust proxy', …)`, so behind the ALB `req.ip` is the load
     * balancer for every request — an "IP" ceiling would be one global ceiling
     * that takes the endpoint down for everyone under load, and trusting
     * `X-Forwarded-For` without it is trusting an attacker-supplied header.
     * The module `CLAUDE.md` records this as the ordering it is: wire the proxy
     * trust first, then add the ceiling, on this path and on sign-in together.
     *
     * What makes that tolerable here rather than alarming: the token is an
     * HMAC, so there is nothing to guess, and a rejected one costs one hash and
     * no database round trip.
     */
    private readonly throttle: SignInThrottle,
  ) {}

  async verify(token: string, nowMs: number = Date.now()): Promise<EmailVerificationOutcome> {
    const key = throttleKey(token);
    const standing = this.throttle.inspect(key, nowMs);
    if (standing.locked) throw new RateLimitedException(standing.retryAfterSeconds);

    const verdict = verifyEmailVerificationToken(token, this.env.SESSION_SECRET, nowMs);
    if (!verdict.ok) {
      return this.refuse(key, nowMs, verdict.reason === 'expired' ? expiredLink() : invalidLink());
    }

    const user = await this.prisma.user.findUnique({
      where: { id: verdict.claims.userId },
      select: { id: true, kind: true, email: true, emailVerified: true, deactivatedAt: true },
    });

    // Everything below collapses into the one `NT-AUTH-004`. A token whose user
    // is gone, deactivated, a SYSTEM actor, or whose address has changed since
    // the token was minted is a token that proves control of nothing that
    // currently exists — and saying WHICH would answer a question about an
    // account to a caller who has no session.
    //
    // The address comparison is what binds the token to the mailbox rather than
    // to the row: change the address and the outstanding link stops working,
    // which is the property the claim exists for.
    if (user === null || user.kind !== 'HUMAN' || user.deactivatedAt !== null || user.email !== verdict.claims.email) {
      return this.refuse(key, nowMs, invalidLink());
    }

    // ⚠ CONDITIONAL ON IT STILL BEING FALSE, so the flip and the "was it
    // already done" answer are one atomic statement rather than a read
    // followed by a write that a concurrent request can slip between.
    // `updateMany` is what allows a non-unique predicate in the WHERE.
    // A count of zero means someone else got there first — which is success,
    // not a conflict, and is exactly the idempotency the contract promises.
    const flipped = await this.prisma.user.updateMany({
      where: { id: user.id, emailVerified: false },
      data: { emailVerified: true },
    });

    this.throttle.recordSuccess(key);
    return { email: user.email, alreadyVerified: flipped.count === 0 };
  }

  /**
   * Count the failure, then answer — the same shape as `auth.service.ts`'s
   * refusal, and the same reason for it. The attempt that TRIPS the lock
   * answers `429` rather than repeating the token error: the threshold is not a
   * secret, and someone hammering a dead link needs to be told to stop and for
   * how long, or they will simply keep clicking.
   */
  private refuse(key: string, nowMs: number, problem: AppException): never {
    const verdict = this.throttle.recordFailure(key, nowMs);
    if (verdict.locked) throw new RateLimitedException(verdict.retryAfterSeconds);
    throw problem;
  }
}

function invalidLink(): AppException {
  return new AppException(
    'NT-AUTH-004',
    HttpStatus.UNAUTHORIZED,
    'Verification link not valid',
    'That verification link is not valid. Sign up again to get a new one.',
  );
}

function expiredLink(): AppException {
  return new AppException(
    'NT-AUTH-005',
    HttpStatus.UNAUTHORIZED,
    'Verification link expired',
    'That verification link has expired. Sign up again to get a new one.',
  );
}
