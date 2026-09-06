/**
 * Cancel the duplicate approval requests a queue already holds — review item 26.
 *
 * > *For same document, multiple review request has come in the approval tab…
 * > make sure no duplicate approval request is sent*
 *
 * `apps/api/src/modules/approvals/action-proposals.service.ts` now REFUSES a
 * second identical staging (`NT-PRP-007`). That fixes tomorrow. This fixes
 * today: the reported queue holds eight identical "Release for export" cards
 * over one Ready document, and nothing in the product clears them in bulk.
 *
 * ## What it does, and what it deliberately does not
 *
 * Groups every non-terminal proposal by **kind + business + identity** (the
 * same `proposalIdentity` the server dedupes with, so the script and the
 * refusal can never disagree about what a duplicate is), keeps the **newest**
 * of each group, and **CANCELS** the rest.
 *
 * - **Cancels, never deletes.** `POST .../cancellation`'s own words: nothing is
 *   deleted, because *"what did we decide not to do"* is part of the record.
 *   Each cancelled row carries `outcome.reason` naming this script, so a reader
 *   six months from now can tell an operator's tidy-up from a human's decision.
 * - **Newest kept, not oldest.** The last click is the one whose payload
 *   reflects the most recent state of the documents, and it is the card the
 *   person was looking at when they gave up.
 * - **Never touches an EXECUTED or CANCELLED row.** The database guard would
 *   refuse an executed one anyway (`action_proposals_guard()`); the filter is
 *   here so the script does not depend on being refused.
 * - **Never touches a row whose kind has no identity** — `rule.create`. Two
 *   rules over one client are two rules.
 *
 * ## Why it bypasses `ActionProposalsService`
 *
 * It is an OPERATOR script, run against one database by a person who already
 * has its credentials, and it has no session to build a `ScopeContext` from.
 * `action_proposals` is in the RLS loop, so it runs as the migrator/owner
 * connection the way `prisma/seed.ts` does. That is the reason it is a script
 * and not an endpoint: there is no user in the product whose job this is.
 *
 * ```bash
 * pnpm --filter @neoting/api exec tsx ../../scripts/cleanup-duplicate-proposals.ts --dry-run
 * pnpm --filter @neoting/api exec tsx ../../scripts/cleanup-duplicate-proposals.ts --apply
 * ```
 *
 * `--dry-run` is the DEFAULT: a script that cancels approvals on a bare
 * invocation is one somebody runs by accident.
 */

import { PrismaClient } from '@prisma/client';

import { proposalIdentity } from '../apps/api/src/modules/approvals/proposal-identity.js';
import { knownProposalKind } from '../apps/api/src/modules/approvals/proposal-body.js';

const REASON = 'Superseded — duplicate staging (review item 26 cleanup)';

interface Group {
  readonly key: string;
  readonly keep: string;
  readonly cancel: readonly { id: string; createdAt: Date }[];
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();

  try {
    const rows = await prisma.actionProposal.findMany({
      where: { state: { in: ['CREATED', 'REVIEWED'] } },
      select: { id: true, kind: true, businessId: true, payload: true, createdAt: true, state: true },
      orderBy: { createdAt: 'desc' },
    });

    const groups = new Map<string, { id: string; createdAt: Date }[]>();
    for (const row of rows) {
      const kind = knownProposalKind(row.kind);
      if (kind === null) continue;
      if (typeof row.payload !== 'object' || row.payload === null || Array.isArray(row.payload)) continue;
      const identity = proposalIdentity(kind, row.payload as Record<string, unknown>);
      // No identity means this kind is never a duplicate — `rule.create`.
      if (identity === null) continue;
      const key = `${kind}|${row.businessId ?? '—'}|${identity}`;
      groups.set(key, [...(groups.get(key) ?? []), { id: row.id, createdAt: row.createdAt }]);
    }

    // `rows` is already newest-first, so each group's first member is the keeper.
    const duplicates: Group[] = [...groups.entries()]
      .filter(([, members]) => members.length > 1)
      .map(([key, members]) => ({ key, keep: members[0]!.id, cancel: members.slice(1) }));

    const total = duplicates.reduce((sum, group) => sum + group.cancel.length, 0);

    process.stdout.write(`\nScanned ${rows.length} pending proposal(s).\n`);
    if (duplicates.length === 0) {
      process.stdout.write('No duplicate groups. Nothing to do.\n');
      return;
    }

    for (const group of duplicates) {
      process.stdout.write(`\n  ${group.key}\n`);
      process.stdout.write(`    keep    ${group.keep}\n`);
      for (const member of group.cancel) {
        process.stdout.write(`    cancel  ${member.id}  (staged ${member.createdAt.toISOString()})\n`);
      }
    }

    process.stdout.write(`\n${duplicates.length} duplicate group(s), ${total} proposal(s) to cancel.\n`);

    if (!apply) {
      process.stdout.write('\nDRY RUN — nothing was changed. Re-run with --apply to cancel them.\n');
      return;
    }

    // One update per row rather than an `updateMany`: `outcome` is per-row, and
    // a failure on one must not silently take the others with it.
    let cancelled = 0;
    for (const group of duplicates) {
      for (const member of group.cancel) {
        await prisma.actionProposal.update({
          where: { id: member.id },
          data: {
            state: 'CANCELLED',
            outcome: { cancelled: true, reason: REASON, supersededBy: group.keep },
          },
        });
        cancelled += 1;
      }
    }
    process.stdout.write(`\nCancelled ${cancelled} proposal(s). Nothing was deleted.\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\ncleanup-duplicate-proposals failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
