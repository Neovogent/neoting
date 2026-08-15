import { composePostgresUrl } from '../config/connection-urls.js';

/**
 * Resolve the connection URL `prisma migrate deploy` should run against.
 *
 * Separated from `migrate.ts` purely so it can be tested: that module spawns a
 * process and calls `process.exit` at import time, so a test importing it would
 * run a migration. A pure function and a thin entrypoint is the cheapest way to
 * keep the interesting half under test.
 */

const REQUIRED = ['DATABASE_HOST', 'DATABASE_NAME', 'DB_MIGRATOR_USER', 'DB_MIGRATOR_PASSWORD'] as const;

export function resolveMigrationUrl(env: NodeJS.ProcessEnv): string {
  // An explicit DATABASE_URL wins, unchanged. That is how this runs on a laptop
  // and in the CI job that migrates a throwaway Postgres — neither has the
  // injected parts, and neither should need them.
  if (env.DATABASE_URL) return env.DATABASE_URL;

  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length > 0) {
    // Names only, never values — this runs in a log group with 30-day
    // retention (Gov §12.2).
    throw new Error(
      `Cannot compose DATABASE_URL: missing ${missing.join(', ')}. ` +
        'Set DATABASE_URL directly, or supply the injected parts (see infra/envs/*/services.tf).',
    );
  }

  return composePostgresUrl({
    host: env.DATABASE_HOST!,
    port: env.DATABASE_PORT ?? '5432',
    database: env.DATABASE_NAME!,
    user: env.DB_MIGRATOR_USER!,
    password: env.DB_MIGRATOR_PASSWORD!,
  });
}
