/**
 * DI tokens for client intake and team management (A11).
 *
 * Explicit symbol tokens rather than class-as-token: this app runs under
 * tsx/vitest, where emitted decorator metadata is not something to rely on
 * (`apps/api/CLAUDE.md`). Each module declares its own — reusing another
 * module's symbols would couple two modules through a provider registry.
 */
export const PRISMA = Symbol('CLIENTS_PRISMA');
export const IDEMPOTENCY_STORE = Symbol('CLIENTS_IDEMPOTENCY_STORE');
/** Client intake — `POST /v1/businesses`, and A6's read of the business-type profile. */
export const CLIENT_INTAKE_SERVICE = Symbol('CLIENT_INTAKE_SERVICE');
/** Team management — `GET`/`POST /v1/businesses/{businessId}/members`. */
export const TEAM_SERVICE = Symbol('TEAM_SERVICE');
/**
 * The PRACTICE's own team — `GET`/`POST /v1/practice-members`. A second token
 * rather than a second method on `TEAM_SERVICE`, because the two surfaces have
 * different tenancy boundaries and `practice-team.service.ts`'s header explains
 * why sharing one class would make one of the two arguments quietly untrue.
 */
export const PRACTICE_TEAM_SERVICE = Symbol('PRACTICE_TEAM_SERVICE');
