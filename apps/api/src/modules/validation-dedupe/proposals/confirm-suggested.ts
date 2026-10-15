import type { BankConfirmSuggestedPayload } from '@neoting/contracts/model';

import { closedPeriodContaining, monthBounds } from '../../../common/banking/periods.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { formatDay, formatGbp } from '../../chase/index.js';
import { assertPeriodsOpen } from './period-lock.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/** The contract's `maxItems` on `items`. */
export const MAX_CONFIRM_SUGGESTED = 200;

/**
 * `bank.confirm-suggested` at CREATION — the `computePublishBatchPayload`
 * pattern. The items Read review itemises are the server's own read of the
 * live SUGGESTED rows (optionally one month), skipping closed months; whatever
 * list the caller sent is discarded.
 */
export async function computeConfirmSuggestedPayload(
  db: ScopedClient,
  businessId: string,
  period: string | null,
): Promise<BankConfirmSuggestedPayload> {
  const bounds = period === null ? null : monthBounds(period);
  const rows = await db.match.findMany({
    where: {
      businessId,
      state: 'SUGGESTED',
      unmatchedAt: null,
      transaction: {
        matchState: 'SUGGESTED',
        ...(bounds === null ? {} : { bookedAt: { gte: bounds.start, lt: bounds.end } }),
      },
    },
    select: {
      id: true,
      transactionId: true,
      documentId: true,
      allocatedPence: true,
      kind: true,
      confidence: true,
      transaction: { select: { amountPence: true, bookedAt: true, descriptionRaw: true, merchantName: true } },
      document: { select: { supplierName: true } },
    },
    orderBy: [{ transaction: { bookedAt: 'asc' } }, { id: 'asc' }],
    take: MAX_CONFIRM_SUGGESTED + 1,
  });
  const locks = await db.periodLock.findMany({ where: { businessId }, select: { periodStart: true, periodEnd: true } });
  const open = rows.filter((r) => closedPeriodContaining(locks, r.transaction.bookedAt) === null).slice(0, MAX_CONFIRM_SUGGESTED);
  if (open.length === 0) {
    throw new ProposalExecutionRefused('bank.confirm-suggested', 'there are no suggested matches to confirm for this client and period');
  }
  return {
    businessId,
    period,
    items: open.map((r) => ({
      matchId: r.id,
      transactionId: r.transactionId,
      documentId: r.documentId,
      amountPence: r.transaction.amountPence,
      allocatedPence: r.allocatedPence,
      kind: r.kind,
      confidence: r.confidence,
      label: [
        r.transaction.merchantName ?? r.transaction.descriptionRaw,
        `${r.transaction.amountPence < 0 ? '-' : '+'}${formatGbp(r.transaction.amountPence)}`,
        formatDay(r.transaction.bookedAt),
        `↔ ${r.document.supplierName ?? 'document'}`,
      ]
        .join(' · ')
        .slice(0, 300),
    })),
  };
}

/**
 * Promotes every reviewed suggestion to CONFIRMED in one transaction. Refuses
 * the whole batch if any item drifted since review (unmatched, confirmed by
 * someone else, re-pointed), so what was itemised is exactly what lands.
 */
export const confirmSuggestedExecutor: ProposalExecutor<'bank.confirm-suggested', BankConfirmSuggestedPayload> = {
  kind: 'bank.confirm-suggested',

  async execute(db: ScopedClient, input: ExecutionInput<BankConfirmSuggestedPayload>): Promise<ExecutionResult> {
    const { payload, traceId, proposalId, ctx } = input;
    const refuse = (message: string): never => {
      throw new ProposalExecutionRefused('bank.confirm-suggested', message);
    };
    const matchIds = payload.items.map((i) => i.matchId);
    const rows = await db.match.findMany({
      where: { id: { in: matchIds } },
      select: {
        id: true,
        businessId: true,
        transactionId: true,
        documentId: true,
        state: true,
        unmatchedAt: true,
        transaction: { select: { amountPence: true, bookedAt: true } },
        document: { select: { state: true } },
      },
    });
    if (rows.length !== new Set(matchIds).size) refuse('one or more suggested matches are no longer reachable');
    const byId = new Map(rows.map((r) => [r.id, r]));

    if (rows.every((r) => r.state === 'CONFIRMED' && r.unmatchedAt === null)) {
      return { changed: [...new Set(rows.map((r) => r.documentId))].map((id) => ({ entity: 'document' as const, id })), alreadyApplied: true, followUps: [] };
    }

    for (const item of payload.items) {
      const row = byId.get(item.matchId)!;
      if (row.businessId !== payload.businessId || row.transactionId !== item.transactionId || row.documentId !== item.documentId) {
        refuse('a suggested match changed since it was reviewed — propose again');
      }
      if (row.state !== 'SUGGESTED' || row.unmatchedAt !== null) refuse('a suggested match was decided since it was reviewed — propose again');
      if (row.document.state === 'ARCHIVED' || row.document.state === 'REJECTED') refuse('a suggested document has since been archived or rejected');
    }
    await assertPeriodsOpen(db, 'bank.confirm-suggested', payload.businessId, rows.map((r) => r.transaction.bookedAt));

    // A batch suggestion (several documents on one line) must still add up.
    const byTxn = new Map<string, typeof payload.items>();
    for (const item of payload.items) byTxn.set(item.transactionId, [...(byTxn.get(item.transactionId) ?? []), item]);
    for (const [transactionId, items] of byTxn) {
      if (items.some((i) => i.allocatedPence === null || i.allocatedPence === undefined)) {
        if (items.length > 1) refuse('a bank line carries two whole-line suggestions — confirm it on its own');
        continue;
      }
      const sum = items.reduce((n, i) => n + (i.allocatedPence ?? 0), 0);
      const line = byId.get(items[0]!.matchId)!.transaction.amountPence;
      if (sum !== line) refuse(`the suggested allocations on line ${transactionId} no longer add up to its amount`);
    }

    for (const item of payload.items) {
      await db.match.update({
        where: { id: item.matchId },
        data: { state: 'CONFIRMED', matchedBy: 'human', matchedByUserId: ctx.actorId },
      });
    }
    const transactionIds = [...byTxn.keys()];
    await db.bankTransaction.updateMany({ where: { id: { in: transactionIds } }, data: { matchState: 'CONFIRMED' } });

    const documentIds = [...new Set(payload.items.map((i) => i.documentId))];
    for (const documentId of documentIds) {
      await db.documentEvent.create({
        data: {
          documentId,
          stage: 'match',
          outcome: 'confirmed',
          traceId,
          detail: { proposalId, bulk: true },
        },
      });
    }
    return {
      changed: documentIds.map((id) => ({ entity: 'document' as const, id })),
      alreadyApplied: false,
      followUps: [],
      detail: { confirmed: payload.items.length, transactions: transactionIds.length },
    };
  },
};
