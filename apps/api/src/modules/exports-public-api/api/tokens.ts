/**
 * DI tokens for the export HTTP surface (stage A9).
 *
 * Explicit symbol tokens rather than class-as-token: this app runs under
 * tsx/vitest, where emitted decorator metadata is not something to rely on
 * (`apps/api/CLAUDE.md`). Separate symbols from `links/tokens.ts` on purpose —
 * the two lanes are wired by two modules, and sharing a symbol would make the
 * export surface silently pick up whichever provider registered last.
 */
export const PRISMA = Symbol('EXPORTS_API_PRISMA');
export const DOCUMENT_STORE = Symbol('EXPORTS_API_DOCUMENT_STORE');
export const IDEMPOTENCY_STORE = Symbol('EXPORTS_API_IDEMPOTENCY_STORE');
export const EXPORTS_SERVICE = Symbol('EXPORTS_API_SERVICE');
