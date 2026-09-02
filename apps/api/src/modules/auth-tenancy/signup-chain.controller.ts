import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';

import type {
  EmailVerificationResult,
  InvitationAcceptanceResult,
  InvitationPreview,
  TotpEnrolmentOffer as TotpEnrolmentOfferDto,
} from '@neoting/contracts/model';
import {
  acceptInvitationBody,
  acceptInvitationHeader,
  beginTotpEnrolmentBody,
  confirmTotpEnrolmentBody,
  confirmTotpEnrolmentHeader,
  previewInvitationBody,
  verifyEmailAddressBody,
  verifyEmailAddressHeader,
} from '@neoting/contracts/zod';

import { parseBoundary, parseIdempotencyKey } from '../../common/validation/parse-boundary.js';
import type { EmailVerificationService } from './email-verification.service.js';
import type { InvitationAcceptanceService } from './invitation-acceptance.service.js';
import { applyRateLimitHeaders } from './rate-limit-headers.js';
import { RateLimitedException } from './sign-in-throttle.js';
import { EMAIL_VERIFICATION_SERVICE, INVITATION_ACCEPTANCE_SERVICE, TOTP_ENROLMENT_SERVICE } from './tokens.js';
import type { TotpEnrolmentService } from './totp-enrolment.service.js';

/**
 * The signup chain (launch stage A14, contract-change issue #195): prove the
 * address, then enrol an authenticator.
 *
 * These three operations exist because A1 and A2 each built one half of a
 * journey and neither half had a door. Signup minted a verification token
 * nothing consumed, so an account created through the product's own front door
 * could never become usable; and the second factor fails CLOSED for an account
 * with no enrolment, so under `OTP_MODE=totp` — what staging runs — the refusal
 * pointed at an endpoint nobody had built. Not "no new customers": nobody able
 * to sign in at all.
 *
 * **Two more operations joined it** with the practice-invite work — the
 * COLLEAGUE's half of the same journey. An invited colleague lands on
 * `/invite?token=…`, previews what they are accepting, chooses a password, and
 * then walks the same two enrolment steps as the founder. One controller,
 * because it is one problem — becoming an account somebody can sign in as —
 * reached through two doors.
 *
 * ⚠ **ALL FIVE ARE `security: []`, AND EACH HAS ITS OWN REASON.** This
 * controller injects no `RequestContext` and must never call `require()` —
 * there is nothing here that could accidentally read one.
 *
 *   - **Email verification** — the token IS the authorisation, and the account
 *     it proves is by definition one nobody can log into yet.
 *   - **Both enrolment steps** — authenticated by PASSWORD ONLY, in the body.
 *     This is the one authenticated route that cannot require a second factor,
 *     because its entire purpose is that the caller does not have one. See
 *     `totp-enrolment.service.ts` for the window that opens and what bounds it.
 *   - **Both invitation steps** — the token is the authorisation, and the user
 *     acceptance creates does not exist until it succeeds. ⚠ Acceptance issues
 *     NO session; `invitation-acceptance.service.ts` says why nothing here may
 *     stand in for a second factor the account does not have yet.
 *
 * ⚠ **THE `Idempotency-Key` IS REQUIRED AND PARSED, AND DELIBERATELY NOT
 * REPLAY-CACHED** — the same call `portal.controller.ts` makes on
 * `POST /portal/sessions`, for the same reason. The contract requires the
 * header on every mutation (Governance §3), so a missing or non-UUID one is a
 * `400` here rather than a silent non-idempotent write. But a replay cache
 * keyed on a *caller-supplied header* on a *public* endpoint hands the first
 * caller's response to the second, and on `verifyEmailAddress` — and now on
 * `acceptInvitation` — that response names an email address. All three
 * mutations are already idempotent where it matters, and by construction rather
 * than by cache: verification flips a one-way flag under a conditional write, a
 * replayed confirmation meets `NT-AUTH-007` because the ref it would write is
 * already there, and a replayed acceptance meets an `accepted_at` stamped under
 * a `SELECT … FOR UPDATE`. The contract still declares the `409` because that is
 * the shape of the header, and a durable store would produce it.
 *
 * Thin by design (`apps/api/CLAUDE.md`): parse with the generated schemas, call
 * ONE service method, map the result.
 */
@Controller()
export class SignupChainController {
  constructor(
    @Inject(EMAIL_VERIFICATION_SERVICE) private readonly verification: EmailVerificationService,
    @Inject(TOTP_ENROLMENT_SERVICE) private readonly enrolment: TotpEnrolmentService,
    @Inject(INVITATION_ACCEPTANCE_SERVICE) private readonly invitations: InvitationAcceptanceService,
  ) {}

  /**
   * `POST /v1/auth/invitation-preview` — what the link in a colleague's
   * invitation email is FOR.
   *
   * ⚠ **`POST` and not `GET`, and it is the only reason a read lives on this
   * verb.** The token is a credential; a `GET` would carry it in the query
   * string, which puts it in browser history, in every access log on the way,
   * and in the `Referer` header of the next outbound link on the page. A body is
   * the only place a token may travel. It writes nothing
   * (`x-nt-side-effect: none`) and therefore takes **no `Idempotency-Key`** —
   * the `beginTotpEnrolment` precedent above.
   */
  @Post('auth/invitation-preview')
  @HttpCode(HttpStatus.OK)
  async previewInvitation(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<InvitationPreview> {
    const input = parseBoundary(previewInvitationBody, body, 'request body');
    return this.withRateLimitHeaders(res, () => this.invitations.preview(input.token));
  }

  /**
   * `POST /v1/auth/invitation-acceptance` — the colleague's account exists after
   * this and not before.
   *
   * `201` with the address alone. ⚠ **No session is issued**: the account has no
   * second factor yet, and sign-in fails closed without one, so anything
   * session-shaped returned here would be either useless or a way round the
   * factor. The next call is `POST /auth/totp-enrolment` with the password they
   * just chose.
   */
  @Post('auth/invitation-acceptance')
  @HttpCode(HttpStatus.CREATED)
  async acceptInvitation(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvitationAcceptanceResult> {
    parseIdempotencyKey(acceptInvitationHeader, idempotencyKey);
    const input = parseBoundary(acceptInvitationBody, body, 'request body');
    return this.withRateLimitHeaders(res, () => this.invitations.accept(input));
  }

  /**
   * `POST /v1/auth/email-verification` — spend the link from the signup email.
   *
   * `200` with the address, so the next screen can carry it into enrolment
   * without asking the user to retype it. That discloses nothing: the caller
   * holds a valid token, and a token's claims are signed rather than encrypted,
   * so they could already read it.
   */
  @Post('auth/email-verification')
  @HttpCode(HttpStatus.OK)
  async verifyEmailAddress(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EmailVerificationResult> {
    parseIdempotencyKey(verifyEmailAddressHeader, idempotencyKey);
    const input = parseBoundary(verifyEmailAddressBody, body, 'request body');
    return this.withRateLimitHeaders(res, () => this.verification.verify(input.token));
  }

  /**
   * `POST /v1/auth/totp-enrolment` — mint the QR, the seed and the recovery
   * codes. **Writes nothing** (`x-nt-side-effect: none`), which is what lets an
   * abandoned attempt cost nothing.
   */
  @Post('auth/totp-enrolment')
  @HttpCode(HttpStatus.OK)
  async beginTotpEnrolment(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TotpEnrolmentOfferDto> {
    const input = parseBoundary(beginTotpEnrolmentBody, body, 'request body');
    const offer = await this.withRateLimitHeaders(res, () => this.enrolment.begin(input));
    return {
      enrolmentToken: offer.enrolmentToken,
      uri: offer.uri,
      secret: offer.secret,
      // The service's type is readonly; the DTO's is not. Copied rather than
      // cast, so nothing downstream can mutate the offer.
      recoveryCodes: [...offer.recoveryCodes],
    };
  }

  /**
   * `POST /v1/auth/totp-enrolment/confirm` — the step that writes the
   * enrolment, and the only one that does.
   *
   * `204`: there is nothing to say that the next sign-in does not say better,
   * and anything returned here would be secret material the previous response
   * already delivered once.
   */
  @Post('auth/totp-enrolment/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmTotpEnrolment(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    parseIdempotencyKey(confirmTotpEnrolmentHeader, idempotencyKey);
    const input = parseBoundary(confirmTotpEnrolmentBody, body, 'request body');
    await this.withRateLimitHeaders(res, () => this.enrolment.confirm(input));
  }

  /**
   * The contract declares `Retry-After` and the three `RateLimit-*` headers on
   * every `429`, and the global `ProblemFilter` renders only the body. Wrapping
   * here means no route can forget them — which matters more on this controller
   * than on login, because all three of these are places a person gets stuck
   * and needs to be told for how long.
   */
  private async withRateLimitHeaders<T>(res: Response, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof RateLimitedException) applyRateLimitHeaders(res, error.retryAfterSeconds);
      throw error;
    }
  }
}
