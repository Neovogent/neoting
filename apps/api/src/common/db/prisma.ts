import { PrismaClient } from '@prisma/client';

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
  client ??= new PrismaClient();
  return client;
}
