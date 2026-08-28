/* eslint-disable no-console --
 * Same reason as migrate.ts and seed.ts: a standalone process entrypoint run as
 * a one-off `ecs run-task` container with no Nest context and therefore no
 * injected Logger. Its stdout/stderr ARE the interface — the awslogs driver
 * ships them to /nt/<env>/migrate, which is what an operator tails.
 */
import { getPrismaClient } from '../common/db/prisma.js';
import { createSystemActor, SYSTEM_ACTOR_NAME } from '../common/db/resolve-system-actor.js';

/**
 * Give every practice the SYSTEM actor it should have been created with (#17).
 *
 * ⚠ **This repairs a real outage, not a tidiness gap.** Until 28 Aug 2026 the
 * only thing that ever created a `SYSTEM` user was `prisma/seed.ts`, so a
 * practice born through `POST /v1/practices` had none — and everything with no
 * human behind it resolves one per practice. `resolveSystemActor` THROWS in that
 * state, so for a real signed-up firm the ingest and extract workers, the chase
 * portal's session lookup and the capability-link resolver were all dead, and
 * `POST /v1/portal/sign-in-codes` answered its uniform `202` while sending
 * nothing. `practice-signup.service.ts` now creates one; this is for the
 * practices that predate that.
 *
 * **Idempotent, and safe to run against a live database.** It creates nothing
 * for a practice that already has one, and it only ever INSERTS — no practice,
 * user or membership is modified or deleted, so a second run is a no-op and a
 * concurrent signup cannot lose a row to it.
 *
 * **Unscoped on purpose, and it is the one thing here that could be a tenancy
 * hole if it read anything else.** `users` and `memberships` carry no RLS (they
 * are the actor tables the policies themselves read), and `practices` is not a
 * tenant table — it is the tenant. Nothing tenant-scoped is touched: this reads
 * practice ids and writes actors, and never sees a document, a chase or a
 * business. Run it the way the seed is run — as a command override on the
 * migrate task family, `docs/runbooks/staging-demo.md` §3.
 *
 * **How it is invoked** — a command override on the **api** task family, not the
 * migrate one:
 *
 * ```
 * aws ecs run-task --cluster nt-staging
 *   --task-definition nt-staging-api
 *   --overrides '{"containerOverrides":[{"name":"api",
 *                  "command":["node","apps/api/dist/db/backfill-system-actors.js"]}]}' ...
 * ```
 *
 * ⚠ **The api family, deliberately, because this needs no elevated
 * privilege.** `migrate` carries the schema owner — the only credential that can
 * TRUNCATE — and its siblings here use it because DDL and `prisma db seed` need
 * it. This inserts two ordinary rows through the same `nt_app` role the running
 * API uses, so borrowing the owner would be taking a credential to do a job that
 * does not want one.
 *
 * Unlike the seed it truncates nothing and needs no `assertSeedableEnvironment`
 * guard: it is additive, so it is safe in an environment holding real data,
 * which is the whole point of having it.
 */
async function main(): Promise<void> {
  // The app's own pooled client, composing the `nt_app` URL out of the same
  // DATABASE_HOST/PORT/NAME + DB_APP_PASSWORD the API task already receives
  // (`config/app-database-url.ts`). Reaching for `PrismaClient` here would break
  // R6 for no gain — `common/db` is the only directory allowed to name it, and
  // `db/app-role.ts` states plainly that these entrypoints are not an exception.
  const prisma = getPrismaClient();

  try {
    // One query, not a per-practice probe: a practice with no membership whose
    // user is SYSTEM. `some` + `none` is the shape Prisma turns into a NOT
    // EXISTS, so this stays one round trip however many practices there are.
    const orphans = await prisma.practice.findMany({
      where: { memberships: { none: { user: { kind: 'SYSTEM' } } } },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });

    if (orphans.length === 0) {
      console.log('backfill-system-actors: every practice already has one — nothing to do');
      return;
    }

    console.log(`backfill-system-actors: ${orphans.length} practice(s) without a SYSTEM actor`);

    for (const practice of orphans) {
      // Each in its own transaction. One practice failing must not roll back the
      // repairs already made for the others — a partial repair is strictly
      // better than none, and re-running finishes the job.
      const userId = await prisma.$transaction((tx) => createSystemActor(tx, practice.id));
      // The practice NAME, never anything under it. §11: this log is about the
      // tenant's existence, which the operator running a backfill already knows.
      console.log(`  ${practice.id} (${practice.name}) → ${userId}`);
    }

    console.log(`backfill-system-actors: done, ${orphans.length} created (${SYSTEM_ACTOR_NAME.firstName} ${SYSTEM_ACTOR_NAME.lastName})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('backfill-system-actors FAILED', error);
  process.exitCode = 1;
});
