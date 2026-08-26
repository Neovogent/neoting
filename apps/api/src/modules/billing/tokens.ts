/**
 * DI tokens for billing (D48, launch stage S4).
 *
 * Explicit symbol tokens rather than class-as-token: this app runs under
 * tsx/vitest, where emitted decorator metadata is not something to rely on
 * (`apps/api/CLAUDE.md`). Each module declares its own — reusing another
 * module's symbols would couple two modules through a provider registry.
 */
export const PRISMA = Symbol('BILLING_PRISMA');
export const STRIPE_CLIENT = Symbol('BILLING_STRIPE_CLIENT');
export const BILLING_SERVICE = Symbol('BILLING_SERVICE');
export const STRIPE_WEBHOOK_SERVICE = Symbol('BILLING_STRIPE_WEBHOOK_SERVICE');
export const STRIPE_EVENT_REPLAY_STORE = Symbol('BILLING_STRIPE_EVENT_REPLAY_STORE');
export const IDEMPOTENCY_STORE = Symbol('BILLING_IDEMPOTENCY_STORE');
export const CLOCK = Symbol('BILLING_CLOCK');
