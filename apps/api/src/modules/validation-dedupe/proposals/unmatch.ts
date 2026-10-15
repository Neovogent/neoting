import type { BankUnmatchPayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { assertPeriodsOpen } from './period-lock.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * `bank.unmatch` — one-click unmatch (rush/matching, SoT §4 Stage 7).
 *
 * Every live match on each named line — a confirmed allocation or a pending
 * suggestion — is stamped `unmatchedAt` with state UNMATCHED (history kept,
 * never deleted), and the line returns to UNMATCHED, which puts it back in the
 * set chase detection reads. A document paid by several lines keeps its other
 * allocations: only the named lines' links break. All-or-nothing; a line
 * inside a closed month refuses.
 */
export const unmatchExecutor: ProposalExecutor<'bank.unmatch', BankUnmatchPayload> = {
  kind: 'bank.unmatch',

  async execute(db: ScopedClient, input: ExecutionInput<BankUnmatchPayload>): Promise<ExecutionResult> {
    const { payload, traceId, proposalId } = input;
    const ids = [...new Set(payload.transactionIds)];

    const transactions = await db.bankTransaction.findMany({
      where: { id: { in: ids } },
      select: { id: true, businessId: true, bookedAt: true, matchState: true },
    });
    if (transactions.length !== ids.length) {
      throw new ProposalExecutionRefused('bank.unmatch', 'one or more bank transactions are not reachable');
    }
    const businessId = transactions[0]!.businessId;
    if (transactions.some((t) => t.businessId !== businessId)) {
      throw new ProposalExecutionRefused('bank.unmatch', 'an unmatch belongs to one client — propose one per client');
    }
    await assertPeriodsOpen(db, 'bank.unmatch', businessId, transactions.map((t) => t.bookedAt));

    const live = await db.match.findMany({
      where: { transactionId: { in: ids }, unmatchedAt: null },
      select: { id: true, documentId: true, transactionId: true, state: true },
    });
    // Idempotent replay: nothing live and every line already unmatched.
    if (live.length === 0 && transactions.every((t) => t.matchState === 'UNMATCHED')) {
      return { changed: [], alreadyApplied: true, followUps: [] };
    }

    await db.match.updateMany({
      where: { id: { in: live.map((m) => m.id) } },
      data: { state: 'UNMATCHED', unmatchedAt: new Date() },
    });
    await db.bankTransaction.updateMany({ where: { id: { in: ids } }, data: { matchState: 'UNMATCHED' } });

    const documentIds = [...new Set(live.map((m) => m.documentId))];
    for (const documentId of documentIds) {
      await db.documentEvent.create({
        data: {
          documentId,
          stage: 'match',
          outcome: 'unmatched',
          traceId,
          detail: {
            proposalId,
            transactionIds: live.filter((m) => m.documentId === documentId).map((m) => m.transactionId).join(','),
            ...(payload.reason ? { reason: payload.reason } : {}),
          },
        },
      });
    }

    return {
      changed: documentIds.map((id) => ({ entity: 'document' as const, id })),
      alreadyApplied: false,
      followUps: [],
      detail: { transactions: ids.length, linksBroken: live.length },
    };
  },
};
