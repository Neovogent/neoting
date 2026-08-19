/* eslint-disable no-console --
 * Same reason as migrate.ts: this is a standalone process entrypoint run as a
 * one-off `ecs run-task` container with no Nest context and therefore no
 * injected Logger. Its stdout/stderr ARE the interface — the awslogs driver
 * ships them to /nt/<env>/migrate, which is what an operator tails.
 */
import { spawnSync } from 'node:child_process';

import { redactUrl } from '../config/connection-urls.js';
import { resolveMigrationUrl } from './migrate-url.js';
import { assertSeedableEnvironment } from './seed-environment.js';

/**
 * The seed entrypoint — `prisma db seed` with a composed connection URL.
 *
 * WHY THIS EXISTS (METH Stage 15). Staging could be migrated but never seeded.
 * `migrate.ts` closed exactly this gap for migrations: the task definition is
 * handed `DATABASE_HOST`/`PORT`/`NAME` as plain values and
 * `DB_MIGRATOR_USER`/`PASSWORD` as Secrets Manager injections (§11.5 forbids a
 * plaintext credential in a task definition), Prisma reads `DATABASE_URL` and
 * `DIRECT_URL`, and ECS cannot interpolate one environment variable into
 * another — so something has to join them at runtime. The seed needs the same
 * join and had nothing doing it. `scripts/demo/reset.ts` already names this the
 * intended shape: "the real environment reset is terraform/ecs run-task against
 * staging; this is the laptop stand-in".
 *
 * HOW IT IS INVOKED. No task definition of its own — it is a command override
 * on the migrate family, which already carries the only credential that can
 * TRUNCATE (the schema owner) and exists for the seconds it runs:
 *
 *   aws ecs run-task --cluster nt-staging \
 *     --task-definition nt-staging-migrate \
 *     --overrides '{"containerOverrides":[{"name":"migrate",
 *                    "command":["node","apps/api/dist/db/seed.js"]}]}' ...
 *
 * See docs/runbooks/staging-demo-seed.md for the full command and its checks.
 *
 * ⚠ THIS TRUNCATES EVERY TABLE. `prisma/seed.ts` opens with
 * `TRUNCATE ... RESTART IDENTITY CASCADE` — which is what makes it re-runnable,
 * and what makes `assertSeedableEnvironment` the most important line here.
 */
function main(): never {
  // FIRST, before anything composes a URL or relaxes NODE_ENV below.
  //
  // Caught and printed rather than thrown: a refusal is the guard WORKING, and
  // an operator scanning CloudWatch should read one line saying so, not a
  // twelve-frame stack that looks like the image is broken.
  let environment: string;
  try {
    environment = assertSeedableEnvironment(process.env);
  } catch (error) {
    console.error(`[seed] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const url = resolveMigrationUrl(process.env);

  // DIRECT_URL is the same credential, and that is correct — prisma/seed.ts
  // connects on DIRECT_URL precisely so it seeds as the OWNER rather than as
  // `nt_app`, whose RLS policies would let it insert a handful of rows and then
  // silently read back nothing. migrate.ts carries the same note.
  //
  // NODE_ENV is relaxed to `development` for the CHILD ONLY, and only after the
  // assertion above. seed-environment.ts explains why the guard it defeats is a
  // proxy for the check we just made properly; without this the seed throws
  // "must never run against production" against a staging database whose data
  // is synthetic by construction (G2).
  const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url, NODE_ENV: 'development' };

  // Redacted, so CloudWatch shows WHICH database was truncated without the
  // password landing in a 30-day log group (Gov §12.2).
  console.log(`[seed] NEOTING_ENV=${environment} — prisma db seed -> ${redactUrl(url)}`);
  console.log('[seed] this TRUNCATEs every table before it writes.');

  // WORKDIR is the repo root in the runtime image, which is what makes
  // `pnpm prisma` resolve the schema AND the `prisma.seed` command through the
  // root package.json. Running this from apps/api fails with "Could not find a
  // schema". The image ships devDependencies (apps/api/Dockerfile says why), so
  // tsx — which `prisma.seed` invokes — is present.
  const result = spawnSync('pnpm', ['prisma', 'db', 'seed'], { env, stdio: 'inherit', shell: false });

  if (result.error) {
    console.error(`[seed] failed to start prisma: ${result.error.message}`);
    process.exit(1);
  }

  // A signal death has a null status. Exiting 0 there would report a seed that
  // was killed part-way — after the TRUNCATE — as a success, which is the one
  // lie this process must never tell.
  if (result.status === null) {
    console.error(`[seed] prisma terminated by signal ${result.signal ?? 'unknown'}`);
    process.exit(1);
  }

  process.exit(result.status);
}

main();
