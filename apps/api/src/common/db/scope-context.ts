import { z } from 'zod';

/**
 * The request context every policed query runs under (Governance §5.2).
 *
 * These five values are not decoration: `prisma/sql/rls.sql` reads each of them
 * through `current_setting()`, and they are the entire input to every tenancy
 * decision the database makes. Getting one wrong does not throw — it silently
 * widens or narrows what a user can see, which is why this is parsed rather
 * than trusted, at the one place it enters the system.
 */
export const SessionScope = z.enum(['user', 'delegated_upload']);
export type SessionScope = z.infer<typeof SessionScope>;

export const ScopeContextSchema = z
  .object({
    /**
     * Who is acting. Required, always — every policy branch begins with
     * `app_actor_id() IS NOT NULL`, so a missing actor does not fail open, it
     * fails to an empty result set. That is the safe direction, but an empty
     * result set from a *bug* is indistinguishable from an empty result set
     * from a legitimately empty workspace, so we refuse it here instead of
     * letting the caller debug a screen that renders nothing.
     *
     * For machine work this is a SYSTEM user (see `systemContext`).
     */
    actorId: z.string().min(1),

    /** The practice in scope, when the actor is practice staff. */
    practiceId: z.string().min(1).optional(),

    /** The single business in scope, when the actor is inside one workspace. */
    businessId: z.string().min(1).optional(),

    sessionScope: SessionScope.default('user'),

    /**
     * The exact item ids a delegated OTP link may touch. The chase link is
     * deliberately forwardable (SoT Stage 8.3), so this list is the only thing
     * standing between "whoever holds the link" and the rest of the workspace.
     *
     * Ids are joined with commas into a single GUC, so a comma inside one would
     * silently split it into two grants. Rejected here rather than escaped:
     * every id in this system is a cuid, and a cuid never contains a comma, so
     * an id that does is a bug or an attack and neither deserves a best effort.
     */
    grantedItemIds: z
      .array(z.string().min(1).refine((id) => !id.includes(','), { message: 'item id must not contain a comma' }))
      .default([]),
  })
  .strict()
  .refine((ctx) => ctx.sessionScope !== 'delegated_upload' || ctx.grantedItemIds.length > 0, {
    message: 'a delegated_upload context must grant at least one item — an empty grant reads as "no restriction" to a reviewer but denies everything in SQL',
  })
  .refine((ctx) => ctx.practiceId !== undefined || ctx.businessId !== undefined, {
    message: 'a scope context needs a practice, a business, or both — neither means every policy branch fails and the caller sees an empty database',
  });

export type ScopeContext = z.infer<typeof ScopeContextSchema>;

/**
 * The context a background worker runs under.
 *
 * A queue job has no human behind it, but every policy requires an actor, so
 * machine writes need one or they cannot happen (issue #17). The actor is a
 * `UserKind.SYSTEM` user holding a practice-level membership — which means
 * machine writes go through the *same* predicate as human ones rather than a
 * privileged side door, and `audit_events.actor_id` names a real row.
 *
 * Note what this deliberately does NOT do: it takes no `businessId`. A worker
 * processing an inbound document does not yet know whose it is — that is the
 * whole reason UNROUTED exists — and a worker that guessed would be writing
 * one client's document into another's workspace.
 */
export function systemContext(practiceId: string, systemUserId: string): ScopeContext {
  return ScopeContextSchema.parse({
    actorId: systemUserId,
    practiceId,
    sessionScope: 'user',
  });
}
