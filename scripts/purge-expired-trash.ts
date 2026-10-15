/* eslint-disable no-console --
 * Same reason as migrate.ts, seed.ts, the two backfills and
 * cleanup-duplicate-proposals.ts: a standalone process entrypoint with no Nest
 * context and therefore no injected Logger. Its stdout IS the interface.
 */
import { getPrismaClient } from '../apps/api/src/common/db/prisma.js';
import { purgeExpiredTrash } from '../apps/api/src/worker/trash-purge.js';

/**
 * The operator's manual door onto the retention sweep (review item 61).
 *
 * The sweep itself — and its Governance §10.5 argument — lives in
 * `apps/api/src/worker/trash-purge.ts`, which the worker now runs DAILY as a
 * scheduled job (rush/chase-scheduler). This CLI is for looking before that
 * happens, and is `--dry-run` by default so an accidental invocation destroys
 * nothing.
 *
 * ```bash
 * pnpm trash:purge            # dry run: prints what WOULD go
 * pnpm trash:purge --apply    # actually purges
 * ```
 */
async function main(): Promise<void> {
  const prisma = getPrismaClient();
  try {
    await purgeExpiredTrash(prisma, { apply: process.argv.includes('--apply'), log: (line) => console.log(line) });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`\npurge-expired-trash failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
