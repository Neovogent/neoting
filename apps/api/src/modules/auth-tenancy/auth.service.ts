import { HttpStatus } from '@nestjs/common';

import type { Me } from '@neoting/contracts/model';

import { unauthenticated } from '../../common/context/request-context.js';
import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { AppException } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import { verifyDemoPassword } from './demo-credentials.js';
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

/**
 * Login + the `/me` context read (METH Stage 1, issue #118).
 *
 * Login is deliberately STATELESS on the server: it writes nothing — no
 * session row, no `lastLoginAt` — so it needs no scope context (there is none
 * yet; producing one is the whole point) and sits legitimately outside the
 * Review → Approve path, which governs product state.
 */
export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: Env,
  ) {}

  /** Verify credentials, mint the signed session token. Throws 401 `NT-AUTH-003` on ANY miss. */
  login(input: LoginInput): IssuedSession {
    // Both checks ALWAYS run before the branch: short-circuiting on the
    // password would make a TOTP-only failure measurably faster and leak which
    // factor was wrong — the one thing NT-AUTH-003's single code exists to hide.
    const userId = verifyDemoPassword(input.email, input.password);
    const totpValid = this.verifyTotp(input.totp);
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
