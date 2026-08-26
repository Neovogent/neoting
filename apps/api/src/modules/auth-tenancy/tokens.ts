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
 * QR enrolment for the real second factor (A2, `totp-enrolment.service.ts`).
 *
 * ⚠ Registered with no controller behind it, deliberately — `openapi.yaml`
 * publishes no TOTP operation (G7). Unlike `portal-upload-status.service.ts`,
 * which was left UNregistered for exactly that reason, this one is wired so the
 * missing endpoint is a controller file and nothing else, and so the wiring
 * itself is covered by the module's boot test.
 */
export const TOTP_ENROLMENT_SERVICE = Symbol('TOTP_ENROLMENT_SERVICE');
export const PRISMA = Symbol('AUTH_TENANCY_PRISMA');
