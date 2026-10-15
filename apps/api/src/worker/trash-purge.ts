import { TRASH_RETENTION_DAYS, TRASH_RETENTION_POLICY_ID } from '@neoting/contracts';
import type { PrismaClient } from '@prisma/client';

import { resolveSystemActor } from '../common/db/resolve-system-actor.js';
import { systemContext } from '../common/db/scope-context.js';
import { scopedDb } from '../common/db/scoped-db.js';
import { appendAuditEvent, canonicalStringify, sha256Hex } from '../modules/approvals/index.js';

/**
 * The retention sweep — review item 61. Moved here from
 * `scripts/purge-expired-trash.ts` (rush/chase-scheduler) so the worker runs it
 * DAILY as a scheduled job; the script is now a thin CLI over this function
 * and keeps its `--dry-run`-by-default behaviour.
 *
 * ## ⚠ Governance §10.5 — what authorises an automated destruction
 *
 * A standing automation executes without per-item proposals only under a
 * policy that was itself approved, and records the policy it ran under. The
 * 30-day window is a PLATFORM term (the owner's 7 Sep 2026 ruling, text in
 * `docs/Retention_and_Deletion_Policy.md`), consent is taken at the moment of
 * deletion (the confirmation states the window before anything moves to
 * Trash), and every purge appends an audit row naming
 * `TRASH_RETENTION_POLICY_ID`.
 *
 * ## ⚠ The four refusals SKIP rather than refuse
 *
 * Same set as `document.purge`, read as ROWS, never inferred from `state`:
 * PUBLISHED, any `publishes` row, any `document_links` row (D43), any
 * `statements`/`supplier_statements` row (no FK exists there). A protected
 * document is held for good; one protected document never stops the rest.
 *
 * ## ⚠ Practice by practice, through `scopedDb`
 *
 * `documents` is FORCE-RLS, so an unscoped `findMany()` returns an empty list
 * and does not error. `practices` carries no RLS, so only the outer read is
 * unscoped.
 *
 * ponytail: one row per transaction, no batching. A practice's daily expiry is
 * a handful; if a migration ever leaves a hundred thousand due, chunk the
 * `findMany` first.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PurgeSummary {
  readonly due: number;
  readonly held: number;
  readonly purged: number;
  readonly skippedPractices: readonly string[];
}

interface Expired {
  readonly id: string;
  readonly businessId: string | null;
  readonly supplierName: string | null;
  readonly deletedAt: Date;
  readonly protectedBy: string | null;
}

/** Everything past the window in ONE practice, each row already judged. Reads only. */
async function expiredIn(prisma: PrismaClient, practiceId: string, systemUserId: string, cutoff: Date): Promise<Expired[]> {
  return scopedDb(prisma, systemContext(practiceId, systemUserId), async (db) => {
    const rows = await db.document.findMany({
      where: { deletedAt: { not: null, lt: cutoff } },
      select: {
        id: true,
        businessId: true,
        supplierName: true,
        deletedAt: true,
        state: true,
        _count: { select: { links: true, publishes: true } },
      },
      orderBy: { deletedAt: 'asc' },
    });
    if (rows.length === 0) return [];

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

export async function purgeExpiredTrash(
  prisma: PrismaClient,
  options: { readonly apply: boolean; readonly log: (line: string) => void; readonly now?: Date },
): Promise<PurgeSummary> {
  const { apply, log } = options;
  const cutoff = new Date((options.now ?? new Date()).getTime() - TRASH_RETENTION_DAYS * MS_PER_DAY);

  const practices = await prisma.practice.findMany({ select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
  log(
    `purge-expired-trash: ${TRASH_RETENTION_DAYS}-day window (${TRASH_RETENTION_POLICY_ID}), ` +
      `cutoff ${cutoff.toISOString()}, ${practices.length} practice(s)${apply ? '' : ' — DRY RUN'}`,
  );

  const skippedPractices: string[] = [];
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
      skippedPractices.push(`${practice.id} (${practice.name})`);
      continue;
    }

    const rows = await expiredIn(prisma, practice.id, systemUserId, cutoff);
    if (rows.length === 0) continue;

    const goes = rows.filter((row) => row.protectedBy === null);
    const stays = rows.filter((row) => row.protectedBy !== null);
    due += goes.length;
    held += stays.length;

    log(`${practice.name} [${practice.id}]`);
    for (const row of goes) log(`  purge  ${row.id}  ${row.supplierName ?? '(no supplier)'}  deleted ${row.deletedAt.toISOString()}`);
    for (const row of stays) log(`  HOLD   ${row.id}  ${row.supplierName ?? '(no supplier)'}  — ${row.protectedBy}`);

    if (!apply) continue;

    const ctx = systemContext(practice.id, systemUserId);
    for (const row of goes) {
      // ⚠ The audit row is appended in the SAME transaction as the delete and
      // BEFORE it: `document_events` cascades away with the document, so this
      // row is the only surviving record that it existed and why it went.
      await scopedDb(prisma, ctx, async (db) => {
        const outcome = {
          purged: 1,
          documentId: row.id,
          businessId: row.businessId,
          supplierName: row.supplierName,
          deletedAt: row.deletedAt.toISOString(),
          retentionDays: TRASH_RETENTION_DAYS,
          policyId: TRASH_RETENTION_POLICY_ID,
          automated: true,
          // Stored objects are not reclaimed here, same as `document.purge`.
          storedObjectsRetained: true,
        };
        await appendAuditEvent(db, {
          businessId: row.businessId,
          event: 'document.purge.retention',
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

  if (skippedPractices.length > 0) log(`⚠ Skipped (no SYSTEM actor): ${skippedPractices.join(', ')}`);
  log(
    `${due} document(s) past ${TRASH_RETENTION_DAYS} days; ${held} held for good; ` +
      (apply ? `purged ${purged}. Stored objects were not reclaimed.` : 'nothing changed (dry run).'),
  );
  return { due, held, purged, skippedPractices };
}
