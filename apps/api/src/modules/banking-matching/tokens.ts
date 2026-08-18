/**
 * DI tokens for the banking read surface (METH Stage 11).
 *
 * Explicit symbol tokens rather than class-as-token, for the same reason the
 * documents module declares its own: this app runs under tsx/vitest, where
 * emitted decorator metadata is not something to rely on (`apps/api/CLAUDE.md`),
 * and reusing another module's symbols would couple two modules through a
 * provider registry.
 */
export const PRISMA = Symbol('BANKING_PRISMA');
export const BANK_TRANSACTIONS_SERVICE = Symbol('BANK_TRANSACTIONS_SERVICE');
