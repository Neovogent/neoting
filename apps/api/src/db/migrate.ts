/* eslint-disable no-console --
 * This is a standalone process entrypoint, not application code. It runs as a
 * one-off `ecs run-task` container with no Nest context and therefore no
 * injected Logger, and its stdout/stderr ARE the interface: the awslogs driver
 * ships them to /nt/<env>/migrate, which is what the deploy job tails when a
 * migration fails. Reaching for the Nest Logger here would mean bootstrapping a
 * DI container to print three lines.
 */
import { spawnSync } from 'node:child_process';

import { redactUrl } from '../config/connection-urls.js';
import { resolveMigrationUrl } from './migrate-url.js';

/**
 * The migration entrypoint — `prisma migrate deploy` with a composed
 * connection URL.
 *
 * WHY THIS WRAPPER EXISTS. The migrate task definition is handed
 * `DATABASE_HOST` / `DATABASE_PORT` / `DATABASE_NAME` as plain environment
 * values and `DB_MIGRATOR_USER` / `DB_MIGRATOR_PASSWORD` as Secrets Manager
 * injections, because §11.5 forbids a plaintext credential in a task
 * definition. Prisma reads `DATABASE_URL` and `DIRECT_URL`
 * (prisma/schema.prisma). ECS cannot interpolate one environment variable into
 * another, so something has to join them at runtime — and it cannot be
 * `config/env.ts`, because `prisma migrate deploy` is a CLI invocation that
 * never loads application code.
 *
 * That gap is why the staging deploy shipped with NO MIGRATION STEP at all
 * (.github/workflows/check.yml, stage 9). This closes it.
 *
 * Governance §1.3: `migrate deploy` is the ONLY migration command that runs
 * anywhere but a developer laptop. This file must never grow a `migrate dev`
 * branch — that command is interactive, it can DROP the database to resolve
 * drift, and it hangs in a non-interactive shell rather than failing.
 */

function main(): never {
  const url = resolveMigrationUrl(process.env);

  // ⚠ DIRECT_URL IS THE SAME CREDENTIAL HERE, AND THAT IS CORRECT.
  // schema.prisma splits them so the APPLICATION connects as the non-owning
  // `nt_app` role while migrations connect as the owner. This process IS the
  // migration: it legitimately needs to cross every tenant boundary, and it is
  // the only thing that should. The split is enforced by which credential each
  // task definition receives, not by which variable name is used — the app's
  // task definition never sees DB_MIGRATOR_*.
  const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url };

  // Redacted, so an operator reading CloudWatch can confirm WHICH database was
  // migrated without the password landing in the log.
  console.log(`[migrate] prisma migrate deploy -> ${redactUrl(url)}`);

  // WORKDIR is the repo root in the runtime image, which is what makes
  // `pnpm prisma` resolve the schema through the root package.json `prisma.schema`
  // key. Running this from apps/api instead fails with "Could not find a schema".
  const result = spawnSync('pnpm', ['prisma', 'migrate', 'deploy'], { env, stdio: 'inherit', shell: false });

  if (result.error) {
    console.error(`[migrate] failed to start prisma: ${result.error.message}`);
    process.exit(1);
  }

  // A signal death has a null status. Exiting 0 there would tell the deploy
  // pipeline the migration succeeded when it was killed — the one lie this
  // process must never tell.
  if (result.status === null) {
    console.error(`[migrate] prisma terminated by signal ${result.signal ?? 'unknown'}`);
    process.exit(1);
  }

  process.exit(result.status);
}

main();
