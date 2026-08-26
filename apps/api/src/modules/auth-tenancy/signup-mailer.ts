/**
 * The signup mail seam — **S2's seam, standing in for S2 itself.**
 *
 * ⚠ **THE NOTIFICATIONS MODULE HAS NOT MERGED.** `modules/notifications/` is a
 * `CLAUDE.md` and nothing else on the day this was written ("Skeleton only.
 * Created by the S0 scaffold; no implementation yet"), and A1 may not build it —
 * it is Shakib's stage and another agent's owned path. So A1 builds against the
 * shape S2 will provide and hands the composition root one line to change:
 *
 *     provide: SIGNUP_MAILER, useFactory: () => new SesSignupMailer(...)
 *
 * Nothing in `practice-signup.service.ts` moves when that lands. The interface
 * below is deliberately narrow — two messages, no templating, no preferences —
 * because a seam invented ahead of its implementation should describe what the
 * caller needs and not guess at what the implementer will want.
 *
 * ⚠ **AND IT IS REFUSED IN PRODUCTION.** `RecordingSignupMailer` sends nothing.
 * A practice created in production whose verification mail went nowhere is an
 * account that can never become usable — a silent, permanent, paid-for failure.
 * `practice-signup.service.ts` therefore refuses to sign anyone up under
 * `NODE_ENV=production` while this stand-in is the registered mailer. It is a
 * request-time refusal on the one endpoint, not a boot gate, for the reason
 * `config/env.ts` gives about `SESSION_SECRET`: a boot gate here would
 * crash-loop a deploy and take `/healthz` down with it, which is a worse
 * failure than one endpoint honestly returning an error.
 */

export interface EmailVerificationMessage {
  /** The address being proved. Already normalised (trimmed, lower-cased) by the service. */
  readonly to: string;
  readonly firstName: string;
  readonly practiceName: string;
  /** The signed token from `email-verification.ts`. The link is S2's to build — the origin is its concern, not this module's. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface DuplicateSignupMessage {
  readonly to: string;
}

export interface SignupMailer {
  /**
   * The mail that turns a `202` into a usable account. Failure to send must
   * THROW: a signup whose mail silently vanished is the exact state this whole
   * seam exists to make impossible.
   */
  sendEmailVerification(message: EmailVerificationMessage): Promise<void>;

  /**
   * Sent when someone signs up with an address that already has an account.
   *
   * This is not politeness, it is what makes the uninformative `202` honest.
   * The contract refuses to tell the CALLER whether the address is registered
   * (that would answer "is this person a customer of yours" for anyone who
   * asks), so the only party who may learn a signup was attempted is the
   * account holder — at the address, where they are the only one reading.
   */
  sendDuplicateSignupNotice(message: DuplicateSignupMessage): Promise<void>;
}

/**
 * // DEMO-MOCK: replaced by S2's real transport. Sends nothing; records what it
 * // was asked to send so a local developer can read the token out of the API
 * // process and finish a signup, and so tests can assert the mail was composed
 * // at all rather than trusting that it was.
 *
 * `no-console` is a lint error in this app, so this cannot print — it keeps a
 * bounded ring instead. Bounded because an unbounded record of every signup
 * that ever ran is a memory leak wearing a debugging aid's clothes, and because
 * these messages carry an address and a live token.
 */
export class RecordingSignupMailer implements SignupMailer {
  private readonly verifications: EmailVerificationMessage[] = [];
  private readonly duplicates: DuplicateSignupMessage[] = [];

  constructor(private readonly capacity: number = 20) {}

  async sendEmailVerification(message: EmailVerificationMessage): Promise<void> {
    push(this.verifications, message, this.capacity);
  }

  async sendDuplicateSignupNotice(message: DuplicateSignupMessage): Promise<void> {
    push(this.duplicates, message, this.capacity);
  }

  /** Newest last. Test and local-dev affordance only — nothing in the product reads this. */
  sentVerifications(): readonly EmailVerificationMessage[] {
    return this.verifications;
  }

  sentDuplicateNotices(): readonly DuplicateSignupMessage[] {
    return this.duplicates;
  }
}

function push<T>(into: T[], item: T, capacity: number): void {
  into.push(item);
  if (into.length > capacity) into.splice(0, into.length - capacity);
}
