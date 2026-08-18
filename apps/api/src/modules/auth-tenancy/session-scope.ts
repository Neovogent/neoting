import { type ScopeContext, ScopeContextSchema } from '../../common/db/scope-context.js';
import type { PrismaClient } from '../../common/db/prisma.js';

/**
 * Verified userId → the `ScopeContext` every scoped endpoint runs under
 * (METH Stage 1, issue #118).
 *
 * ⚠ THE ONE PRIVILEGED LOOKUP ON THE REQUEST PATH. `loadScopeForUser` queries
 * `memberships` (joined to `users`) directly, NOT through `scopedDb` — it is
 * the bootstrap that PRODUCES the context every other query needs, so it cannot
 * itself run inside one. This is the same exemption, for the same reason, as
 * `common/db/resolve-system-actor.ts` (#20), and it is safe on the same
 * grounds: `users` and `memberships` carry no RLS (they are the actor tables
 * the policies themselves read — verified there against the database). Keep the
 * privileged surface to exactly this query; anything else this module reads
 * goes through `scopedDb` like everyone.
 */

interface MembershipRow {
  readonly practiceId: string | null;
  readonly businessId: string | null;
  readonly role: string;
}

/**
 * The membership a session ACTS as when a user holds several. Practice
 * membership wins — practice staff span every client via RLS's
 * practice-membership branch, and narrowing them to one business they also
 * hold a row for would silently hide the rest of their workspace. A
 * business-only user gets their first business. Deterministic (rows arrive
 * ordered by creation), shared by the resolver and `GET /me` so who-you-are
 * and what-you-see cannot disagree.
 */
export function pickActingMembership<T extends MembershipRow>(memberships: readonly T[]): T | null {
  return (
    // Practice-WIDE first: a row can carry practice AND business (the seed's
    // `mem_tom_burger` does), and picking it would narrow practice staff to one
    // client. The plain practice row is the widest thing they hold.
    memberships.find((m) => m.practiceId !== null && m.businessId === null) ??
    memberships.find((m) => m.practiceId !== null) ??
    memberships.find((m) => m.businessId !== null) ??
    null
  );
}

/** Null when the user has no active membership to act as — the resolver turns that into a 401. */
export async function loadScopeForUser(prisma: PrismaClient, userId: string): Promise<ScopeContext | null> {
  const memberships = await prisma.membership.findMany({
    // HUMAN only: a SYSTEM actor's context is minted by `systemContext()` in a
    // worker, never by a login cookie. Deactivation ends access at the next
    // request, not at cookie expiry.
    where: { userId, user: { kind: 'HUMAN', deactivatedAt: null } },
    select: { practiceId: true, businessId: true, role: true },
    orderBy: { createdAt: 'asc' },
  });

  const acting = pickActingMembership(memberships);
  if (acting === null) return null;

  // Parse, don't construct — the schema's own rules (actor present, practice or
  // business present) are the contract `scopedDb` relies on.
  return ScopeContextSchema.parse({
    actorId: userId,
    ...(acting.practiceId === null ? {} : { practiceId: acting.practiceId }),
    ...(acting.businessId === null ? {} : { businessId: acting.businessId }),
  });
}
