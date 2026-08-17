/**
 * DI tokens for the documents read surface (#77).
 *
 * Explicit symbol tokens rather than class-as-token: this app runs under
 * tsx/vitest, where emitted decorator metadata is not something to rely on
 * (`apps/api/CLAUDE.md`). Each module declares its own — reusing web-upload's
 * symbols would couple two modules through a provider registry.
 */
export const PRISMA = Symbol('DOCUMENTS_PRISMA');
export const DOCUMENT_STORE = Symbol('DOCUMENTS_DOCUMENT_STORE');
export const DOCUMENTS_SERVICE = Symbol('DOCUMENTS_SERVICE');
