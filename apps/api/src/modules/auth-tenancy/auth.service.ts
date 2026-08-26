import { HttpStatus } from '@nestjs/common';

import type { Me } from '@neoting/contracts/model';

import { unauthenticated } from '../../common/context/request-context.js';
import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { AppException } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import { verifyDemoPassword } from './demo-credentials.js';
import { DUMMY_PASSWORD_HASH, verifyPasswordHash } from './password.js';
import { normaliseEmail } from './practice-signup.service.js';
import { SESSION_TTL_MS, signSessionToken } from './session-cookie.js';
import { pickActingMembership } from './session-scope.js';
import { RateLimitedException, type SignInThrottle } from './sign-in-throttle.js';
import { type SecondFactorVerdict, verifySecondFactor } from './totp.js';

/**
 * The fixed demo verification code (METH_MODE §7).
 *
 * ⚠ It is reachable only under `OTP_MODE=demo`, and `config/env.ts` REFUSES
 * `demo` under `NODE_ENV=production` (launch stage A2, matching S1). Until that
 * refusal existed this constant was the entire second factor of the product:
 * one code, on every account, in every practice, published here and in the seed.
 */
const DEMO_TOTP_CODE = '000000';

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly totp: string;
}

export interface IssuedSession {
  readonly token: string;
  readonly expiresAt: Date;
}

/** What the privileged by-email lookup needs to decide whether a session may be issued. */
interface CredentialRow {
  readonly id: string;
  readonly kind: string;
  readonly passwordHash: string | null;
  readonly emailVerified: boolean;
  readonly deactivatedAt: Date | null;
  /** The AES-GCM envelope holding the TOTP seed and the recovery-code hashes (`totp-secret.ts`). */
  readonly totpSecretRef: string | null;
}

/**
 * Login + the `/me` context read (METH Stage 1, issue #118; credentials made
 * real by launch stage A1).
 *
 * Login is still STATELESS on the server: it writes nothing — no session row,
 * no `lastLoginAt` — so it needs no scope context (there is none yet; producing
 * one is the whole point) and sits legitimately outside the Review → Approve
 * path, which governs product state.
 *
 * ⚠ **It now READS, where before it read nothing.** A1 moved credentials into
 * `users.password_hash`, so login has to look the user up. Two consequences
 * worth stating rather than discovering:
 *
 * 1. `login` is **async**. Its one caller, `auth.controller.ts`, awaits it.
 * 2. The lookup is by `users.email` and runs OUTSIDE `scopedDb` — the same
 *    privileged exemption, on the same grounds, as `loadScopeForUser` in
 *    `session-scope.ts`: `users` carries no RLS (it is one of the actor tables
 *    the policies themselves read), and this query is the bootstrap that
 *    PRODUCES the identity every scoped query later needs, so it cannot run
 *    inside one. Keep the privileged surface to exactly this query.
 *
 * ⚠ **IT NOW WRITES, ON EXACTLY ONE BRANCH (launch stage A2).** A sign-in that
 * spends a RECOVERY code has to remove that code, or "single-use" is a word
 * rather than a property. That is the only write, it happens only after the
 * credentials have already verified, and it is the same privileged
 * `users`-table touch as the read above — `users` carries no RLS, and there is
 * no scope context to build before a session exists. Nothing else about login
 * writes: no session row, no `lastLoginAt`, and the failed-attempt counter is
 * deliberately in memory (`sign-in-throttle.ts`) rather than in a table, both
 * because `prisma/` is LAW and because a table anyone can make the server write
 * to, unauthenticated, is a different risk from a bounded map.
 */
export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: Env,
    private readonly throttle: SignInThrottle,
  ) {}

  /**
   * Verify credentials, mint the signed session token.
   *
   * Throws `401 NT-AUTH-003` on ANY credential miss and `429 NT-RATE-001` when
   * this ADDRESS has failed too often lately. The two are different questions:
   * the 401 refuses to say who exists, the 429 reports the caller's own recent
   * behaviour against a string they typed. See `sign-in-throttle.ts` for why
   * that distinction is safe and why the counter is keyed on the address rather
   * than on the user row.
   */
  async login(input: LoginInput, nowMs: number = Date.now()): Promise<IssuedSession> {
    const email = normaliseEmail(input.email);

    // BEFORE any scrypt. A locked address must cost the server nothing, or the
    // lockout is an amplifier rather than a defence.
    const standing = this.throttle.inspect(email, nowMs);
    if (standing.locked) throw new RateLimitedException(standing.retryAfterSeconds);

    const user = await this.findCredentialRow(email);

    // Every check ALWAYS runs before the branch, and each miss still spends a
    // scrypt. Short-circuiting on the password would make a TOTP-only failure
    // measurably faster and leak which factor was wrong; short-circuiting on an
    // unknown address would leak whether the address is registered. Those two
    // leaks are the whole reason NT-AUTH-003 is one code. The second factor
    // keeps the same discipline — `verifySecondFactor` burns an HMAC even when
    // there is no enrolment to check.
    const storedMatched = verifyPasswordHash(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    const demoUserId = verifyDemoPassword(email, input.password, this.env.NODE_ENV);
    const factor = await this.verifySecondFactor(user, input.totp, nowMs);

    const userId = this.resolveUserId(user, storedMatched, demoUserId);
    if (userId === null || !factor.ok) return this.refuse(email, nowMs);

    // The second factor verified against the row we found; if the password
    // matched a DIFFERENT row we would be about to mint a session for the wrong
    // person. `resolveUserId` only ever returns `user.id`, so this cannot
    // currently happen — asserted here so that it also cannot start to.
    if (user === null || userId !== user.id) return this.refuse(email, nowMs);

    // Replay: a TOTP code is live for its whole step plus the tolerance either
    // side, so one captured in flight can be presented again. Claiming the step
    // spends it. See `sign-in-throttle.ts` for the honest limits of an
    // in-process claim.
    if (factor.timeStep !== null && !this.throttle.claimTimeStep(user.id, factor.timeStep, nowMs)) {
      return this.refuse(email, nowMs);
    }

    // The one write, and only on the branch that needs it: the spent recovery
    // code is gone from the envelope before the session exists.
    if (factor.updatedRef !== null) {
      await this.prisma.user.update({ where: { id: user.id }, data: { totpSecretRef: factor.updatedRef } });
    }

    this.throttle.recordSuccess(email);

    const expiresAtMs = nowMs + SESSION_TTL_MS;
    return {
      token: signSessionToken({ userId, expiresAtMs }, this.env.SESSION_SECRET),
      expiresAt: new Date(expiresAtMs),
    };
  }

  /**
   * Count the failure, then answer.
   *
   * The attempt that TRIPS the lock answers `429` rather than `401` — the
   * threshold is not a secret, and telling the accountant at the moment it
   * happens is the only way they can act on it. Every other failure is the one
   * `NT-AUTH-003`, unchanged.
   */
  private refuse(email: string, nowMs: number): never {
    const verdict = this.throttle.recordFailure(email, nowMs);
    if (verdict.locked) throw new RateLimitedException(verdict.retryAfterSeconds);
    throw new AppException(
      'NT-AUTH-003',
      HttpStatus.UNAUTHORIZED,
      'Invalid credentials',
      'The email, password or verification code did not match.',
    );
  }

  /**
   * The privileged by-email lookup. See the class header for why it is not
   * inside `scopedDb` and why that is not a bypass.
   */
  private async findCredentialRow(email: string): Promise<CredentialRow | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true, kind: true, passwordHash: true, emailVerified: true, deactivatedAt: true, totpSecretRef: true },
    });
  }

  /**
   * Who, if anyone, this attempt authenticated as.
   *
   * ⚠ **AN UNVERIFIED ADDRESS IS THE SAME `NT-AUTH-003` AS A WRONG PASSWORD,
   * DELIBERATELY.** It is tempting to answer "verify your email first", and it
   * is the friendlier message — but it is also a confirmed answer to "does this
   * firm have an account here", handed to whoever guessed the address, and
   * `POST /v1/practices` goes to the trouble of a contentless `202` precisely so
   * that question stays unanswerable. The person who owns the address already
   * has the mail that tells them; the person who does not owns nothing. Same
   * argument for a deactivated account and for a SYSTEM actor.
   *
   * The demo-fixture branch is a DEVELOPMENT fallback and nothing more:
   * `verifyDemoPassword` has already returned null under `NODE_ENV=production`
   * before this is reached. It still requires a real, verified, active `users`
   * row — the seed creates one with `emailVerified: true` for both fixture
   * accounts — because a login that succeeds against a user who does not exist
   * mints a cookie that 401s on every subsequent request, which is the confusing
   * failure this module's own notes record having hit before.
   */
  private resolveUserId(user: CredentialRow | null, storedMatched: boolean, demoUserId: string | null): string | null {
    if (user === null) return null;
    if (user.kind !== 'HUMAN') return null;
    if (user.deactivatedAt !== null) return null;
    // A1's rule, in one line: the account is unusable until the address is
    // verified. Signup writes `emailVerified: false`; nothing but proving
    // control of the address may write true.
    if (!user.emailVerified) return null;

    const stored = user.passwordHash !== null && storedMatched;
    const demo = demoUserId !== null && demoUserId === user.id;
    return stored || demo ? user.id : null;
  }

  /**
   * The second factor, both modes (launch stage A2).
   *
   * `demo` is the fixed code that used to be the whole of it, kept so a fresh
   * clone and CI sign in offline and refused at boot in production
   * (`config/env.ts`). `totp` is RFC 6238 through otplib, plus the single-use
   * recovery codes, against the envelope in `users.totp_secret_ref`.
   *
   * ⚠ **`totp` fails CLOSED for an account with no enrolment.** There is no
   * "no second factor configured, let them in" branch and there must not be
   * one: that branch is a second factor an attacker can opt out of by being
   * first. See this module's `CLAUDE.md` — the enrolment ENDPOINT is a contract
   * gap (G7), so under `OTP_MODE=totp` today nobody can sign in until it lands.
   * That is the intended state, and it is louder than the alternative.
   */
  private async verifySecondFactor(user: CredentialRow | null, totp: string, nowMs: number): Promise<SecondFactorVerdict> {
    if (this.env.OTP_MODE === 'demo') {
      return totp === DEMO_TOTP_CODE
        ? { ok: true, usedRecoveryCode: false, updatedRef: null, timeStep: null }
        : { ok: false };
    }
    return verifySecondFactor(user?.totpSecretRef ?? null, totp, this.env.SESSION_SECRET, nowMs);
  }

  /**
   * The §13.3 context header: who is signed in, acting as what, over which
   * businesses. One `scopedDb` transaction, so the user row, the acting role
   * and the business list are one consistent snapshot — and the business list
   * is whatever RLS makes visible, never a hand-written tenancy filter.
   */
  async me(ctx: ScopeContext): Promise<Me> {
    return scopedDb(this.prisma, ctx, async (db) => {
      const user = await db.user.findUnique({
        where: { id: ctx.actorId },
        select: { id: true, email: true, firstName: true, lastName: true },
      });
      const memberships = await db.membership.findMany({
        where: { userId: ctx.actorId },
        select: { practiceId: true, businessId: true, role: true },
        orderBy: { createdAt: 'asc' },
      });
      const acting = pickActingMembership(memberships);

      // The resolver verified this user moments ago, so a missing row, a
      // vanished membership or a user with no login email is a session whose
      // ground truth changed mid-flight — 401, so the client re-authenticates,
      // rather than a 500 pretending the server broke.
      if (user === null || user.email === null || acting === null) {
        throw unauthenticated('this session no longer maps to an active workspace user');
      }

      const practice =
        ctx.practiceId === undefined
          ? null
          : await db.practice.findUnique({ where: { id: ctx.practiceId }, select: { id: true, name: true } });

      const businesses = await db.business.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });

      return {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
        },
        practice,
        role: acting.role,
        businesses,
      };
    });
  }
}
