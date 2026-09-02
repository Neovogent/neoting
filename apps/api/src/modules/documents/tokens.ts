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

/**
 * Trash and restore (2 Sep 2026). A token of its own rather than a wider
 * `DocumentsService`: the read service still has no mutating method, and one
 * symbol per class is what keeps that readable from the module file.
 */
export const DOCUMENT_MANAGEMENT_SERVICE = Symbol('DOCUMENT_MANAGEMENT_SERVICE');
export const IDEMPOTENCY_STORE = Symbol('DOCUMENTS_IDEMPOTENCY_STORE');
