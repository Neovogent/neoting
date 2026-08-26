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
export const PRISMA = Symbol('AUTH_TENANCY_PRISMA');
