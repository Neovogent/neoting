import type { ProposalKind } from '@neoting/contracts/model';

import { closedPeriodContaining, periodLabel, periodOf } from '../../../common/banking/periods.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { ProposalExecutionRefused } from './proposal-executor.js';

/**
 * The period-lock guard (rush/matching): a closed month refuses every edit,
 * match, unmatch, cash code and release dated inside it, for every approver —
 * the super admin included. Reopening is its own `period.reopen` proposal.
 *
 * Called by each executor INSIDE the engine's transaction, so a month closed
 * between propose and approve still refuses at approve. A null date (an unread
 * document date) is never inside a period.
 */
export async function assertPeriodsOpen(
  db: ScopedClient,
  kind: ProposalKind,
  businessId: string | null,
  dates: readonly (Date | null | undefined)[],
): Promise<void> {
  if (businessId === null || dates.every((d) => d === null || d === undefined)) return;
  const locks = await db.periodLock.findMany({
    where: { businessId },
    select: { periodStart: true, periodEnd: true },
  });
  if (locks.length === 0) return;
  for (const date of dates) {
    const hit = closedPeriodContaining(locks, date);
    if (hit !== null) {
      throw new ProposalExecutionRefused(
        kind,
        `${periodLabel(periodOf(hit.periodStart))} is closed for this client — reopen the month before changing anything dated inside it`,
      );
    }
  }
}
