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

/** The fixed demo verification code (METH_MODE §7). */
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
 * It still writes nothing, and that is deliberate: a failed-login counter and a
 * lockout are stage A2's, and they are a write, so they arrive with the design
 * that makes a write on an unauthenticated path safe.
 */
export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: Env,
  ) {}

  /** Verify credentials, mint the signed session token. Throws 401 `NT-AUTH-003` on ANY miss. */
  async login(input: LoginInput): Promise<IssuedSession> {
    const email = normaliseEmail(input.email);
    const user = await this.findCredentialRow(email);

    // Every check ALWAYS runs before the branch, and each miss still spends a
    // scrypt. Short-circuiting on the password would make a TOTP-only failure
    // measurably faster and leak which factor was wrong; short-circuiting on an
    // unknown address would leak whether the address is registered. Those two
    // leaks are the whole reason NT-AUTH-003 is one code.
    const storedMatched = verifyPasswordHash(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    const demoUserId = verifyDemoPassword(email, input.password, this.env.NODE_ENV);
    const totpValid = this.verifyTotp(input.totp);

    const userId = this.resolveUserId(user, storedMatched, demoUserId);
    if (userId === null || !totpValid) {
      throw new AppException(
        'NT-AUTH-003',
        HttpStatus.UNAUTHORIZED,
        'Invalid credentials',
        'The email, password or verification code did not match.',
      );
    }

    const expiresAtMs = Date.now() + SESSION_TTL_MS;
    return {
      token: signSessionToken({ userId, expiresAtMs }, this.env.SESSION_SECRET),
      expiresAt: new Date(expiresAtMs),
    };
  }

  /**
   * The privileged by-email lookup. See the class header for why it is not
   * inside `scopedDb` and why that is not a bypass.
   */
  private async findCredentialRow(email: string): Promise<CredentialRow | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true, kind: true, passwordHash: true, emailVerified: true, deactivatedAt: true },
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

  // DEMO-MOCK: Twilio Verify (real TOTP) replaces this fixed-code check. The
  // mode switch stays explicit so the real verifier lands as a new branch on
  // OTP_MODE, not a rewrite of the callers.
  private verifyTotp(totp: string): boolean {
    return this.env.OTP_MODE === 'demo' && totp === DEMO_TOTP_CODE;
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
