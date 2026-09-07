/* eslint-disable no-console --
 * Same reason as migrate.ts, seed.ts, the two backfills and
 * cleanup-duplicate-proposals.ts: a standalone process entrypoint with no Nest
 * context and therefore no injected Logger. Its stdout IS the interface.
 */
import { TRASH_RETENTION_DAYS, TRASH_RETENTION_POLICY_ID } from '@neoting/contracts';

import { getPrismaClient } from '../apps/api/src/common/db/prisma.js';
import { resolveSystemActor } from '../apps/api/src/common/db/resolve-system-actor.js';
import { systemContext } from '../apps/api/src/common/db/scope-context.js';
import { scopedDb } from '../apps/api/src/common/db/scoped-db.js';
import { appendAuditEvent } from '../apps/api/src/modules/approvals/index.js';
import { canonicalStringify, sha256Hex } from '../apps/api/src/modules/approvals/canonical-hash.js';

/**
 * The retention sweep — **review item 61, and the half that makes the promise
 * true.**
 *
 * > *"If there's a trash button then there should be a trash tab in the
 * > settings to see the trash, and how will the trash hold the file? Clear
 * > that out"*
 *
 * The 2 Sep 2026 work deliberately promised NO recovery window, on the sound
 * ground that *"a figure would be a promise the product does not keep"* —
 * nothing enforced one. The owner ruled a figure on 7 Sep 2026 (thirty days,
 * over seven and ninety), so the enforcement had to arrive with the sentence.
 * This is it. `docs/Retention_and_Deletion_Policy.md` is the policy; this file
 * is the only thing in the repository that acts on it.
 *
 * ## ⚠ Governance §10.5 — what authorises an automated destruction
 *
 * §10 forbids a state change outside Review → Approve, with ONE door: *standing
 * automations execute without per-item proposals only under a policy that was
 * itself approved through this contract*, and *automated executions record the
 * policy ID they ran under*. This sweep goes through that door, and the shape of
 * its authorisation is worth stating because somebody will check:
 *
 * - The policy is a **platform term, not a per-practice toggle.** No practice
 *   turns it on, off, or to a different number, so there is no `policies` row
 *   for anyone to approve and inventing one would be ceremony over a constant.
 *   Its approval is the owner's recorded ruling; its text is the policy
 *   document.
 * - **Consent is at the moment of deletion, not at the moment of purge.** Every
 *   accountant is told the window in the confirmation dialog BEFORE anything
 *   moves to Trash, and again on the Trash view they restore from. A document
 *   reaching its thirtieth day is the policy the person already read, arriving.
 * - **Every purge writes an audit row naming `TRASH_RETENTION_POLICY_ID`**, so
 *   the §10.5 requirement is met literally and a row written a year ago still
 *   names the policy version in force when it ran.
 *
 * ## ⚠ THE FOUR REFUSALS ARE THE SAME FOUR, AND THEY SKIP RATHER THAN REFUSE
 *
 * `document.purge`'s executor refuses a whole batch when any member is
 * protected, because a human proposed that exact batch and deserves to be told.
 * A sweep has no such person and no such batch: one protected document must not
 * stop the other four hundred, so a protected document is **skipped, counted and
 * printed**, and it stays in Trash for good.
 *
 * The set is identical, checked as ROWS and never inferred from `state`
 * (`purge-document.ts` carries the full argument for each):
 *
 * | Checked | Why |
 * |---|---|
 * | `state = 'PUBLISHED'` | released for export right now |
 * | any `publishes` row | HAS been released, whatever `state` says today |
 * | any `document_links` row | the D43 capability code an accountant may still be resolving out of a VT file |
 * | any `statements` / `supplier_statements` row | ⚠ no foreign key exists, so Postgres would leave them dangling silently |
 *
 * **That is what makes the retention sentence two clauses everywhere it is
 * written**: thirty days, *unless it has been exported — then it is held for
 * good*. A surface that prints only the first half is lying, and the ones in
 * this repository print both.
 *
 * ## ⚠ IT RUNS PRACTICE BY PRACTICE, THROUGH `scopedDb`, AND IT HAS TO
 *
 * `documents` is in the `direct_tables` RLS loop with FORCE ROW LEVEL SECURITY,
 * so a plain unscoped `prisma.document.findMany()` **returns an empty list and
 * does not error** — `cleanup-duplicate-proposals.ts` and
 * `backfill-import-fingerprints.ts` both record being caught by exactly that,
 * and a retention sweep that silently found nothing would be the worst place in
 * the product to learn it a third time. `practices` carries no RLS, so the outer
 * read needs no context; everything below resolves that practice's SYSTEM actor
 * and works inside `scopedDb`, through the same predicate a human's query goes
 * through.
 *
 * ## Why a script and not a BullMQ repeatable
 *
 * The ladder's answer. The worker process exists and BullMQ is installed, so a
 * repeatable job is buildable — but it would need a new queue, a processor, a
 * name, a boot registration and env config, to run one query a day. This is an
 * operator's cron line against a database whose credentials they already hold,
 * and it is `--dry-run` by default so an accidental invocation destroys nothing.
 *
 * ```bash
 * export DATABASE_URL=... DIRECT_URL=...          # from .env
 * pnpm trash:purge                                # dry run: prints what WOULD go
 * pnpm trash:purge --apply                        # actually purges
 * ```
 *
 * ponytail: one row at a time, no batching. A practice's daily expiry is a
 * handful of documents; if a migration ever leaves a hundred thousand due at
 * once, chunk the `findMany` before chunking anything else.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface Expired {
  readonly id: string;
  readonly businessId: string | null;
  readonly supplierName: string | null;
  readonly deletedAt: Date;
  readonly protectedBy: string | null;
}

/** Everything past the window in ONE practice, each row already judged. Reads only. */
async function expiredIn(
  prisma: ReturnType<typeof getPrismaClient>,
  practiceId: string,
  systemUserId: string,
  cutoff: Date,
): Promise<Expired[]> {
  const ctx = systemContext(practiceId, systemUserId);

  return scopedDb(prisma, ctx, async (db) => {
    const rows = await db.document.findMany({
      where: { deletedAt: { not: null, lt: cutoff } },
      select: {
        id: true,
        businessId: true,
        supplierName: true,
        deletedAt: true,
        state: true,
        // Counted rather than fetched — the question is only "does any exist".
        _count: { select: { links: true, publishes: true } },
      },
      orderBy: { deletedAt: 'asc' },
    });
    if (rows.length === 0) return [];

    // The fourth check, and the one no relation could make for us: these two
    // `document_id` columns carry NO foreign key, so nothing in Postgres would
    // notice them dangling. Two queries over the whole candidate set rather than
    // two per document.
    const ids = rows.map((row) => row.id);
    const [statements, supplierStatements] = await Promise.all([
      db.statement.findMany({ where: { documentId: { in: ids } }, select: { documentId: true } }),
      db.supplierStatement.findMany({ where: { documentId: { in: ids } }, select: { documentId: true } }),
    ]);
    const named = new Set<string>([
      ...statements.flatMap((row) => (row.documentId === null ? [] : [row.documentId])),
      ...supplierStatements.flatMap((row) => (row.documentId === null ? [] : [row.documentId])),
    ]);

    return rows.map((row) => ({
      id: row.id,
      businessId: row.businessId,
      supplierName: row.supplierName,
      deletedAt: row.deletedAt!,
      protectedBy:
        row.state === 'PUBLISHED'
          ? 'released for export'
          : row._count.publishes > 0
            ? 'has been released for export'
            : row._count.links > 0
              ? 'carries an export link (D43)'
              : named.has(row.id)
                ? 'is a statement source file'
                : null,
    }));
  });
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = getPrismaClient();
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * MS_PER_DAY);

  try {
    // `practices` carries no RLS — it is the tenant, not tenant-owned — so this
    // one read needs no context. Everything below it does.
    const practices = await prisma.practice.findMany({
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
    console.log(
      `purge-expired-trash: ${TRASH_RETENTION_DAYS}-day window (${TRASH_RETENTION_POLICY_ID}), ` +
        `cutoff ${cutoff.toISOString()}, ${practices.length} practice(s)\n`,
    );

    const skipped: string[] = [];
    let due = 0;
    let held = 0;
    let purged = 0;

    for (const practice of practices) {
      let systemUserId: string;
      try {
        systemUserId = await resolveSystemActor(prisma, practice.id);
      } catch {
        // Named, never silently passed over: without an actor this practice's
        // rows are unreachable, and "nothing to do" would be a lie about them.
        skipped.push(`${practice.id} (${practice.name})`);
        continue;
      }

      const rows = await expiredIn(prisma, practice.id, systemUserId, cutoff);
      if (rows.length === 0) continue;

      const goes = rows.filter((row) => row.protectedBy === null);
      const stays = rows.filter((row) => row.protectedBy !== null);
      due += goes.length;
      held += stays.length;

      console.log(`${practice.name} [${practice.id}]`);
      for (const row of goes) {
        console.log(`  purge  ${row.id}  ${row.supplierName ?? '(no supplier)'}  deleted ${row.deletedAt.toISOString()}`);
      }
      for (const row of stays) {
        console.log(`  HOLD   ${row.id}  ${row.supplierName ?? '(no supplier)'}  — ${row.protectedBy}`);
      }

      if (!apply) continue;

      const ctx = systemContext(practice.id, systemUserId);
      for (const row of goes) {
        // One document per transaction, deliberately: a purge cascades six child
        // tables, and a batch that timed out inside `scopedDb`'s 10 s would roll
        // back work that had genuinely completed. The same reasoning caps the
        // human-facing `document.purge` at 100 rather than 500.
        //
        // ⚠ The audit row is appended in the SAME transaction as the delete, and
        // BEFORE it: `document_events` cascades away with the document, so this
        // row plus its hash link is the only surviving record that the document
        // existed and why it went. Writing it after the delete would be one
        // failed statement away from a silent, untraceable destruction.
        await scopedDb(prisma, ctx, async (db) => {
          const outcome = {
            purged: 1,
            documentId: row.id,
            businessId: row.businessId,
            supplierName: row.supplierName,
            deletedAt: row.deletedAt.toISOString(),
            retentionDays: TRASH_RETENTION_DAYS,
            // §10.5's literal requirement: an automated execution records the
            // policy it ran under.
            policyId: TRASH_RETENTION_POLICY_ID,
            automated: true,
            // The same shortfall `document.purge` records: the bytes in the
            // object store are not reclaimed here. An operator reading this row
            // must not conclude otherwise.
            storedObjectsRetained: true,
          };
          await appendAuditEvent(db, {
            businessId: row.businessId,
            event: 'document.purge.retention',
            // No proposal, and that is the point of this whole header — the
            // nullable `proposalId` exists for exactly this class of event.
            proposalId: null,
            payloadHash: sha256Hex(canonicalStringify(outcome)),
            renderedSummaryHash: null,
            traceId: null,
            outcome,
          });
          await db.document.delete({ where: { id: row.id } });
        });
        purged += 1;
      }
    }

    if (skipped.length > 0) console.log(`\n⚠ Skipped (no SYSTEM actor): ${skipped.join(', ')}`);

    if (due === 0 && held === 0) {
      console.log('Nothing is past the window. Nothing to do.');
      return;
    }

    console.log(`\n${due} document(s) past ${TRASH_RETENTION_DAYS} days; ${held} held for good (exported or a statement source).`);
    if (!apply) {
      console.log('\nDRY RUN — nothing was changed. Re-run with --apply to purge them.');
      return;
    }
    console.log(`Purged ${purged}. Stored objects were not reclaimed.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`\npurge-expired-trash failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
