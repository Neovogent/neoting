import { PrismaClient } from '@prisma/client';

import { resolveAppDatabaseUrl } from '../../config/app-database-url.js';

/**
 * Re-exported so modules that only need to *name* the client type (e.g. a
 * constructor that receives it) import it from here — the one directory allowed
 * to reference `@prisma/client` — rather than tripping the `no-restricted-imports`
 * lint, whose base rule flags even `import type`.
 */
export type { PrismaClient } from '@prisma/client';

/**
 * The single application PrismaClient (Governance §5.1 — one pooled client).
 *
 * It lives here because `common/db` is the one directory allowed to name
 * `PrismaClient` (eslint `no-restricted-imports`); every other module receives
 * the client rather than constructing it. It connects as `nt_app` through
 * `DATABASE_URL`, so RLS is in force and every read must still go through
 * `scopedDb`.
 */
let client: PrismaClient | undefined;

export function getPrismaClient(): PrismaClient {
  // The URL is RESOLVED rather than left to Prisma's own `env("DATABASE_URL")`
  // lookup, because a deployed task has no `DATABASE_URL` to look up — it has
  // the host, the database and an injected `nt_app` password that only this
  // process can join (see config/app-database-url.ts). On a laptop and in CI an
  // explicit `DATABASE_URL` still wins and `url` is simply that same string.
  //
  // `undefined` means "nothing to derive", and the client is constructed exactly
  // as it was before — Prisma then reads the environment itself, so an offline
  // unit test that never queries is unaffected.
  const url = resolveAppDatabaseUrl(process.env);
  client ??= url === undefined ? new PrismaClient() : new PrismaClient({ datasources: { db: { url } } });
  return client;
}
