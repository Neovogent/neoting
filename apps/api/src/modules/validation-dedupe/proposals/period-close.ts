import type { PeriodClosePayload, PeriodReopenPayload } from '@neoting/contracts/model';

import { monthBounds } from '../../../common/banking/periods.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * `period.close` at CREATION: the summary Read review shows — how many lines
 * the month holds and how many are still unexplained — is the server's count,
 * so the super admin closes a month knowing what is in it.
 */
export async function computePeriodClosePayload(db: ScopedClient, payload: PeriodClosePayload): Promise<PeriodClosePayload> {
  const business = await db.business.findUnique({ where: { id: payload.businessId }, select: { id: true } });
  if (business === null) throw new ProposalExecutionRefused('period.close', 'no client with that id');
  const { start, end } = monthBounds(payload.period);
  const groups = await db.bankTransaction.groupBy({
    by: ['matchState'],
    where: { businessId: payload.businessId, bookedAt: { gte: start, lt: end } },
    _count: { _all: true },
  });
  const count = (state: string): number => groups.find((g) => g.matchState === state)?._count._all ?? 0;
  return {
    businessId: payload.businessId,
    period: payload.period,
    summary: {
      transactionCount: groups.reduce((n, g) => n + g._count._all, 0),
      confirmedCount: count('CONFIRMED'),
      suggestedCount: count('SUGGESTED'),
      unmatchedCount: count('UNMATCHED'),
    },
  };
}

/**
 * `period.close` — writes the `period_locks` row. From then on every executor
 * that touches a bank line, a document's coding or a release dated inside the
 * month refuses (`period-lock.ts`). Idempotent: an already-closed month is a
 * replay. Tier 1 — the firm's principal signs a close.
 */
export const periodCloseExecutor: ProposalExecutor<'period.close', PeriodClosePayload> = {
  kind: 'period.close',

  async execute(db: ScopedClient, input: ExecutionInput<PeriodClosePayload>): Promise<ExecutionResult> {
    const { payload, proposalId, ctx } = input;
    const business = await db.business.findUnique({ where: { id: payload.businessId }, select: { id: true } });
    if (business === null) throw new ProposalExecutionRefused('period.close', 'no client with that id');
    const { start, end } = monthBounds(payload.period);
    const existing = await db.periodLock.findUnique({
      where: { businessId_periodStart: { businessId: payload.businessId, periodStart: start } },
      select: { id: true },
    });
    if (existing !== null) {
      return { changed: [{ entity: 'business', id: payload.businessId }], alreadyApplied: true, followUps: [] };
    }
    await db.periodLock.create({
      data: {
        businessId: payload.businessId,
        periodStart: start,
        periodEnd: end,
        closedByUserId: ctx.actorId,
        actionProposalId: proposalId,
      },
    });
    return {
      changed: [{ entity: 'business', id: payload.businessId }],
      alreadyApplied: false,
      followUps: [],
      detail: { period: payload.period, closed: true },
    };
  },
};

/** `period.reopen` — removes the lock. The proposal row is the record of it. */
export const periodReopenExecutor: ProposalExecutor<'period.reopen', PeriodReopenPayload> = {
  kind: 'period.reopen',

  async execute(db: ScopedClient, input: ExecutionInput<PeriodReopenPayload>): Promise<ExecutionResult> {
    const { payload } = input;
    const business = await db.business.findUnique({ where: { id: payload.businessId }, select: { id: true } });
    if (business === null) throw new ProposalExecutionRefused('period.reopen', 'no client with that id');
    const { start } = monthBounds(payload.period);
    const removed = await db.periodLock.deleteMany({ where: { businessId: payload.businessId, periodStart: start } });
    return {
      changed: [{ entity: 'business', id: payload.businessId }],
      alreadyApplied: removed.count === 0,
      followUps: [],
      detail: { period: payload.period, closed: false },
    };
  },
};
