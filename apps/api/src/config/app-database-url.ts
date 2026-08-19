import { composePostgresUrl } from './connection-urls.js';

/**
 * The connection URL the APPLICATION connects with — as `nt_app`, never as the
 * owner.
 *
 * WHY THIS EXISTS. Exactly the gap `db/migrate-url.ts` closed for migrations,
 * one layer up. A deployed task is handed `DATABASE_HOST` / `DATABASE_PORT` /
 * `DATABASE_NAME` as plain values and the role's password as a Secrets Manager
 * injection, because §11.5 forbids a plaintext credential in a task definition
 * — while Prisma reads `DATABASE_URL`. An ECS `secrets` entry cannot be
 * interpolated into another environment variable, so something has to join them
 * at runtime, and until this file nothing did: `infra/envs/staging/services.tf`
 * carried the gap as a TODO ("app DATABASE_URL for the nt_app role"), the api
 * task shipped with no database credential at all, and every DB-backed request
 * on staging answered 500 while `/healthz` stayed green.
 *
 * ⚠ THE ROLE IN THIS URL IS LOAD-BEARING, NOT COSMETIC. `nt_app` is non-owning
 * and holds neither SUPERUSER nor BYPASSRLS, which is the precondition that
 * makes every policy in `prisma/sql/rls.sql` real (Governance §5.2,
 * `infra/envs/<env>/db-app-role.tf`). Composing this from the MIGRATOR credential
 * would "work" — and silently turn tenant isolation into decoration, because a
 * tenancy leak returns more rows rather than throwing. If a future change makes
 * this fall back to `DB_MIGRATOR_*`, that change is a security incident.
 */
export function resolveAppDatabaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  // An explicit DATABASE_URL wins, unchanged. That is the laptop (`.env`) and
  // the CI job against a throwaway Postgres — neither has the injected parts,
  // and neither should need them.
  if (env.DATABASE_URL) return env.DATABASE_URL;

  // Undefined rather than a throw: a missing part means "nothing to derive",
  // and the caller then constructs the client exactly as it did before this
  // file existed. Failing loudly here would turn every offline unit test that
  // imports the db module into a crash.
  if (!env.DATABASE_HOST || !env.DATABASE_NAME || !env.DB_APP_USER || !env.DB_APP_PASSWORD) {
    return undefined;
  }

  return composePostgresUrl({
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT ?? '5432',
    database: env.DATABASE_NAME,
    user: env.DB_APP_USER,
    password: env.DB_APP_PASSWORD,
  });
}
