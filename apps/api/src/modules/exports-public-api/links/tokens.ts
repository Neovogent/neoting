/**
 * DI tokens for the capability-URL lane (D43, stage A8).
 *
 * Explicit symbol tokens rather than class-as-token: this app runs under
 * tsx/vitest, where emitted decorator metadata is not something to rely on
 * (`apps/api/CLAUDE.md`). Each module declares its own — reusing another
 * module's symbols would couple two modules through a provider registry.
 */
export const PRISMA = Symbol('EXPORTS_LINKS_PRISMA');
export const DOCUMENT_STORE = Symbol('EXPORTS_LINKS_DOCUMENT_STORE');
export const LINK_RATE_LIMITER = Symbol('EXPORTS_LINKS_RATE_LIMITER');
export const CAPABILITY_LINK_SERVICE = Symbol('EXPORTS_CAPABILITY_LINK_SERVICE');
export const DOCUMENT_LINK_SERVICE = Symbol('EXPORTS_DOCUMENT_LINK_SERVICE');
