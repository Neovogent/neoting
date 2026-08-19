/* eslint-disable no-console --
 * Standalone process entrypoint, like migrate.ts and seed.ts: a one-off
 * `ecs run-task` container with no Nest context and therefore no injected
 * Logger. Its stdout IS the interface — awslogs ships it to /nt/<env>/migrate.
 */
import { spawnSync } from 'node:child_process';

import { redactUrl } from '../config/connection-urls.js';
import { resolveMigrationUrl } from './migrate-url.js';
import { buildAppRoleSql } from './app-role-sql.js';

/**
 * Create (or repair) the non-owning `nt_app` role a deployed database needs.
 *
 * WHY THIS EXISTS. `infra/envs/<env>/db-app-role.tf` generates the password,
 * puts it in Secrets Manager, injects it into the migrate task as
 * `DB_APP_ROLE_PASSWORD` and says "this file provides the secret, and the
 * migration step consumes it". **No migration step ever consumed it.**
 * `migrate.ts` runs `prisma migrate deploy` and nothing else,
 * `prisma/sql/app-role.sql` is documented local-development-only with a
 * hardcoded laptop password, and the role therefore did not exist in staging at
 * all — which is exactly what db-app-role.tf predicted on 13 Aug, and nothing
 * closed it.
 *
 * The consequence was invisible until the application was first given a working
 * session: `/healthz` needs no database and the demo login reads an in-file
 * credential map, so staging looked healthy while every DB-backed request
 * answered 500.
 *
 * RUN IT as a command override on the migrate task definition — the one place
 * the schema owner's credential exists, and it exists there for seconds:
 *
 *   --overrides '{"containerOverrides":[{"name":"migrate",
 *                  "command":["node","apps/api/dist/db/app-role.js"]}]}'
 *
 * Idempotent, so re-running is harmless and is the repair path after a
 * migration adds tables.
 *
 * THE PRISMA CLI, NOT PrismaClient, and not by preference: `common/db` is the
 * only directory allowed to name `PrismaClient` (eslint `no-restricted-imports`,
 * R6), because an unscoped client is a tenancy leak that fails silently. That
 * rule is right and this file is not an exception to it — the sibling
 * entrypoints already shell out to the same CLI for the same reason.
 *
 * The URL travels as `DATABASE_URL` in the child's environment rather than as
 * `--url` on argv: an argv password is readable from `ps` by anything else in
 * the task, and there is no reason to put it there.
 */
function main(): never {
  const password = process.env.DB_APP_ROLE_PASSWORD;
  const user = process.env.DB_APP_USER ?? 'nt_app';

  if (!password) {
    console.error('[app-role] DB_APP_ROLE_PASSWORD is not set. It is injected by the migrate task definition.');
    process.exit(1);
  }

  let sql: string;
  try {
    sql = buildAppRoleSql(user, password);
  } catch (error) {
    console.error(`[app-role] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const url = resolveMigrationUrl(process.env);
  console.log(`[app-role] ensuring role ${user} -> ${redactUrl(url)}`);

  // The OWNER connection: creating a role and granting on every table is
  // precisely what the migrator credential is for, and precisely what `nt_app`
  // must never be able to do.
  const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url };

  const result = spawnSync('pnpm', ['prisma', 'db', 'execute', '--schema', 'prisma/schema.prisma', '--stdin'], {
    env,
    input: sql,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: false,
  });

  if (result.error) {
    console.error(`[app-role] failed to start prisma: ${result.error.message}`);
    process.exit(1);
  }

  // A signal death has a null status. Exiting 0 there would report a half-run
  // grant script as a success.
  if (result.status === null) {
    console.error(`[app-role] prisma terminated by signal ${result.signal ?? 'unknown'}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`[app-role] prisma db execute exited ${result.status}`);
    process.exit(result.status);
  }

  console.log(`[app-role] ${user} ready — NOSUPERUSER, NOBYPASSRLS, granted on public.`);
  process.exit(0);
}

main();
