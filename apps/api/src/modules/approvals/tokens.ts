/**
 * DI tokens (explicit `@Inject` — decorator metadata is not emitted under
 * tsx/vitest; the house pattern since #9).
 *
 * Deliberately ABSENT: a token for the executor registry or the dedupe
 * detector. Both are built inside `approvals.module.ts`'s `useFactory` and
 * handed to the service as constructor arguments — the S1 half of the #81
 * promise: no executor is reachable from a controller, because nothing
 * injectable ever names one.
 */
export const PRISMA = Symbol('approvals:prisma');
export const ACTION_PROPOSALS_SERVICE = Symbol('approvals:action-proposals-service');
