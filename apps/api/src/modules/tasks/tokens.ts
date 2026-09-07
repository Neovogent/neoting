/**
 * DI tokens for the checklist and the org chart (review item 54).
 *
 * Explicit symbol tokens rather than class-as-token: this app runs under
 * tsx/vitest, where emitted decorator metadata is not something to rely on
 * (`apps/api/CLAUDE.md`). Each module declares its own.
 *
 * ⚠ `TEAMS_SERVICE` here is NOT `clients-team-settings`' `TEAM_SERVICE`. That
 * one is a CLIENT's people (`/businesses/{id}/members`); this one is the
 * FIRM's org chart (`/teams`). Living in separate modules with separate symbols
 * is what keeps two things called "team" from being injected into each other —
 * which is also why this module exists rather than these two services moving
 * into `clients-team-settings` beside a `TeamService` and a
 * `PracticeTeamService`.
 */
export const PRISMA = Symbol('TASKS_PRISMA');
export const IDEMPOTENCY_STORE = Symbol('TASKS_IDEMPOTENCY_STORE');
/** The practice's checklist — `/v1/tasks`. */
export const TASKS_SERVICE = Symbol('TASKS_SERVICE');
/** The firm's org chart — `/v1/teams`. */
export const TEAMS_SERVICE = Symbol('TEAMS_SERVICE');
