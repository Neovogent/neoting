/**
 * DI tokens. Explicit symbols because the app runs under tsx/vitest without
 * emitted decorator metadata (apps/api house pattern since #9).
 */
export const AUTH_SERVICE = Symbol('AUTH_SERVICE');
export const BUSINESSES_SERVICE = Symbol('BUSINESSES_SERVICE');
export const PRACTICE_SIGNUP_SERVICE = Symbol('PRACTICE_SIGNUP_SERVICE');
/**
 * The signup mail transport. A token rather than a direct `new` in the service
 * factory, because this is the ONE line the composition root changes when S2's
 * notifications module merges — see `signup-mailer.ts`.
 */
export const SIGNUP_MAILER = Symbol('SIGNUP_MAILER');
/**
 * The sign-in lockout (A2, `sign-in-throttle.ts`). A token rather than a `new`
 * inside the `AuthService` factory because it MUST be one instance for the whole
 * process — a throttle constructed per request counts to one for ever.
 */
export const SIGN_IN_THROTTLE = Symbol('SIGN_IN_THROTTLE');
/**
 * QR enrolment for the real second factor (A2 wrote the service,
 * `totp-enrolment.service.ts`; A14 gave it its two routes).
 *
 * A2 registered this with no controller behind it, because `openapi.yaml`
 * published no TOTP operation (G7) — the note here said the missing piece was
 * "a controller file and nothing else", and issue #195 approved the contract
 * that let it be written. `SignupChainController` is that file.
 */
export const TOTP_ENROLMENT_SERVICE = Symbol('TOTP_ENROLMENT_SERVICE');
/**
 * `POST /v1/auth/email-verification` (A14, `email-verification.service.ts`) —
 * the other half of the same gap: A1 minted the token, and until #195 nothing
 * could spend it.
 */
export const EMAIL_VERIFICATION_SERVICE = Symbol('EMAIL_VERIFICATION_SERVICE');
export const PRISMA = Symbol('AUTH_TENANCY_PRISMA');
