import type { PrismaClient } from '@prisma/client';

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
 */
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
