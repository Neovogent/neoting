/**
 * DI tokens for the chart of accounts and the coding ladder (A6).
 *
 * Explicit symbol tokens rather than class-as-token: this app runs under
 * tsx/vitest, where emitted decorator metadata is not something to rely on
 * (`apps/api/CLAUDE.md`). Each module declares its own — reusing another
 * module's symbols would couple two modules through a provider registry.
 */
export const PRISMA = Symbol('RULES_PRISMA');
/** The per-client chart of accounts — seed, read, and the `Ledger: Account` mapping A7 needs. */
export const CHART_OF_ACCOUNTS_SERVICE = Symbol('CHART_OF_ACCOUNTS_SERVICE');
/** The authority ladder, and the `rule.create` proposal that makes the second invoice code itself. */
export const SUPPLIER_CODING_SERVICE = Symbol('SUPPLIER_CODING_SERVICE');
