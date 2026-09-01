import type { NotificationsService } from '../notifications/index.js';

import type {
  DuplicateSignupMessage,
  EmailVerificationMessage,
  SignupMailer,
} from './signup-mailer.js';

/**
 * The real signup mailer — **the one line A1 left for S2, finally connected.**
 *
 * A1 built {@link SignupMailer} as a seam and shipped `RecordingSignupMailer`
 * behind it, which sends nothing. S2 then built the whole email transport and
 * merged, but **nothing ever swapped the provider**, so `POST /v1/practices`
 * kept refusing under `NODE_ENV=production` — which is what staging runs. The
 * effect was that signup was dead on the launch target, and A14's
 * `POST /v1/auth/email-verification` had no mail to consume, so the chain could
 * not be walked end to end.
 *
 * This class is the whole of the fix on this side of the seam: it translates
 * A1's two messages into the notifications module's two, and holds the public
 * web origin so that neither module has to know about the other's concerns.
 *
 * ⚠ **A refusal is a failure here, not an outcome.** `NotificationsService`
 * answers with a {@link SendOutcome} rather than throwing, because a sign-in
 * endpoint must respond identically whether an address is known, unknown or
 * rate-limited — anything else is an account-enumeration oracle. Signup is the
 * opposite case: a practice whose verification mail never left is an account
 * that can never become usable, and `practice-signup.service.ts` requires this
 * method to THROW so it can refuse the signup rather than answer `202` for an
 * account nobody can reach. So a `sent: false` is converted into a throw here,
 * deliberately, at the one place the two contracts meet.
 */
export class NotificationsSignupMailer implements SignupMailer {
  constructor(
    private readonly notifications: NotificationsService,
    /**
     * The public web origin the verification link points at.
     *
     * ⚠ A constant at the composition root, for the reason `setup-link.ts`
     * gives at length: `config/env.ts` carries no `APP_ORIGIN` key, and adding
     * one is a `config/` change. It is a constructor parameter rather than a
     * literal so promoting it to an environment variable is one line in
     * `auth-tenancy.module.ts` and touches nothing else.
     */
    private readonly appOrigin: string,
  ) {}

  async sendEmailVerification(message: EmailVerificationMessage): Promise<void> {
    const outcome = await this.notifications.sendEmailVerification({
      to: message.to,
      firstName: message.firstName,
      practiceName: message.practiceName,
      verifyLink: buildVerificationLink(this.appOrigin, message.token),
      expiresAt: message.expiresAt,
    });

    if (!outcome.sent) {
      // The rate limit is per address, so this is a real signal rather than
      // noise: several signups against one address in an hour is either a typo
      // being retried or someone probing. Either way the honest answer is that
      // this signup did not happen.
      throw new Error(
        `The verification email for this signup was not sent (${outcome.reason}). No account may be created without it.`,
      );
    }
  }

  async sendDuplicateSignupNotice(message: DuplicateSignupMessage): Promise<void> {
    // Deliberately NOT thrown on. This notice is a courtesy to the account
    // holder; the signup it answers is already refused either way, and turning
    // a rate-limited courtesy into a 500 would tell the caller that the address
    // exists — the exact leak the uninformative 202 is built to prevent.
    await this.notifications.sendDuplicateSignupNotice({ to: message.to });
  }
}

/** `<origin>/app/verify-email?token=<token>` — the whole of the link. */
export function buildVerificationLink(appOrigin: string, token: string): string {
  const origin = appOrigin.endsWith('/') ? appOrigin.slice(0, -1) : appOrigin;
  return `${origin}${VERIFY_EMAIL_PATH}?token=${encodeURIComponent(token)}`;
}

/**
 * ⚠ **THIS MUST MATCH M9'S ROUTE, AND ONCE IT DID NOT.**
 *
 * It was `/app/verify-email`, chosen here before M9 merged, with a note saying
 * M9 must serve a screen at it. M9 merged 48 minutes later serving
 * `/signup/verify` instead, and nothing failed: `apps/web` is a single-page app,
 * so the wrong path still answered **200** with the app shell. The token was
 * simply dropped on the floor, every verification link in every signup email was
 * inert, and the first person through the flow could not verify, could not
 * enrol, and therefore could not sign in — with no error anywhere to say why.
 *
 * A path agreed in a comment between two stages is not agreement. If this ever
 * moves again, the honest fix is a route the API can assert against, not another
 * note. Until then, `notifications-signup-mailer.test.ts` reads M9’s own source and
 * fails if the two halves drift.
 */
export const VERIFY_EMAIL_PATH = '/signup/verify';

/** `<origin>/signup/reset?token=<token>` — the forgotten-password mail's whole link. */
export function buildPasswordResetLink(appOrigin: string, token: string): string {
  const origin = appOrigin.endsWith('/') ? appOrigin.slice(0, -1) : appOrigin;
  return `${origin}${RESET_PASSWORD_PATH}?token=${encodeURIComponent(token)}`;
}

/**
 * ⚠ The SAME drift trap as `VERIFY_EMAIL_PATH` above — an SPA answers a wrong
 * route with a 200 and drops the token on the floor. The web half serves this
 * under the signup view family; `notifications-signup-mailer.test.ts` pins the
 * pair the same way it pins the verify path.
 */
export const RESET_PASSWORD_PATH = '/signup/reset';
