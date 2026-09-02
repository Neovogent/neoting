/* eslint-disable no-console --
 * Same reason as migrate.ts, seed.ts and backfill-system-actors.ts: a standalone
 * process entrypoint run as a one-off container with no Nest context and
 * therefore no injected Logger. Its stdout/stderr ARE the interface.
 */
import { getPrismaClient } from '../common/db/prisma.js';
import { resolveSystemActor } from '../common/db/resolve-system-actor.js';
import { systemContext } from '../common/db/scope-context.js';
import { scopedDb } from '../common/db/scoped-db.js';
import { identityGroupKey, importFingerprint } from '../modules/banking-matching/statement-ingest/row-identity.js';

/**
 * Give every bank transaction that predates the fingerprint column the identity
 * it should have been written with.
 *
 * ## ⚠ Why this is needed and not optional
 *
 * `20260902160000_bank_transaction_import_fingerprint` adds
 * `(account_id, import_fingerprint)` UNIQUE, and a plain unique index treats
 * NULLs as distinct. So the defence protects only rows written AFTER it: a
 * statement whose lines were imported before the migration has NULL
 * fingerprints, nothing to collide with, and re-uploading it would double that
 * client's data exactly as before. Keying the existing rows is what closes the
 * window — and the window is the whole reason this file exists, because the
 * client that surfaced the defect already has 2,288 rows in that state.
 *
 * **Run it once, immediately after the migration.** That is when the answer is
 * unambiguous: no row has an identity yet, so counting occurrences among the
 * un-keyed rows is the same as counting them among all rows. Run much later,
 * beside live imports, and the two numberings can meet — see the P2002 catch,
 * which reports rather than fails.
 *
 * ## Idempotent
 *
 * It only ever writes rows where `import_fingerprint IS NULL`, so a second run
 * is a no-op, an interrupted run resumes, and a row already keyed by the ingest
 * lane is never rewritten. It writes ONE column; no row is created, deleted, or
 * otherwise modified.
 *
 * ## Reversible
 *
 * Exactly, and in one statement — the column held nothing before this ran:
 *
 * ```sql
 * UPDATE bank_transactions SET import_fingerprint = NULL;   -- undo everything
 * ```
 *
 * To undo only this pass and keep what the ingest lane has written since, scope
 * it by time: `... WHERE updated_at < '<the timestamp printed at the end>'`.
 * Nothing else needs restoring, because nothing else was changed.
 *
 * ## ⚠ What it does NOT do, deliberately
 *
 * **It deletes nothing.** A client whose data is already doubled stays doubled
 * — this is an accounting ledger, and a script that silently removed rows a
 * human never inspected would be a worse defect than the one it repairs. What
 * it does is stop the doubling growing: after this runs, re-uploading either of
 * those statements adds nothing.
 *
 * On already-doubled data the two copies of a line receive ordinals 1 and 2 and
 * both keep their row — the same answer the ordinal gives a genuine repeat
 * purchase, because from here nothing can tell those two cases apart. The number
 * of groups holding more than one row is printed at the end so an operator can
 * see how much of that exists before deciding what to do about it. Deciding is a
 * human's job.
 *
 * ## Ordering within a group
 *
 * `(account, booked date, currency, pence, normalised description)` groups are
 * ordered by `created_at` then `id` — stable, total, reproducible, which is all
 * an ordinal needs. It carries no meaning beyond "the Nth of these".
 *
 * ## How it is invoked
 *
 * The **api** task family, like `backfill-system-actors`: it updates ordinary
 * rows through the `nt_app` role and needs no elevated privilege. Borrowing the
 * migrate family's schema-owner credential — the only one that can TRUNCATE —
 * would be taking a dangerous credential to do a job that does not want one.
 *
 * ```
 * aws ecs run-task --cluster nt-staging
 *   --task-definition nt-staging-api
 *   --overrides '{"containerOverrides":[{"name":"api",
 *                  "command":["node","apps/api/dist/db/backfill-import-fingerprints.js"]}]}' ...
 * ```
 *
 * ## ⚠ It runs PRACTICE BY PRACTICE, through `scopedDb`, and it has to
 *
 * The first draft of this read `bankTransaction` off the root client the way
 * `backfill-system-actors.ts` reads `practices`, and it reported "nothing to do"
 * against a database holding six un-keyed rows. That is not a bug that throws:
 * `bank_transactions` is in the `direct_tables` RLS loop with FORCE ROW LEVEL
 * SECURITY, so a query with no GUCs set matches no rows and returns an empty
 * list, which is indistinguishable from a finished job. `backfill-system-actors`
 * gets away with it only because `practices`, `users` and `memberships` carry no
 * policies at all.
 *
 * So this resolves each practice's SYSTEM actor — the same actor the ingest
 * workers run as — and does its reads and writes inside `scopedDb`, through
 * exactly the predicate a human's query goes through. No privileged connection,
 * no `SECURITY DEFINER`, no policy relaxed for a maintenance job.
 *
 * Two consequences worth stating:
 *
 * - **A practice with no SYSTEM actor is skipped and named**, not silently
 *   passed over. `backfill-system-actors.ts` is the fix for that; run it first.
 * - **A business with no practice is out of reach**, because there is no
 *   practice-level actor whose membership the predicate would match. ID creates
 *   businesses under a practice, so this is expected to be empty — but it is
 *   stated rather than assumed, because "returned nothing" and "there was
 *   nothing" look the same from here.
 */

/** Rows per read. Big enough to be few round trips, small enough to hold. */
const PAGE = 1_000;

/** Postgres unique violation, as Prisma reports it. See the catch below. */
const UNIQUE_VIOLATION = 'P2002';

interface Row {
  readonly id: string;
  readonly accountId: string;
  readonly bookedAt: Date;
  readonly currency: string;
  readonly amountPence: number;
  readonly descriptionRaw: string;
  readonly importFingerprint: string | null;
}

interface Tally {
  keyed: number;
  contended: number;
  repeated: number;
}

async function backfillPractice(
  prisma: ReturnType<typeof getPrismaClient>,
  practiceId: string,
  systemUserId: string,
): Promise<Tally> {
  const ctx = systemContext(practiceId, systemUserId);
  // Bounded by one practice's rows rather than the whole estate, which is the
  // incidental benefit of having to scope: the counter never outgrows a tenant.
  const counted = new Map<string, number>();
  const tally: Tally = { keyed: 0, contended: 0, repeated: 0 };
  let cursor: string | undefined;

  for (;;) {
    // ⚠ The page is read over EVERY row, not over `importFingerprint: null`.
    //
    // Prisma locates a cursor by finding that row inside the same filtered
    // query. Filtering on the column this loop WRITES would remove each page's
    // last row from the next page's result set and the cursor would stop
    // resolving — a paging loop that reads nothing and calls itself finished.
    // Rows that already have an identity are skipped in memory instead, which
    // costs one comparison and cannot go wrong.
    const rows: Row[] = await scopedDb(prisma, ctx, (db) =>
      db.bankTransaction.findMany({
        select: {
          id: true,
          accountId: true,
          bookedAt: true,
          currency: true,
          amountPence: true,
          descriptionRaw: true,
          importFingerprint: true,
        },
        // Total and stable — `id` last, so the sort has no ties and the cursor
        // always lands in exactly one place. Account first so a group's rows are
        // contiguous, which is what lets the ordinal counter stay small.
        orderBy: [{ accountId: 'asc' }, { bookedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: PAGE,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      }),
    );
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]?.id;

    for (const row of rows) {
      if (row.importFingerprint !== null) continue;
      const bookedOn = row.bookedAt.toISOString().slice(0, 10);
      // The SAME two functions the ingest lane uses. Re-implementing either here
      // — or in SQL, inside the migration — is how a backfilled row and a freshly
      // imported one end up with different identities for one transaction, which
      // would defeat the whole defence silently.
      const group = identityGroupKey(row.accountId, bookedOn, row.currency, row.amountPence, row.descriptionRaw);
      const ordinal = (counted.get(group) ?? 0) + 1;
      counted.set(group, ordinal);
      if (ordinal === 2) tally.repeated += 1;

      try {
        // ⚠ ONE transaction per row, deliberately, and not a batch.
        //
        // A unique violation ABORTS the Postgres transaction it happens in, so a
        // batched write that hit one would poison every remaining statement in
        // that batch with "current transaction is aborted". Isolating the write
        // is what makes the catch below able to continue at all.
        await scopedDb(prisma, ctx, (db) =>
          db.bankTransaction.updateMany({
            // ⚠ `importFingerprint: null` in the WHERE, not just the id. The
            // write becomes a no-op if the ingest lane keyed this row between
            // the read and the update, so a backfill running beside live
            // traffic cannot overwrite a live value.
            where: { id: row.id, importFingerprint: null },
            data: {
              importFingerprint: importFingerprint({
                accountId: row.accountId,
                bookedOn,
                currency: row.currency,
                amountPence: row.amountPence,
                description: row.descriptionRaw,
                ordinal,
              }),
            },
          }),
        );
        tally.keyed += 1;
      } catch (error: unknown) {
        // A collision with an identity the INGEST lane wrote while this ran:
        // that lane counts ordinals within its own file, this one counts them
        // within the un-keyed set, and the two numberings can meet. The row is
        // left NULL and reported. Abandoning the rest of the repair over it
        // would be the wrong trade — a partial repair is strictly better than
        // none, and re-running finishes the job.
        if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
        tally.contended += 1;
      }
    }
  }

  return tally;
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
    console.log(`backfill-import-fingerprints: ${practices.length} practice(s) to sweep`);

    const totals: Tally = { keyed: 0, contended: 0, repeated: 0 };
    const skipped: string[] = [];

    for (const practice of practices) {
      let systemUserId: string;
      try {
        systemUserId = await resolveSystemActor(prisma, practice.id);
      } catch {
        // Named, never silently passed over: without an actor this practice's
        // rows are unreachable and would stay un-keyed, which is exactly the
        // state the fingerprint index does not protect.
        skipped.push(`${practice.id} (${practice.name})`);
        continue;
      }

      const tally = await backfillPractice(prisma, practice.id, systemUserId);
      totals.keyed += tally.keyed;
      totals.contended += tally.contended;
      totals.repeated += tally.repeated;
      // The practice NAME, never anything under it — §11. An operator running a
      // backfill already knows which tenants exist.
      if (tally.keyed > 0 || tally.contended > 0) {
        console.log(`  ${practice.id} (${practice.name}) → ${tally.keyed} keyed, ${tally.repeated} repeated group(s)`);
      }
    }

    // How much already-duplicated data exists, so the operator knows. Reported,
    // never repaired: removing a line from an accounting ledger is a decision a
    // person makes with the statements in front of them.
    console.log(
      `backfill-import-fingerprints: done, ${totals.keyed} keyed, started ${startedAt.toISOString()}. ` +
        `${totals.repeated} identity group(s) hold more than one row — either genuine repeat purchases or ` +
        'lines imported twice before this defence existed. Nothing was deleted.',
    );
    if (totals.contended > 0) {
      console.log(
        `backfill-import-fingerprints: ${totals.contended} row(s) collided with an identity written ` +
          'concurrently and were left unkeyed. Re-run to finish them.',
      );
    }
    if (skipped.length > 0) {
      console.log(
        `backfill-import-fingerprints: ⚠ ${skipped.length} practice(s) have NO SYSTEM actor and were not ` +
          `swept — run backfill-system-actors first, then re-run this: ${skipped.join(', ')}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('backfill-import-fingerprints FAILED', error);
  process.exitCode = 1;
});
