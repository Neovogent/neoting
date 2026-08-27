import { HttpStatus } from '@nestjs/common';

import type { PrismaClient } from '../../common/db/prisma.js';
import { AppException } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import { type CredentialRow, findCredentialRow, verifyCredentials } from './credentials.js';
import { normaliseEmail } from './practice-signup.service.js';
import { RateLimitedException, type SignInThrottle } from './sign-in-throttle.js';
import { TOTP_ENROLMENT_TICKET_TTL_MS, signTotpEnrolmentTicket, verifyTotpEnrolmentTicket } from './totp-enrolment-ticket.js';
import { createTotpEnrolment, recoveryCodesRemaining, verifySecondFactor } from './totp.js';

/**
 * QR enrolment for the real second factor — **the whole of it** (launch stage
 * A2 wrote the service; A14, issue #195, gave it a door and made its two-step
 * real).
 *
 * `POST /v1/auth/totp-enrolment` → {@link begin} ·
 * `POST /v1/auth/totp-enrolment/confirm` → {@link confirm}.
 *
 * ## What A14 changed, and why it was not cosmetic
 *
 * A2's `begin` took a `userId` from an already-authenticated session and
 * **wrote `users.totp_secret_ref` immediately**, leaving `totp_enabled_at`
 * null; `confirm` only set the timestamp. Two things were wrong with that, and
 * the second is severe:
 *
 * 1. **It could not be reached.** It needed a session, and under
 *    `OTP_MODE=totp` a user with no enrolment cannot get one — the endpoint
 *    that fixes the problem sat behind the problem. Enrolment is therefore
 *    authenticated by PASSWORD ONLY. It is the one authenticated route that
 *    cannot require a second factor, because its whole purpose is that the
 *    caller has none.
 * 2. **The factor went live at step one.** Nothing on the login path reads
 *    `totp_enabled_at` — `auth.service.ts` verifies against the ref alone — so
 *    the ref existing *was* the enrolment. Mis-scan the QR and the account has
 *    a second factor nothing can produce a code for; try again and #195's "an
 *    account that already has an enrolment may not enrol" refuses you; and
 *    there is no reset flow in this release. **One mis-scan, permanent
 *    lockout.**
 *
 * So the candidate never touches the database until a code proves an
 * authenticator received it. It travels instead, as a signed short-lived
 * ticket — `totp-enrolment-ticket.ts`, which carries the reasoning and the
 * disclosure argument. **{@link begin} writes nothing at all**, which is why
 * `openapi.yaml` classes it `x-nt-side-effect: none`; if that ever stops being
 * true, the contract is wrong and Governance §10.6's route-table test is what
 * should say so.
 *
 * ## The window this endpoint opens, stated rather than implied
 *
 * ⚠ Between verifying an address and finishing enrolment, **whoever knows the
 * password can claim the second factor.** That is inherent to enrolling after
 * signup rather than during it. What bounds it: the account cannot be logged
 * into by anyone at all until an enrolment exists, so nothing is taken from a
 * user who was already in; the window for a real user is the minutes between
 * clicking the verification link and scanning a QR; and the endpoint shares the
 * per-address lockout with sign-in, so it cannot be used as an unthrottled
 * password oracle. The alternative — mailing the seed at signup — puts both
 * factors in one mailbox and is strictly worse.
 *
 * ## ⚠ There is still no "let them in without a factor" branch, and there must
 * not be
 *
 * `auth.service.ts` fails CLOSED for an account with no enrolment. This service
 * is the door that refusal points at; it is not a way around it. Nothing here
 * issues a session, and nothing here touches the login path.
 *
 * ## Under `OTP_MODE=demo`
 *
 * Enrolment still works and still writes a real ref, but the LOGIN path ignores
 * it and accepts the fixed demo code. A developer who enrols locally under
 * `demo` will find their authenticator's codes refused — which reads like a
 * bug and is not one. `config/env.ts` refuses `demo` under
 * `NODE_ENV=production`, so no customer can meet it. Refusing to enrol under
 * `demo` was the alternative and it costs more than it buys: it would make the
 * enrolment path untestable in exactly the environment people test it in.
 */

/** What `begin` returns. Shown ONCE, on the enrolment screen, and never stored in the clear. */
export interface TotpEnrolmentOffer {
  /**
   * The candidate, signed and short-lived. The client posts it back to
   * `confirm` — it is what keeps the enrolment out of the database until a real
   * code arrives (`totp-enrolment-ticket.ts`).
   */
  readonly enrolmentToken: string;
  /** Render as the QR code. */
  readonly uri: string;
  /** The manual-entry fallback for a device that cannot scan. */
  readonly secret: string;
  /** Ten single-use codes. The user must be told they are the only way back in. */
  readonly recoveryCodes: readonly string[];
}

export interface BeginTotpEnrolmentInput {
  readonly email: string;
  readonly password: string;
}

export interface ConfirmTotpEnrolmentInput {
  readonly email: string;
  readonly password: string;
  readonly enrolmentToken: string;
  readonly totp: string;
}

export class TotpEnrolmentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: Env,
    /**
     * ⚠ **THE SAME INSTANCE THE LOGIN PATH USES**, keyed on the same normalised
     * address. Two counters would mean ten guesses at `/auth/sessions` plus ten
     * more here — and this endpoint checks a password with no second factor in
     * front of it, so it is the cheaper of the two to guess against. One
     * counter, one ceiling.
     */
    private readonly throttle: SignInThrottle,
  ) {}

  /**
   * Mint a candidate enrolment. **Writes nothing.**
   *
   * Calling it twice is free and produces two independent candidates; whichever
   * ticket is confirmed first wins and the other simply expires. That is the
   * property the whole two-step exists for — an abandoned attempt has to cost
   * nothing, or a mis-scan is terminal.
   */
  async begin(input: BeginTotpEnrolmentInput, nowMs: number = Date.now()): Promise<TotpEnrolmentOffer> {
    const email = normaliseEmail(input.email);
    // BEFORE any scrypt. A locked address must cost the server nothing, or the
    // lockout is an amplifier rather than a defence.
    const standing = this.throttle.inspect(email, nowMs);
    if (standing.locked) throw new RateLimitedException(standing.retryAfterSeconds);

    const user = await this.assertMayEnrol(email, input.password, nowMs);
    this.throttle.recordSuccess(email);

    const enrolment = createTotpEnrolment(user.email, this.env.SESSION_SECRET);
    return {
      enrolmentToken: signTotpEnrolmentTicket(
        { userId: user.id, email: user.email, ref: enrolment.ref, expiresAtMs: nowMs + TOTP_ENROLMENT_TICKET_TTL_MS },
        this.env.SESSION_SECRET,
      ),
      uri: enrolment.uri,
      secret: enrolment.secret,
      recoveryCodes: enrolment.recoveryCodes,
    };
  }

  /**
   * Prove the app has the seed, then — and only then — write the enrolment.
   *
   * A recovery code is NOT accepted here: it would confirm an enrolment without
   * ever proving the authenticator received anything, which is exactly the
   * mis-scan the two-step exists to catch. `verifySecondFactor` will happily
   * match one, so the verdict is narrowed rather than trusted.
   */
  async confirm(input: ConfirmTotpEnrolmentInput, nowMs: number = Date.now()): Promise<void> {
    const email = normaliseEmail(input.email);
    const standing = this.throttle.inspect(email, nowMs);
    if (standing.locked) throw new RateLimitedException(standing.retryAfterSeconds);

    const user = await this.assertMayEnrol(email, input.password, nowMs);

    const ticket = verifyTotpEnrolmentTicket(input.enrolmentToken, this.env.SESSION_SECRET, nowMs);
    // ⚠ A bad ticket does NOT count a throttle failure. The password has
    // already verified, so this is not a guessing surface — and a user whose
    // ticket expired while they were writing down recovery codes must not be
    // pushed towards a lockout for it. The refusal names itself
    // (`NT-AUTH-008`) precisely because starting again is the whole remedy.
    if (!ticket.ok || ticket.claims.userId !== user.id) {
      throw new AppException(
        'NT-AUTH-008',
        HttpStatus.UNAUTHORIZED,
        'Enrolment session not valid',
        'That setup session is no longer valid. Start setting up your authenticator app again.',
      );
    }

    const verdict = await verifySecondFactor(ticket.claims.ref, input.totp, this.env.SESSION_SECRET, nowMs);
    if (!verdict.ok || verdict.usedRecoveryCode) {
      return this.refuse(email, nowMs, 'That code did not match. Check the app is showing the current six digits and try again.');
    }

    // ⚠ CONDITIONAL ON THE REF STILL BEING NULL, and that is what makes "an
    // account that already has an enrolment may not enrol" a property rather
    // than a check. `assertMayEnrol` read the row a few milliseconds ago; two
    // confirmations racing would otherwise both pass it and the second would
    // overwrite the first's seed — silently replacing a factor the user has
    // already stored in their phone. `updateMany` is what allows a non-unique
    // predicate in the WHERE; `update` cannot express this.
    const written = await this.prisma.user.updateMany({
      where: { id: user.id, totpSecretRef: null },
      data: { totpSecretRef: ticket.claims.ref, totpEnabledAt: new Date(nowMs) },
    });
    if (written.count !== 1) throw alreadyEnrolled();

    this.throttle.recordSuccess(email);
  }

  /** How many recovery codes are left, for the settings screen the contract has yet to publish. */
  async recoveryCodesLeft(userId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { totpSecretRef: true } });
    return recoveryCodesRemaining(user?.totpSecretRef ?? null, this.env.SESSION_SECRET);
  }

  /**
   * The shared gate for both steps: the password, then the account state.
   *
   * The ORDER is the security argument. A wrong password is the uniform
   * `NT-AUTH-003` and reveals nothing, so it is answered first; only a caller
   * who has already proved the password ever reaches the two named refusals,
   * by which point there is nothing left to enumerate and each one leads
   * somewhere a user can actually go.
   *
   * Neither named refusal counts a throttle failure — the password was right,
   * and a user who clicks the link twice must not be able to lock themselves
   * out with it.
   */
  private async assertMayEnrol(
    email: string,
    password: string,
    nowMs: number,
  ): Promise<CredentialRow & { readonly email: string }> {
    const row = await findCredentialRow(this.prisma, email);
    const credentials = verifyCredentials(row, email, password, this.env.NODE_ENV);

    if (!credentials.ok && credentials.reason === 'no-match') {
      return this.refuse(email, nowMs, 'The email or password did not match.');
    }
    if (!credentials.ok) {
      // `unverified`, and NAMING it is safe here for the reason in
      // `credentials.ts`: the caller has proved the password. It is also
      // necessary — #195 refuses enrolment on an unverified address precisely
      // so the mailbox check is not decorative, and a user told only "invalid
      // credentials" would retype a correct password for ever.
      throw new AppException(
        'NT-AUTH-006',
        HttpStatus.CONFLICT,
        'Email address not verified',
        'Verify your email address before setting up an authenticator app. Check your inbox for the link we sent when you signed up.',
      );
    }
    if (credentials.user.totpSecretRef !== null) throw alreadyEnrolled();
    // `findCredentialRow` looked this row up BY email, so it cannot be null.
    // Narrowed rather than asserted, because `createTotpEnrolment` labels the
    // authenticator entry with it and a null there would be a runtime throw on
    // the happy path.
    const label = credentials.user.email;
    if (label === null) return this.refuse(email, nowMs, 'The email or password did not match.');
    return { ...credentials.user, email: label };
  }

  /**
   * Count the failure, then answer — the same shape, and the same threshold
   * behaviour, as `auth.service.ts`'s refusal. The attempt that TRIPS the lock
   * answers `429`: the threshold is not a secret, and telling the person at the
   * moment it happens is the only way they can act on it.
   */
  private refuse(email: string, nowMs: number, detail: string): never {
    const verdict = this.throttle.recordFailure(email, nowMs);
    if (verdict.locked) throw new RateLimitedException(verdict.retryAfterSeconds);
    throw new AppException('NT-AUTH-003', HttpStatus.UNAUTHORIZED, 'Invalid credentials', detail);
  }
}

/**
 * Raised from two places — the pre-check and the conditional write — because
 * the second is what makes it true under a race and the first is what makes the
 * common case cheap. One message, so they cannot drift.
 */
function alreadyEnrolled(): AppException {
  return new AppException(
    'NT-AUTH-007',
    HttpStatus.CONFLICT,
    'Authenticator already set up',
    'This account already has an authenticator app set up. Sign in with the code it shows.',
  );
}
