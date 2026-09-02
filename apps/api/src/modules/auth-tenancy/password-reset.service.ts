import { createHash } from 'node:crypto';

import { HttpStatus, Logger } from '@nestjs/common';

import type { PrismaClient } from '../../common/db/prisma.js';
import { AppException } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import type { NotificationsService } from '../notifications/index.js';
import { normaliseEmail } from './practice-signup.service.js';
import { hashPassword } from './password.js';
import {
  PASSWORD_RESET_TTL_MS,
  passwordFingerprint,
  signPasswordResetToken,
  verifyPasswordResetToken,
} from './password-reset.js';
import { RateLimitedException, type SignInThrottle } from './sign-in-throttle.js';

/**
 * The forgotten-password flow (2 Sep 2026) — the lockout edge this module's
 * own TODO carried: an account whose password is forgotten had "no
 * self-service route back in".
 *
 * Two halves, deliberately asymmetric — the sign-in-codes table, verbatim:
 *
 * | | Answers | Why |
 * |---|---|---|
 * | `request` | **always, silently — `202`** | Whether an address has an account is not something an unauthenticated caller may learn (the `POST /practices` stance). The mail distinguishes the outcomes, and it goes to the address. |
 * | `reset`   | one uniform `NT-AUTH-004` (expiry alone named as `-005`) | By then the caller holds a token we mailed; the split is the verification endpoint's, for its reasons. |
 *
 * **The token is single-use with no table**: its claims carry a fingerprint of
 * the password hash it was minted against, and the reset replaces that hash —
 * so the spend kills every outstanding token at once, including itself
 * (`password-reset.ts` has the full argument). The second factor is untouched:
 * a reset password still meets the TOTP gate, which is what makes an
 * email-only reset acceptable on an account holding a practice's books.
 */
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: Env,
    private readonly notifications: NotificationsService,
    /** The same per-token throttle discipline as email verification. */
    private readonly throttle: SignInThrottle,
    /** `<web origin>/signup/reset` — built by the mailer constant's owner, the module. */
    private readonly resetLinkFor: (token: string) => string,
  ) {}

  /**
   * Mint and mail the link — or do nothing, silently. Every refusal is a
   * logged reason (domain only, §11) and the same empty `202`.
   */
  async request(email: string, nowMs: number = Date.now()): Promise<void> {
    const wanted = normaliseEmail(email);
    // The sanctioned unscoped read — `users` carries no RLS, and no scope
    // context exists before a session does (the login lane's own exemption).
    const user = await this.prisma.user.findUnique({
      where: { email: wanted },
      select: { id: true, kind: true, email: true, emailVerified: true, deactivatedAt: true, passwordHash: true },
    });

    const refusal =
      user === null
        ? 'unknown-address'
        : user.kind !== 'HUMAN'
          ? 'not-a-human-account'
          : user.deactivatedAt !== null
            ? 'deactivated'
            : user.passwordHash === null
              ? 'no-password'
              : !user.emailVerified
                ? 'unverified'
                : null;
    if (refusal !== null || user === null || user.email === null || user.passwordHash === null) {
      this.logger.warn(`password reset not sent: ${refusal ?? 'unresolvable'} · domain=${domainOf(wanted)}`);
      return;
    }

    const token = signPasswordResetToken(
      {
        userId: user.id,
        email: user.email,
        passwordFingerprint: passwordFingerprint(user.passwordHash),
        expiresAtMs: nowMs + PASSWORD_RESET_TTL_MS,
      },
      this.env.SESSION_SECRET,
    );

    const sent = await this.notifications.sendPasswordReset({
      to: user.email,
      resetLink: this.resetLinkFor(token),
      expiresInMinutes: Math.round(PASSWORD_RESET_TTL_MS / 60_000),
    });
    // A refusal is RETURNED, not thrown (the sign-in-codes lesson): uniform to
    // the caller, never silent to the operator.
    if (sent.sent === false) {
      this.logger.warn(`password reset not sent: ${sent.reason} · domain=${domainOf(wanted)}`);
    }
  }

  /** Spend the token, set the password. Refusals are the `-004`/`-005` pair. */
  async reset(token: string, newPassword: string, nowMs: number = Date.now()): Promise<void> {
    const key = throttleKey(token);
    const standing = this.throttle.inspect(key, nowMs);
    if (standing.locked) throw new RateLimitedException(standing.retryAfterSeconds);

    const verdict = verifyPasswordResetToken(token, this.env.SESSION_SECRET, nowMs);
    if (!verdict.ok) {
      this.refuse(key, nowMs, verdict.reason === 'expired' ? expiredLink() : invalidLink());
    }

    const user = await this.prisma.user.findUnique({
      where: { id: verdict.claims.userId },
      select: { id: true, kind: true, email: true, deactivatedAt: true, passwordHash: true },
    });

    // One uniform verdict for every mismatch — gone, deactivated, SYSTEM,
    // address changed since minting, and CRUCIALLY a fingerprint that no
    // longer matches: the token was already spent (or the password changed by
    // another door), and saying which would answer a question about somebody's
    // account to a caller with no session.
    if (
      user === null ||
      user.kind !== 'HUMAN' ||
      user.deactivatedAt !== null ||
      user.email !== verdict.claims.email ||
      user.passwordHash === null ||
      passwordFingerprint(user.passwordHash) !== verdict.claims.passwordFingerprint
    ) {
      this.refuse(key, nowMs, invalidLink());
    }

    // Hash OUTSIDE any transaction (scrypt blocks the event loop ~50-100 ms —
    // password.ts's own note), then compare-and-swap on the EXACT hash the
    // fingerprint proved: two racing resets with the same token collapse to
    // one winner, and the loser's updateMany writes nothing.
    const newHash = hashPassword(newPassword);
    const flipped = await this.prisma.user.updateMany({
      where: { id: user.id, passwordHash: user.passwordHash },
      data: { passwordHash: newHash },
    });
    if (flipped.count !== 1) this.refuse(key, nowMs, invalidLink());

    this.throttle.recordSuccess(key);
    // §11: the user id, never the address or anything about the password.
    this.logger.log(`password reset completed · user=${user.id}`);
  }

  private refuse(key: string, nowMs: number, problem: AppException): never {
    const verdict = this.throttle.recordFailure(key, nowMs);
    if (verdict.locked) throw new RateLimitedException(verdict.retryAfterSeconds);
    throw problem;
  }
}

/** Keyed on a hash of the token, prefixed into its own key space — the `ev:` discipline. */
function throttleKey(token: string): string {
  return `pr:${createHash('sha256').update(token).digest('hex')}`;
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

function invalidLink(): AppException {
  return new AppException(
    'NT-AUTH-004',
    HttpStatus.UNAUTHORIZED,
    'Reset link not valid',
    'That reset link is not valid. Request a new one from the sign-in screen.',
  );
}

function expiredLink(): AppException {
  return new AppException(
    'NT-AUTH-005',
    HttpStatus.UNAUTHORIZED,
    'Reset link expired',
    'That reset link has expired. Request a new one from the sign-in screen.',
  );
}
