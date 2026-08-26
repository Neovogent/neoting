import { HttpStatus } from '@nestjs/common';

import type { PrismaClient } from '../../common/db/prisma.js';
import { AppException } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import { createTotpEnrolment, recoveryCodesRemaining, verifySecondFactor } from './totp.js';

/**
 * QR enrolment for the real second factor (launch stage A2) — the service half.
 *
 * ⚠⚠ **NOTHING ROUTES TO THIS YET, AND THAT IS A CONTRACT GAP, NOT AN
 * OVERSIGHT.** `packages/contracts/openapi.yaml` publishes no TOTP operation:
 * there is no `POST /v1/me/totp`, no `POST /v1/me/totp/confirmation`, no
 * enrolment surface of any kind. `packages/contracts` is LAW (G7), so A2 may not
 * add one — it needs a contract-change issue Shakib approves first. This is the
 * same shape A1 left `confirmEmailVerification` in, and for the same reason:
 * the logic is written and tested so the missing piece is a controller and
 * nothing else.
 *
 * ⚠ **THE CONSEQUENCE, STATED PLAINLY.** `config/env.ts` refuses `OTP_MODE=demo`
 * under `NODE_ENV=production`, and `OTP_MODE=totp` fails closed for any account
 * with no enrolment. With no enrolment endpoint, a production deployment today
 * has a second factor nobody can register — so nobody can sign in. That is the
 * correct failure (the alternative is one published code guarding everyone's
 * books) but it BLOCKS `docs/launch/PLAN.md`'s step 1, "Sign up as a new
 * practice. Set up MFA.", and it is raised in the A2 report.
 *
 * ## Why this is not solved by mailing the QR code
 *
 * It would be one line to hand the `otpauth://` URI to the signup mailer and
 * skip the endpoint. It must not be: the seed would then travel over the same
 * channel that recovers the password, so both factors would live in one mailbox
 * and the second factor would protect nothing it does not already. Enrolment is
 * an authenticated in-app action or it is theatre.
 *
 * ## Two steps, and why
 *
 * `begin` mints a candidate and stores it with `totp_enabled_at` still NULL.
 * `confirm` requires a code generated FROM that candidate before setting
 * `totp_enabled_at` — proof that the QR actually reached an authenticator app.
 * Enrolling in one step means an accountant who mis-scans is locked out of their
 * own workspace with no way back, which is the failure a second factor is most
 * likely to cause and the one nobody tests for.
 */

/** What `begin` returns. Shown ONCE, on the enrolment screen, and never stored in the clear. */
export interface TotpEnrolmentOffer {
  /** Render as the QR code. */
  readonly uri: string;
  /** The manual-entry fallback for a device that cannot scan. */
  readonly secret: string;
  /** Ten single-use codes. The user must be told they are the only way back in. */
  readonly recoveryCodes: readonly string[];
}

export class TotpEnrolmentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: Env,
  ) {}

  /**
   * Mint a candidate enrolment for a signed-in user and store it unconfirmed.
   *
   * ⚠ Re-enrolling REPLACES the previous secret and the previous recovery
   * codes, and it does so before the new one is confirmed — so a user who
   * abandons this screen has no working second factor until they finish. That is
   * deliberate: the alternative is holding two live secrets at once, which
   * doubles the material an attacker needs to steal only one of.
   * `totp_enabled_at` is cleared to make the half-finished state visible rather
   * than inferred.
   *
   * The `users` touch is the same privileged, unscoped one `auth.service.ts`
   * documents: `users` carries no RLS, and the caller has already been
   * authenticated by the session resolver — this method never chooses the id.
   */
  async begin(userId: string): Promise<TotpEnrolmentOffer> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, kind: true } });
    // A SYSTEM actor has no phone and no person behind it; a user with no login
    // address has nothing to label the authenticator entry with.
    if (user === null || user.kind !== 'HUMAN' || user.email === null) {
      throw new AppException('NT-AUTH-003', HttpStatus.UNAUTHORIZED, 'Invalid credentials', 'This account cannot enrol a second factor.');
    }

    const enrolment = createTotpEnrolment(user.email, this.env.SESSION_SECRET);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { totpSecretRef: enrolment.ref, totpEnabledAt: null },
    });

    return { uri: enrolment.uri, secret: enrolment.secret, recoveryCodes: enrolment.recoveryCodes };
  }

  /**
   * Prove the app has the seed, then switch the factor on.
   *
   * A recovery code is NOT accepted here: it would confirm an enrolment without
   * ever proving the authenticator received anything, which is exactly the
   * mis-scan lockout the two-step split exists to prevent. `verifySecondFactor`
   * will happily match one, so the verdict is narrowed rather than trusted.
   */
  async confirm(userId: string, code: string, nowMs: number = Date.now()): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, totpSecretRef: true } });
    const verdict = user === null ? { ok: false as const } : await verifySecondFactor(user.totpSecretRef, code, this.env.SESSION_SECRET, nowMs);

    if (!verdict.ok || verdict.usedRecoveryCode) {
      throw new AppException(
        'NT-AUTH-003',
        HttpStatus.UNAUTHORIZED,
        'Invalid credentials',
        'That code did not match. Check the app is showing the current six digits and try again.',
      );
    }

    await this.prisma.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date(nowMs) } });
  }

  /** How many recovery codes are left, for the settings screen the contract has yet to publish. */
  async recoveryCodesLeft(userId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { totpSecretRef: true } });
    return recoveryCodesRemaining(user?.totpSecretRef ?? null, this.env.SESSION_SECRET);
  }
}
