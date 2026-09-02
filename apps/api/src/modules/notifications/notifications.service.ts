import { Logger } from '@nestjs/common';

import { addressDomain, type EmailAddress, parseEmailAddress } from './email-address.js';
import {
  type ComposeBusinessPeopleInviteInput,
  composeBusinessPeopleInvite,
  type ComposeClientInviteInput,
  type ComposedEmail,
  composeClientInvite,
  type ComposeDocumentRequestInput,
  composeDocumentRequest,
  composeDuplicateSignupNotice,
  type ComposeEmailVerificationInput,
  composeEmailVerification,
  type ComposeSignInCodeInput,
  composeSignInCode,
  type ComposeTeamInviteInput,
  composeTeamInvite,
} from './email-copy.js';
import type { EmailRateLimiter } from './email-rate-limit.js';
import type { EmailKind, EmailSender } from './email-sender.js';

/**
 * The one door outbound email leaves by (S2).
 *
 * Every send goes: **parse the address → consume the rate limit → compose →
 * transport → log the metadata**. Callers hand over facts, never a subject and
 * never a body — composition lives in `email-copy.ts` and is a pure function,
 * so the message a reviewer reads is byte-for-byte the message that sends
 * (`chase/sms-copy.ts` makes the same promise for SMS and for the same reason).
 *
 * ## Why a refusal is a return value and not an exception
 *
 * `send*` answers with a {@link SendOutcome}. It does not throw when the rate
 * limit refuses, because the caller's correct response depends on which caller
 * it is, and only one of them is obvious:
 *
 * - A **sign-in** endpoint must answer identically whether the address is
 *   known, unknown or rate-limited. Anything else is an account-enumeration
 *   oracle, which is the same stance `portal-session.service.ts` takes when it
 *   collapses five distinct failures into one `NT-OTP-001`.
 * - An **invite** endpoint should tell the accountant plainly — they are a
 *   trusted, authenticated user looking at their own client list, and "nothing
 *   happened, silently" is the worst answer.
 * - A **chase batch** should record the skip and carry on to the next client.
 *
 * A thrown exception forces all three into the same shape. A verdict lets each
 * one decide.
 *
 * ## What reaches the logs
 *
 * The kind, the provider's message id, and the recipient's DOMAIN. Never the
 * address (personal data, Governance §11.6) and never the body — which for the
 * sign-in message contains a live credential. The domain plus the message id is
 * what an incident actually needs: "did anything go to this client's provider,
 * and what is the id SES knows it by".
 */

export type SendOutcome =
  | { readonly sent: true; readonly kind: EmailKind; readonly providerMessageId: string }
  | { readonly sent: false; readonly kind: EmailKind; readonly reason: 'rate-limited'; readonly retryAfterSeconds: number };

/** The caller's request context, when there is one. See `RateLimitRequest.ip`. */
export interface SendContext {
  /**
   * The IP the request arrived from. Omitted for system-initiated sends (a
   * worker running a chase batch) — see the note on `RateLimitRequest.ip`.
   */
  readonly ip?: string | undefined;
}

export interface SendClientInviteInput extends ComposeClientInviteInput {
  /** The client's address, unvalidated. Parsed here — this is the boundary (R4). */
  readonly to: string;
}

export interface SendTeamInviteInput extends ComposeTeamInviteInput {
  /** The colleague's address, unvalidated. Parsed here — this is the boundary (R4). */
  readonly to: string;
}

export interface SendBusinessPeopleInviteInput extends ComposeBusinessPeopleInviteInput {
  /** The new starter's address, unvalidated. Parsed here — this is the boundary (R4). */
  readonly to: string;
}

export interface SendSignInCodeInput extends ComposeSignInCodeInput {
  readonly to: string;
}

export interface SendDocumentRequestInput extends ComposeDocumentRequestInput {
  readonly to: string;
}

export interface SendEmailVerificationInput extends ComposeEmailVerificationInput {
  readonly to: string;
}

/** No composed fields — the notice deliberately carries nothing but the address. */
export interface SendDuplicateSignupNoticeInput {
  readonly to: string;
}

export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly sender: EmailSender,
    private readonly limiter: EmailRateLimiter,
  ) {}

  /** S2 message 1 — the accountant adds a client, the client gets a link. */
  sendClientInvite(input: SendClientInviteInput, context: SendContext = {}): Promise<SendOutcome> {
    return this.#deliver('client-invite', input.to, context, () => composeClientInvite(input));
  }

  /**
   * A practice admin invites a COLLEAGUE — the message that lets a firm stop
   * being one person.
   *
   * Its own kind and its own composer, never `sendClientInvite`: that copy says
   * there is "no password to choose", which is right for a client and exactly
   * wrong for a member of staff whose next action is to choose one. Like the
   * client invite it reports a rate-limit refusal as a VALUE rather than
   * throwing — the caller is a trusted authenticated admin looking at their own
   * team list, and `practice-team.service.ts` turns the refusal into a `429`
   * that says the invitation was recorded and the email was not sent.
   */
  sendTeamInvite(input: SendTeamInviteInput, context: SendContext = {}): Promise<SendOutcome> {
    return this.#deliver('team-invite', input.to, context, () => composeTeamInvite(input));
  }

  /**
   * A CLIENT BUSINESS invites its own staff — the third invitation relationship
   * (D45, 2 Sep 2026).
   *
   * Its own kind and its own composer for the reasons {@link
   * composeBusinessPeopleInvite} sets out at length: a portal person never
   * chooses a password, so `sendTeamInvite`'s copy would send a new starter
   * looking for a screen that does not exist; and the employer is a business
   * rather than the practice, so `sendClientInvite`'s "your accountant has
   * invited you" names a firm the reader may never have heard of.
   *
   * The refusal is a VALUE here, like both other invitations: the caller is the
   * business's own admin looking at their own People list, and
   * `portal-people.service.ts` turns a rate-limit refusal into a `429` that says
   * the person was added and the email was not sent. Silence would be the worst
   * answer — they would re-invite, and the row already exists.
   */
  sendBusinessPeopleInvite(input: SendBusinessPeopleInviteInput, context: SendContext = {}): Promise<SendOutcome> {
    return this.#deliver('business-people-invite', input.to, context, () => composeBusinessPeopleInvite(input));
  }

  /** S2 message 2 — six digits, short expiry, single use. */
  sendSignInCode(input: SendSignInCodeInput, context: SendContext = {}): Promise<SendOutcome> {
    return this.#deliver('sign-in-code', input.to, context, () => composeSignInCode(input));
  }

  /**
   * The signup verification mail — the message `POST /v1/practices` depends on
   * to mean anything.
   *
   * ⚠ **A failure here must reach the caller.** {@link SendOutcome} reports a
   * rate-limit refusal rather than throwing, and for sign-in that is right: the
   * endpoint must answer identically whether the address is known, unknown or
   * limited. Signup is the opposite case. A practice created whose verification
   * mail went nowhere is an account that can never become usable, so
   * `practice-signup.service.ts` treats a non-sent outcome as a failed signup
   * rather than a `202`.
   */
  sendEmailVerification(input: SendEmailVerificationInput, context: SendContext = {}): Promise<SendOutcome> {
    return this.#deliver('email-verification', input.to, context, () => composeEmailVerification(input));
  }

  /**
   * The notice that makes the uninformative `202` honest — see
   * {@link composeDuplicateSignupNotice} for why it says so little.
   */
  sendDuplicateSignupNotice(
    input: SendDuplicateSignupNoticeInput,
    context: SendContext = {},
  ): Promise<SendOutcome> {
    return this.#deliver('duplicate-signup', input.to, context, composeDuplicateSignupNotice);
  }

  /** S2 message 3 — the chase, by email instead of SMS. Wiring is A14's. */
  sendDocumentRequest(input: SendDocumentRequestInput, context: SendContext = {}): Promise<SendOutcome> {
    return this.#deliver('document-request', input.to, context, () => composeDocumentRequest(input));
  }

  async #deliver(
    kind: EmailKind,
    rawAddress: string,
    context: SendContext,
    compose: () => ComposedEmail,
  ): Promise<SendOutcome> {
    // Parse first, before the limiter. A malformed address must not be able to
    // consume a real recipient's ceiling, and `parseEmailAddress` throws — a
    // bad address here is a caller bug, not a runtime condition (R4).
    const to: EmailAddress = parseEmailAddress(rawAddress);

    const verdict = await this.limiter.consume({ kind, address: to, ip: context.ip });
    if (!verdict.allowed) {
      // Logged at warn: one line is a client mistyping their address, a burst is
      // an attack, and the domain is enough to tell those apart.
      this.logger.warn(
        `email refused by rate limit · kind=${kind} domain=${addressDomain(to)} limitedBy=${verdict.limitedBy ?? 'unknown'} retryAfter=${verdict.retryAfterSeconds}s`,
      );
      return { sent: false, kind, reason: 'rate-limited', retryAfterSeconds: verdict.retryAfterSeconds };
    }

    // Compose AFTER the limit is granted. For the sign-in message this means a
    // refused send never materialises the code into a string at all.
    const composed = compose();
    const sent = await this.sender.send({ kind, to, subject: composed.subject, body: composed.body, ...(composed.html === undefined ? {} : { html: composed.html }) });

    // The full log line, and everything it deliberately omits: no address, no
    // subject (which would fingerprint the message), no body.
    this.logger.log(`email sent · kind=${kind} domain=${addressDomain(to)} messageId=${sent.providerMessageId}`);

    return { sent: true, kind, providerMessageId: sent.providerMessageId };
  }
}
