import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The practice's machine actor, in one place (#17).
 *
 * Every RLS policy requires an actor and a worker has no human behind it, so
 * each practice needs a `SYSTEM` user holding a practice-level membership. The
 * shape is deliberately unusable as a login: no email, no password hash, so it
 * cannot sign in even if it leaks onto a screen, and `users.email` being the
 * unique key means a null one never collides with a real person's.
 *
 * `PRACTICE_STANDARD` rather than an admin role: the actor writes documents and
 * reads its own practice, and D44 reserves release authority for a human super
 * admin. A machine that could release would be a machine that could publish.
 */
export const SYSTEM_ACTOR_NAME = { firstName: 'Neoting', lastName: 'automation' } as const;

/**
 * Resolve the SYSTEM actor for a practice (#20) — the machine user a worker
 * writes as. It is a `UserKind.SYSTEM` user holding a practice-level membership,
 * seeded per practice, looked up by practice rather than hardcoded.
 *
 * This is the ONE query that legitimately runs WITHOUT a scope context — for the
 * same reason `scopedDb` is the one place that constructs the client: it
 * establishes the actor that `scopedDb` then requires, so it cannot itself run
 * inside one. It is safe because it reads only `users` and `memberships`, which
 * carry no RLS (they are the actor tables the policies themselves read) —
 * verified against the database, not assumed.
 *
 * Throws when a practice has no SYSTEM actor: a job for such a practice must fail
 * loudly (BullMQ retries, then DLQ) rather than write an orphaned document.
 *
 * ⚠ **Until 28 Aug 2026 only `prisma/seed.ts` ever created one**, so every
 * practice made by the real signup flow had none and this threw for all of them
 * — while every seeded demo worked. {@link createSystemActor} is now called from
 * `practice-signup.service.ts`, and `db/backfill-system-actors.ts` repairs the
 * practices that predate it.
 */
export async function createSystemActor(
  tx: Prisma.TransactionClient,
  practiceId: string,
): Promise<string> {
  const user = await tx.user.create({
    data: { kind: 'SYSTEM', ...SYSTEM_ACTOR_NAME },
    select: { id: true },
  });
  await tx.membership.create({
    data: { userId: user.id, practiceId, role: 'PRACTICE_STANDARD' },
  });
  return user.id;
}

export async function resolveSystemActor(prisma: PrismaClient, practiceId: string): Promise<string> {
  const membership = await prisma.membership.findFirst({
    where: { practiceId, user: { kind: 'SYSTEM' } },
    select: { userId: true },
  });
  if (membership === null) {
    throw new Error(`no SYSTEM actor for practice ${practiceId} — refusing to persist an orphaned document`);
  }
  return membership.userId;
}
