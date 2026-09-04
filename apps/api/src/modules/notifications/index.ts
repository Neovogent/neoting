/**
 * The public seam of notifications (Boundaries, apps/api/CLAUDE.md).
 *
 * What is exported here is the whole of what other modules' code may depend on;
 * everything else in this directory is internal, and the boundary is
 * lint-enforced (`neoting/no-cross-module-internals`), not conventional.
 *
 * This is the seam **every outbound email in the product goes through**, and
 * the consumers are already named:
 *
 *  - **A1 · practice signup** and **A11 · client intake** call
 *    `sendClientInvite` when an accountant adds a client.
 *  - **A2 · the sign-in path** calls `sendSignInCode`. It passes a
 *    {@link SignInCode}, not a string — see `sign-in-code.ts` for why the type
 *    exists.
 *  - **A14 · chase by email** calls `sendDocumentRequest`. A14 is on
 *    `PLAN.md`'s cut list at hour 22; the message is composed and tested
 *    regardless, so wiring it is a call site rather than a build.
 *
 * Inject `NOTIFICATIONS_SERVICE` from `notifications.module.ts` rather than
 * constructing `NotificationsService` — the transport and the rate limiter are
 * config-selected, and a hand-built service is one that quietly ignores
 * `EMAIL_SENDER`.
 */

// The service — the one door outbound email leaves by.
export {
  NotificationsService,
  type SendBusinessPeopleInviteInput,
  type SendClientInviteInput,
  type SendContext,
  type SendDocumentRequestInput,
  type SendDuplicateSignupNoticeInput,
  type SendEmailVerificationInput,
  type SendOutcome,
  type SendSignInCodeInput,
  type SendTeamInviteInput,
} from './notifications.service.js';

// The DI tokens, so a consuming module can `imports: [NotificationsModule]` and
// `@Inject(NOTIFICATIONS_SERVICE)`.
export { NotificationsModule } from './notifications.module.js';
export { EMAIL_RATE_LIMITER, EMAIL_SENDER, NOTIFICATIONS_SERVICE } from './tokens.js';

// The credential wrapper. A caller mints the code, hashes it into
// `otp_sessions.otp_hash`, and hands the wrapper here — the value never becomes
// a bare string on the way (`sign-in-code.ts`).
export { REDACTED, SignInCode } from './sign-in-code.js';

// The address boundary. Exported so a controller can validate an address at ITS
// boundary and answer with a proper problem response, rather than letting the
// service throw on a user's typo.
export { type EmailAddress, EmailAddressSchema, parseEmailAddress } from './email-address.js';

// The legal-page links the invite and verification messages must carry
// (findings 1 and 4, 4 Sep 2026). Built by the CALLER from the app origin —
// the same split as every other link the composers take.
export { buildLegalLinks, type LegalLinks, PRIVACY_NOTICE_PATH, TERMS_OF_SERVICE_PATH } from './legal-links.js';

// The transport seam and its config selector — for the worker composition roots,
// which assemble their own graph rather than going through Nest.
export {
  DemoEmailSender,
  type DemoOutboxEntry,
  type EmailKind,
  type EmailSender,
  type OutboundEmail,
  type SentEmail,
} from './email-sender.js';
export { selectEmailRateLimiter, selectEmailSender } from './select-email-sender.js';

// The limiter seam. Exported for the same reason, and because a consumer that
// wants to answer `Retry-After` needs the verdict shape.
export {
  type EmailRateLimiter,
  InMemoryEmailRateLimiter,
  type RateLimitRequest,
  type RateLimitVerdict,
  RedisEmailRateLimiter,
} from './email-rate-limit.js';

// Composition. Pure, and exported so a Read-review surface can show the exact
// text that will send WITHOUT sending it — the same guarantee `composeChaseSms`
// gives the SMS lane.
export {
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
  SENDER_DISPLAY_NAME,
} from './email-copy.js';
