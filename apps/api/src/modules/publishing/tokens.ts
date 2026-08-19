/**
 * DI tokens for publishing (METH Stage 10).
 *
 * Explicit symbol tokens rather than class-as-token: this app runs under
 * tsx/vitest, where emitted decorator metadata is not something to rely on
 * (`apps/api/CLAUDE.md`). Each module declares its own — reusing another
 * module's symbols would couple two modules through a provider registry.
 */
export const LEDGER_ADAPTER = Symbol('PUBLISHING_LEDGER_ADAPTER');

/** The shared pooled Prisma client, RECEIVED by the read service, never constructed inside it (Governance §5.1). */
export const PRISMA = Symbol('PUBLISHING_PRISMA');

/** `GET /v1/publishes` — the read surface's one service. */
export const PUBLISHES_SERVICE = Symbol('PUBLISHING_PUBLISHES_SERVICE');
