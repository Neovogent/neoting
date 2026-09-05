/* eslint-disable no-console --
 * Same reason as migrate.ts, seed.ts and the two backfills beside this one: a
 * standalone process entrypoint run as a one-off container with no Nest context
 * and therefore no injected Logger. Its stdout/stderr ARE the interface.
 */
import { getPrismaClient } from '../common/db/prisma.js';
import { resolveSystemActor } from '../common/db/resolve-system-actor.js';
import { systemContext } from '../common/db/scope-context.js';
import { scopedDb } from '../common/db/scoped-db.js';
import { isChaseSuppressed } from '../modules/chase/index.js';

/**
 * Give every bank transaction the suppression verdict statement ingest should
 * have written it with.
 *
 * ## ⚠ Why this is needed and not optional
 *
 * `statement-ingest.ts` wrote a literal `chaseSuppressed: false` on every row
 * from the day it shipped until 5 Sep 2026 — and under D40 that lane is the
 * ONLY writer of bank rows outside `prisma/seed.ts`. So on real data no line
 * was ever suppressed: measured on staging, one client held 631 settlement
 * CREDITS (Worldpay, Just Eat) all `chase_suppressed: false`, every one of
 * them counted "unexplained" and offered to the chase composer as a receipt
 * to ask the client for. The ingest fix stops new rows arriving wrong; this
 * repairs the rows that already exist, with the SAME rule:
 *
 * - a CREDIT (`amount_pence > 0` — money in) has no purchase receipt in
 *   existence to chase;
 * - a descriptor line (`isChaseSuppressed` — the SoT Stage 7 list, imported
 *   from the chase seam exactly as the ingest imports it) has none either.
 *
 * ## Idempotent, and it only ever flips FALSE → TRUE
 *
 * A row already `true` is never touched: the seed writes `true` by the same
 * descriptor rule, and a future per-client override must not be un-set by a
 * maintenance job re-deriving the base rule. A second run is a no-op.
 *
 * ## Reversal, honestly stated
 *
 * Before this runs, the only writers of `true` were `prisma/seed.ts`
 * (descriptor-derived, so re-derivable) and nothing else — the ingest always
 * wrote `false`. So this pass is undone by re-applying the inverse of the same
 * rule; there is no hidden prior state to restore. It writes ONE column; no
 * row is created, deleted, or otherwise modified. Suppression gates CHASING
 * and the unexplained counts only — a suppressed line still lists on the Bank
 * screen, still matches, still reconciles.
 *
 * ## How it is invoked
 *
 * The **api** task family, like the other backfills: ordinary rows through the
 * `nt_app` role, no elevated privilege.
 *
 * ```
 * aws ecs run-task --cluster nt-staging
 *   --task-definition nt-staging-api
 *   --overrides '{"containerOverrides":[{"name":"api",
 *                  "command":["node","apps/api/dist/db/backfill-chase-suppression.js"]}]}' ...
 * ```
 *
 * ## ⚠ It runs PRACTICE BY PRACTICE, through `scopedDb`, and it has to
 *
 * `bank_transactions` is in the `direct_tables` RLS loop with FORCE ROW LEVEL
 * SECURITY, so a query with no GUCs set matches no rows and returns an empty
 * list — indistinguishable from a finished job (the trap
 * `backfill-import-fingerprints.ts` documents; it bit that script's first
 * draft). Each practice's SYSTEM actor is resolved and every read and write
 * happens inside `scopedDb`, through exactly the predicate a human's query
 * goes through.
 */

/** Rows per read. Big enough to be few round trips, small enough to hold. */
const PAGE = 1_000;

interface Row {
  readonly id: string;
  readonly amountPence: number;
  readonly descriptionRaw: string;
  readonly chaseSuppressed: boolean;
}

async function backfillPractice(
  prisma: ReturnType<typeof getPrismaClient>,
  practiceId: string,
  systemUserId: string,
): Promise<number> {
  const ctx = systemContext(practiceId, systemUserId);
  let flipped = 0;
  let cursor: string | undefined;

  for (;;) {
    // ⚠ The page is read over EVERY row, not over `chaseSuppressed: false`.
    //
    // Filtering on the column this loop WRITES is the fingerprint backfill's
    // documented cursor trap: Prisma locates a cursor by finding that row
    // inside the same filtered query, so flipping a page's last row would
    // remove it from the next page's result set and the cursor would stop
    // resolving. Already-true rows are skipped in memory instead.
    const rows: Row[] = await scopedDb(prisma, ctx, (db) =>
      db.bankTransaction.findMany({
        select: { id: true, amountPence: true, descriptionRaw: true, chaseSuppressed: true },
        orderBy: [{ id: 'asc' }],
        take: PAGE,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      }),
    );
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]?.id;

    // The SAME rule the ingest lane now applies. Re-implementing it here — or
    // in SQL — is how a backfilled row and a freshly imported one end up with
    // different verdicts for one descriptor, silently.
    const toFlip = rows
      .filter((row) => !row.chaseSuppressed && (row.amountPence > 0 || isChaseSuppressed(row.descriptionRaw)))
      .map((row) => row.id);
    if (toFlip.length === 0) continue;

    const written = await scopedDb(prisma, ctx, (db) =>
      db.bankTransaction.updateMany({
        // `chaseSuppressed: false` in the WHERE as well as the page filter, so
        // a row flipped by a concurrent run is a no-op, never a double count.
        where: { id: { in: toFlip }, chaseSuppressed: false },
        data: { chaseSuppressed: true },
      }),
    );
    flipped += written.count;
  }

  return flipped;
}

async function main(): Promise<void> {
  const prisma = getPrismaClient();
  const startedAt = new Date();

  try {
    // `practices` carries no RLS — it is the tenant, not tenant-owned — so this
    // one read needs no context. Everything below it does.
    const practices = await prisma.practice.findMany({
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`backfill-chase-suppression: ${practices.length} practice(s) to sweep`);

    let total = 0;
    const skipped: string[] = [];

    for (const practice of practices) {
      let systemUserId: string;
      try {
        systemUserId = await resolveSystemActor(prisma, practice.id);
      } catch {
        // Named, never silently passed over: without an actor this practice's
        // rows are unreachable and would keep their pre-fix verdicts.
        skipped.push(`${practice.id} (${practice.name})`);
        continue;
      }

      const flipped = await backfillPractice(prisma, practice.id, systemUserId);
      total += flipped;
      // The practice NAME, never anything under it — §11.
      if (flipped > 0) {
        console.log(`  ${practice.id} (${practice.name}) → ${flipped} line(s) suppressed`);
      }
    }

    console.log(
      `backfill-chase-suppression: done, ${total} line(s) suppressed, started ${startedAt.toISOString()}. ` +
        'Credits and SoT Stage 7 descriptor lines only; nothing was deleted and no true value was cleared.',
    );
    if (skipped.length > 0) {
      console.log(
        `backfill-chase-suppression: ⚠ ${skipped.length} practice(s) have NO SYSTEM actor and were not ` +
          `swept — run backfill-system-actors first, then re-run this: ${skipped.join(', ')}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('backfill-chase-suppression FAILED', error);
  process.exitCode = 1;
});
