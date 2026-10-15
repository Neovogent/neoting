import { createHash } from 'node:crypto';

import type { BankCashCodePayload } from '@neoting/contracts/model';
import type { Prisma } from '@prisma/client';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { transitionDocument } from '../document-state.js';
import { resolveProcessedState } from '../readiness.js';
import { assertPeriodsOpen } from './period-lock.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';
import type { ChartCategoriesReader } from './validate-update-coding.js';

/**
 * `bank.cash-code` at CREATION: the line must be reachable and the category
 * must be EXACTLY a code on the client's chart — the update-coding rule
 * (refuse, never fuzzy-match), applied to the cost item this will create. An
 * unreadable chart skips the check rather than deadlocking coding.
 */
export async function assertCashCodeAllowed(
  db: ScopedClient,
  payload: BankCashCodePayload,
  readChartCategories?: ChartCategoriesReader,
): Promise<void> {
  const txn = await db.bankTransaction.findUnique({ where: { id: payload.transactionId }, select: { businessId: true } });
  if (txn === null) throw new ProposalExecutionRefused('bank.cash-code', 'no bank transaction with that id');
  if (readChartCategories === undefined) return;
  const categories = await readChartCategories(db, txn.businessId);
  if (categories === null || categories.some((c) => c.code === payload.categoryCode)) return;
  throw new ProposalExecutionRefused('bank.cash-code', `"${payload.categoryCode}" is not a category on this client's chart of accounts`);
}

/**
 * `bank.cash-code` — cash coding (SoT §4 Stage 7): an unmatched bank line
 * becomes a cost item that enters the same pipeline as an uploaded one.
 *
 * In one transaction: a Document with NO file (keyed by the accountant — the
 * provenance says so on the row and on its human extraction), totalled at the
 * line's absolute amount and dated on its booked date; driven RECEIVED →
 * PROCESSING → READY|TO_REVIEW through the state machine by the ordinary
 * readiness rule; then a CONFIRMED match allocating the whole line to it, and
 * the line flipped to CONFIRMED so it leaves the chase set. Matching still
 * never creates a transaction — this creates the DOCUMENT.
 *
 * ⚠ The document has no stored object behind `s3Key`; opening "the original"
 * of a cash-coded item has nothing to show, and the review card says so.
 */
export const cashCodeExecutor: ProposalExecutor<'bank.cash-code', BankCashCodePayload> = {
  kind: 'bank.cash-code',

  async execute(db: ScopedClient, input: ExecutionInput<BankCashCodePayload>): Promise<ExecutionResult> {
    const { payload, traceId, proposalId, ctx } = input;
    const refuse = (message: string): never => {
      throw new ProposalExecutionRefused('bank.cash-code', message);
    };

    const txn = await db.bankTransaction.findUnique({
      where: { id: payload.transactionId },
      select: { id: true, businessId: true, amountPence: true, bookedAt: true, matchState: true, currency: true, descriptionRaw: true },
    });
    if (txn === null) return refuse('no bank transaction with that id');
    await assertPeriodsOpen(db, 'bank.cash-code', txn.businessId, [txn.bookedAt]);

    const byteHash = createHash('sha256').update(`cash-code:${txn.id}`).digest('hex');
    // Idempotent replay: the cost item this line was cash-coded into.
    const prior = await db.document.findFirst({ where: { businessId: txn.businessId, byteHash }, select: { id: true } });
    if (prior !== null && txn.matchState === 'CONFIRMED') {
      return { changed: [{ entity: 'document', id: prior.id }], alreadyApplied: true, followUps: [] };
    }
    if (txn.matchState === 'CONFIRMED') refuse('that line is already matched — unmatch it before cash coding it');
    if (txn.amountPence === 0) refuse('a zero-value line has nothing to cash code');

    const business = await db.business.findUnique({ where: { id: txn.businessId }, select: { practiceId: true } });
    if (business === null) return refuse('the client of that line is not reachable');

    const moneyOut = txn.amountPence < 0;
    const totalPence = Math.abs(txn.amountPence);
    const documentDate = new Date(Date.UTC(txn.bookedAt.getUTCFullYear(), txn.bookedAt.getUTCMonth(), txn.bookedAt.getUTCDate()));
    const header = {
      docType: 'RECEIPT' as const,
      supplierName: payload.supplierName.trim(),
      ...(moneyOut ? {} : { customerName: payload.supplierName.trim() }),
      documentDate,
      currency: txn.currency,
      totalPence,
      taxPence: payload.taxPence ?? null,
      categoryCode: payload.categoryCode,
      description: payload.description ?? txn.descriptionRaw,
    };

    const document = await db.document.create({
      data: {
        practiceId: business.practiceId,
        businessId: txn.businessId,
        s3Key: `cash-coded/${txn.id}`,
        originalFilename: `Cash coded — ${header.supplierName}`.slice(0, 200),
        mimeType: 'application/x-neoting-cash-code',
        byteSize: 0,
        byteHash,
        channel: 'WEB_UPLOAD',
        submitterUserId: ctx.actorId,
        submitterLabel: 'Cash coded from a bank line',
        inbox: moneyOut ? 'COSTS' : 'SALES',
        state: 'RECEIVED',
        ...header,
      },
      select: { id: true, state: true },
    });

    const human = (value: string | number | null) => ({
      value,
      provenance: 'HUMAN_CONFIRMED',
      confidence: null,
      source: `proposal:${proposalId}`,
      wasCorrected: false,
    });
    await db.extraction.create({
      data: {
        documentId: document.id,
        fields: {
          docType: human(header.docType),
          supplierName: human(header.supplierName),
          documentDate: human(documentDate.toISOString().slice(0, 10)),
          currency: human(header.currency),
          totalPence: human(totalPence),
          taxPence: human(header.taxPence),
          categoryCode: human(header.categoryCode),
          description: human(header.description),
        } as Prisma.InputJsonObject,
        extractorKind: 'human',
        isAccepted: true,
        keyedByUserId: ctx.actorId,
      },
    });

    await transitionDocument(db, document, { to: 'PROCESSING', traceId, detail: { proposalId, via: 'cash-code' } });
    const to = resolveProcessedState(header);
    await transitionDocument(db, { id: document.id, state: 'PROCESSING' }, { to, traceId, detail: { proposalId, via: 'cash-code' } });

    // Any pending suggestion on the line is answered by this.
    await db.match.updateMany({
      where: { transactionId: txn.id, state: 'SUGGESTED', unmatchedAt: null },
      data: { state: 'UNMATCHED', unmatchedAt: new Date() },
    });
    await db.match.create({
      data: {
        businessId: txn.businessId,
        documentId: document.id,
        transactionId: txn.id,
        kind: 'EXACT',
        confidence: null,
        state: 'CONFIRMED',
        allocatedPence: txn.amountPence,
        matchedByUserId: ctx.actorId,
        matchedBy: 'cash-code',
      },
    });
    await db.bankTransaction.update({ where: { id: txn.id }, data: { matchState: 'CONFIRMED' } });
    await db.documentEvent.create({
      data: {
        documentId: document.id,
        stage: 'cash-code',
        outcome: 'created',
        traceId,
        detail: { proposalId, transactionId: txn.id, state: to },
      },
    });

    return {
      changed: [{ entity: 'document', id: document.id }],
      alreadyApplied: false,
      followUps: [],
      detail: { documentId: document.id, transactionId: txn.id, state: to },
    };
  },
};
