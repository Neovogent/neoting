/* eslint-disable no-console --
 * Same reason as migrate.ts, seed.ts and the two backfills: a standalone
 * process entrypoint with no Nest context and therefore no injected Logger.
 * Its stdout IS the interface.
 */
import { getPrismaClient } from '../apps/api/src/common/db/prisma.js';
import { resolveSystemActor } from '../apps/api/src/common/db/resolve-system-actor.js';
import { systemContext } from '../apps/api/src/common/db/scope-context.js';
import { scopedDb } from '../apps/api/src/common/db/scoped-db.js';
import { knownProposalKind } from '../apps/api/src/modules/approvals/proposal-body.js';
import { proposalIdentity } from '../apps/api/src/modules/approvals/proposal-identity.js';

/**
 * Cancel the duplicate approval requests a queue already holds — review item 26.
 *
 * > *For same document, multiple review request has come in the approval tab…
 * > make sure no duplicate approval request is sent*
 *
 * `action-proposals.service.ts` now REFUSES a second identical staging
 * (`NT-PRP-007`). That fixes tomorrow. This fixes today: the reported queue
 * holds eight identical "Release for export" cards over one Ready document, and
 * nothing in the product clears them in bulk.
 *
 * ## What it does, and what it deliberately does not
 *
 * Groups every non-terminal proposal by **kind + business + identity** — the
 * same `proposalIdentity` the server dedupes with, so the script and the
 * refusal can never disagree about what a duplicate IS — keeps the **newest** of
 * each group and **CANCELS** the rest.
 *
 * - **Cancels, never deletes.** `POST .../cancellation`'s own words: nothing is
 *   deleted, because *"what did we decide not to do"* is part of the record.
 *   Each cancelled row carries `outcome.reason` naming this script and
 *   `outcome.supersededBy` naming the survivor, so a reader six months from now
 *   can tell an operator's tidy-up from a human's decision.
 * - **Newest kept, not oldest.** The last click is the one whose payload
 *   reflects the most recent state of the documents, and it is the card the
 *   person was looking at when they gave up.
 * - **Never touches an EXECUTED, CANCELLED or DENIED row.** The database guard
 *   would refuse an executed one anyway (`action_proposals_guard()`); the filter
 *   is here so the script does not depend on being refused.
 * - **Never touches a kind with no identity** — `rule.create`. Two rules over
 *   one client are two rules.
 *
 * ## ⚠ IT RUNS PRACTICE BY PRACTICE, THROUGH `scopedDb`, AND IT HAS TO
 *
 * `action_proposals` is in the `direct_tables` RLS loop with FORCE ROW LEVEL
 * SECURITY. A plain unscoped `prisma.actionProposal.findMany()` therefore
 * **returns an empty list and does NOT error** — this script's first draft
 * printed *"Scanned 0 pending proposal(s). Nothing to do."* against a database
 * holding six, and it was caught only because the walkthrough ran it against a
 * queue somebody could see on screen.
 *
 * `backfill-import-fingerprints.ts` records the identical trap one table over,
 * and this is its shape: `practices` carries no RLS so the outer read needs no
 * context; everything below it resolves that practice's SYSTEM actor and works
 * inside `scopedDb`, through the same predicate a human's query goes through.
 *
 * ⚠ **A practice-level proposal (`business_id` NULL, `practice_id` set) is
 * visible to its own practice's context and is swept with the rest.** A proposal
 * anchored to NEITHER cannot exist — `create()` refuses it (`NT-PRP-006`).
 *
 * ## Why it is a script and not an endpoint
 *
 * There is no user in the product whose job this is. It is an operator's
 * one-off, run against one database by somebody who already holds its
 * credentials.
 *
 * ```bash
 * export DATABASE_URL=... DIRECT_URL=...          # from .env
 * npx tsx scripts/cleanup-duplicate-proposals.ts --dry-run
 * npx tsx scripts/cleanup-duplicate-proposals.ts --apply
 * ```
 *
 * `--dry-run` is the DEFAULT: a script that cancels approvals on a bare
 * invocation is one somebody runs by accident.
 */

const REASON = 'Superseded — duplicate staging (review item 26 cleanup)';

interface Member {
  readonly id: string;
  readonly createdAt: Date;
}

interface Group {
  readonly key: string;
  readonly keep: string;
  readonly cancel: readonly Member[];
}

/** Everything to cancel in ONE practice, grouped. Reads only. */
async function duplicatesIn(
  prisma: ReturnType<typeof getPrismaClient>,
  practiceId: string,
  systemUserId: string,
): Promise<{ scanned: number; groups: Group[] }> {
  const ctx = systemContext(practiceId, systemUserId);

  const rows = await scopedDb(prisma, ctx, (db) =>
    db.actionProposal.findMany({
      where: { state: { in: ['CREATED', 'REVIEWED'] } },
      select: { id: true, kind: true, businessId: true, payload: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  );

  const grouped = new Map<string, Member[]>();
  for (const row of rows) {
    const kind = knownProposalKind(row.kind);
    if (kind === null) continue;
    if (typeof row.payload !== 'object' || row.payload === null || Array.isArray(row.payload)) continue;
    const identity = proposalIdentity(kind, row.payload as Record<string, unknown>);
    // No identity means this kind is never a duplicate — `rule.create`.
    if (identity === null) continue;
    const key = `${kind}|${row.businessId ?? '—'}|${identity}`;
    grouped.set(key, [...(grouped.get(key) ?? []), { id: row.id, createdAt: row.createdAt }]);
  }

  // `rows` is already newest-first, so each group's first member is the keeper.
  const groups = [...grouped.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([key, members]) => ({ key, keep: members[0]!.id, cancel: members.slice(1) }));

  return { scanned: rows.length, groups };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = getPrismaClient();

  try {
    // `practices` carries no RLS — it is the tenant, not tenant-owned — so this
    // one read needs no context. Everything below it does.
    const practices = await prisma.practice.findMany({ select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
    console.log(`cleanup-duplicate-proposals: ${practices.length} practice(s) to sweep\n`);

    let scanned = 0;
    let cancelled = 0;
    const all: { practice: string; groups: Group[] }[] = [];
    const skipped: string[] = [];

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

      const found = await duplicatesIn(prisma, practice.id, systemUserId);
      scanned += found.scanned;
      if (found.groups.length > 0) all.push({ practice: `${practice.name} [${practice.id}]`, groups: found.groups });

      if (!apply) continue;

      const ctx = systemContext(practice.id, systemUserId);
      for (const group of found.groups) {
        for (const member of group.cancel) {
          // One update per row rather than an `updateMany`: `outcome` is
          // per-row, and a failure on one must not silently take the rest.
          await scopedDb(prisma, ctx, (db) =>
            db.actionProposal.update({
              where: { id: member.id },
              data: { state: 'CANCELLED', outcome: { cancelled: true, reason: REASON, supersededBy: group.keep } },
            }),
          );
          cancelled += 1;
        }
      }
    }

    const total = all.reduce((sum, p) => sum + p.groups.reduce((n, g) => n + g.cancel.length, 0), 0);
    console.log(`Scanned ${scanned} pending proposal(s) across ${practices.length - skipped.length} practice(s).`);
    if (skipped.length > 0) console.log(`⚠ Skipped (no SYSTEM actor): ${skipped.join(', ')}`);

    if (total === 0) {
      console.log('No duplicate groups. Nothing to do.');
      return;
    }

    for (const { practice, groups } of all) {
      console.log(`\n${practice}`);
      for (const group of groups) {
        console.log(`  ${group.key}`);
        console.log(`    keep    ${group.keep}`);
        for (const member of group.cancel) {
          console.log(`    cancel  ${member.id}  (staged ${member.createdAt.toISOString()})`);
        }
      }
    }

    console.log(`\n${total} proposal(s) in ${all.reduce((n, p) => n + p.groups.length, 0)} duplicate group(s).`);
    if (!apply) {
      console.log('\nDRY RUN — nothing was changed. Re-run with --apply to cancel them.');
      return;
    }
    console.log(`Cancelled ${cancelled}. Nothing was deleted.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`\ncleanup-duplicate-proposals failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
