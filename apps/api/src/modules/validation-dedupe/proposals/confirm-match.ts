import type { BankConfirmMatchPayload, MatchAllocation } from '@neoting/contracts/model';

import { expectedDirection, settle } from '../../../common/banking/allocation.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { notDeleted } from '../../../common/documents/deleted-documents.js';
import { formatGbp } from '../../chase/index.js';
import { assertPeriodsOpen } from './period-lock.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * `bank.confirm-match` — a human confirms that a document is the evidence for a
 * bank transaction (METH Stage 11, SoT §4 Stage 7).
 *
 * Two rows move, atomically, in the engine's transaction: the `matches` row
 * (document ↔ transaction, kind, confidence) and the transaction's
 * `match_state`. **Both, always.** Writing the match without flipping the state
 * would leave the line in the unmatched set that chase detection reads, and the
 * client would be chased by SMS for a receipt the accountant just filed —
 * which is precisely the disagreement the contract forbids ("the unmatched set
 * this returns is the same set chase detection reads").
 *
 * What this executor deliberately does NOT do:
 *
 * - **It never touches money.** `amount_pence` is not read, compared or
 *   written. The suggestion arithmetic that proposed this pairing is
 *   display-tier float-pounds in `apps/web/src/lib/matching.ts`; nothing here
 *   trusts it, and no tolerance is applied server-side. The human's approval
 *   is the decision (Governance §9.5), which is what makes a display-tier
 *   suggester acceptable at all.
 * - **`confidence` never gates.** It is recorded for display and triage and is
 *   read by no branch below. A score is not an authorisation.
 * - **It does not change `DocumentState`.** Matching is evidence-linking, not a
 *   pipeline stage; the state machine (#80) is not involved.
 * - **It does not unmatch.** There is no `bank.unmatch` kind in the contract's
 *   `ProposalKind` enum, so breaking a confirmed match has no approved path
 *   yet and this refuses rather than quietly overwriting one.
 */
export const confirmMatchExecutor: ProposalExecutor<'bank.confirm-match', BankConfirmMatchPayload> = {
  kind: 'bank.confirm-match',

  async execute(db: ScopedClient, input: ExecutionInput<BankConfirmMatchPayload>): Promise<ExecutionResult> {
    const { payload, traceId, proposalId, ctx } = input;

    // rush/matching: many-to-many with amounts (partial/batch payments,
    // credit-note netting). The one-to-one path below is unchanged.
    if (payload.allocations !== undefined && payload.allocations.length > 0) {
      return executeAllocations(db, input);
    }

    // RLS decides visibility on both rows: an invisible record and an absent
    // one are the same refusal, so neither answer confirms existence
    // (404-never-403, the house rule, applied to effects).
    const transaction = await db.bankTransaction.findUnique({
      where: { id: payload.transactionId },
      select: { id: true, businessId: true, matchState: true, bookedAt: true },
    });
    if (transaction === null) {
      throw new ProposalExecutionRefused('bank.confirm-match', 'no bank transaction with that id');
    }
    await assertPeriodsOpen(db, 'bank.confirm-match', transaction.businessId, [transaction.bookedAt]);

    const document = await db.document.findUnique({
      where: { id: payload.documentId },
      select: { id: true, businessId: true, state: true },
    });
    if (document === null) {
      throw new ProposalExecutionRefused('bank.confirm-match', 'no document with that id');
    }

    // Both rows are individually visible, which does NOT mean they belong to
    // the same client: a practice-scoped approver can see every workspace it
    // administers, so RLS alone would happily let one client's receipt become
    // the evidence for another client's bank line. `matches.business_id` can
    // only hold one of the two, and the wrong one is a tenancy leak with a
    // foreign key holding it in place.
    if (document.businessId !== transaction.businessId) {
      throw new ProposalExecutionRefused(
        'bank.confirm-match',
        'the document and the transaction belong to different clients — a match cannot cross a workspace',
      );
    }

    // An archived or rejected document is not evidence for anything: the first
    // is out of the working set by decision, the second was refused on the way
    // in. Matching either would put a line into CONFIRMED — out of chase
    // detection, into the reconciled column — backed by paperwork nobody
    // stands behind.
    if (document.state === 'ARCHIVED' || document.state === 'REJECTED') {
      throw new ProposalExecutionRefused(
        'bank.confirm-match',
        `a ${document.state.toLowerCase()} document cannot be the evidence for a transaction`,
      );
    }

    // Every match row already on this transaction. The seed (and, later, an
    // automatic suggester) writes SUGGESTED rows, so the common demo path is a
    // PROMOTION of an existing row rather than an insert — `matches` has no
    // unique constraint on (document_id, transaction_id), so a blind create
    // would leave two rows for one pairing and the Matches list would show the
    // same match twice with no way to tell which one is live.
    const existing = await db.match.findMany({
      where: { transactionId: transaction.id },
      select: { id: true, documentId: true, state: true },
    });

    const confirmedElsewhere = existing.find(
      (match) => match.state === 'CONFIRMED' && match.documentId !== document.id,
    );
    if (confirmedElsewhere !== undefined) {
      throw new ProposalExecutionRefused(
        'bank.confirm-match',
        'that transaction is already matched to another document — unmatch it first (bank.unmatch)',
      );
    }

    const forThisDocument = existing.find((match) => match.documentId === document.id);

    // Idempotent replay: the engine may retry after a crash between the effect
    // and the record. Finding the effect already applied is a success that
    // writes nothing — no second match row, no second event.
    if (forThisDocument?.state === 'CONFIRMED' && transaction.matchState === 'CONFIRMED') {
      return {
        changed: [{ entity: 'document', id: document.id }],
        alreadyApplied: true,
        followUps: [],
      };
    }

    const confidence = payload.confidence ?? null;

    const matchId =
      forThisDocument === undefined
        ? (
            await db.match.create({
              data: {
                businessId: transaction.businessId,
                documentId: document.id,
                transactionId: transaction.id,
                kind: payload.matchKind,
                confidence,
                state: 'CONFIRMED',
                // Who confirmed it, and that a human did — the two questions
                // asked of a match six months later. `matchedBy` records the
                // mechanism; an automatic suggester writes 'ai' here, and this
                // path can only ever be 'human' because it runs behind Approve.
                matchedByUserId: ctx.actorId,
                matchedBy: 'human',
                // A confirmed match is not unmatched, and `unmatched_at` from a
                // previous life would be a lie — but only the create path can
                // leave it null by default; see the update below.
              },
              select: { id: true },
            })
          ).id
        : (
            await db.match.update({
              where: { id: forThisDocument.id },
              data: {
                kind: payload.matchKind,
                confidence,
                state: 'CONFIRMED',
                matchedByUserId: ctx.actorId,
                matchedBy: 'human',
                // Cleared on promotion: a row that was broken once and is now
                // confirmed again must not carry the timestamp of when it was
                // broken, or "when did this stop being matched" answers with a
                // date that is in the past of a live match.
                unmatchedAt: null,
              },
              select: { id: true },
            })
          ).id;

    // The half that makes the Bank screen and the chase list agree. Written
    // unconditionally rather than guarded on the current value: the replay
    // branch above already returned for the fully-applied case, so reaching
    // here with `CONFIRMED` means the match row was NOT confirmed — a
    // half-applied state that this write completes rather than skips.
    await db.bankTransaction.update({
      where: { id: transaction.id },
      data: { matchState: 'CONFIRMED' },
    });

    // The processing log is the audit surface for the document, and "this is
    // the receipt for that bank line" is a fact about the document that a
    // reader six months later needs without joining three tables.
    await db.documentEvent.create({
      data: {
        documentId: document.id,
        stage: 'match',
        outcome: 'confirmed',
        traceId,
        detail: {
          proposalId,
          matchId,
          transactionId: transaction.id,
          matchKind: payload.matchKind,
          promoted: forThisDocument !== undefined,
          ...(confidence === null ? {} : { confidence }),
        },
      },
    });

    return {
      changed: [{ entity: 'document', id: document.id }],
      alreadyApplied: false,
      followUps: [],
      detail: {
        matchId,
        transactionId: transaction.id,
        matchKind: payload.matchKind,
        fromMatchState: transaction.matchState,
      },
    };
  },
};

const pairKey = (a: { transactionId: string; documentId: string }): string => `${a.transactionId}:${a.documentId}`;

function refuse(message: string): never {
  throw new ProposalExecutionRefused('bank.confirm-match', message);
}

/**
 * The many-to-many confirmation (rush/matching). Every allocation becomes one
 * CONFIRMED `matches` row carrying its signed pence; every named line ends
 * fully explained — its confirmed allocations sum EXACTLY to its amount — and
 * flips to CONFIRMED; no document is paid (or refunded) past its gross. All of
 * it in the engine's one transaction, so a refusal anywhere writes nothing.
 * Money is compared in integer pence and never rounded.
 */
async function executeAllocations(
  db: ScopedClient,
  input: ExecutionInput<BankConfirmMatchPayload>,
): Promise<ExecutionResult> {
  const { payload, traceId, proposalId, ctx } = input;
  const allocations: readonly MatchAllocation[] = payload.allocations ?? [];

  const named = new Set<string>();
  for (const a of allocations) {
    if (!Number.isSafeInteger(a.amountPence) || a.amountPence === 0) refuse('an allocation must be a non-zero whole number of pence');
    if (named.has(pairKey(a))) refuse('a document is allocated twice against the same bank line');
    named.add(pairKey(a));
  }
  if (!named.has(pairKey(payload))) refuse('the named transaction and document must be one of the allocations');

  const txnIds = [...new Set(allocations.map((a) => a.transactionId))];
  const docIds = [...new Set(allocations.map((a) => a.documentId))];
  const transactions = await db.bankTransaction.findMany({
    where: { id: { in: txnIds } },
    select: { id: true, businessId: true, amountPence: true, bookedAt: true, matchState: true },
  });
  if (transactions.length !== txnIds.length) refuse('a bank transaction in the allocation is not reachable');
  const documents = await db.document.findMany({
    where: { id: { in: docIds }, ...notDeleted() },
    select: { id: true, businessId: true, state: true, inbox: true, docType: true, totalPence: true },
  });
  if (documents.length !== docIds.length) refuse('a document in the allocation is not reachable');

  const businessId = transactions[0]!.businessId;
  if (transactions.some((t) => t.businessId !== businessId) || documents.some((d) => d.businessId !== businessId)) {
    refuse('the documents and the transactions belong to different clients — a match cannot cross a workspace');
  }
  for (const d of documents) {
    if (d.state === 'ARCHIVED' || d.state === 'REJECTED') refuse(`a ${d.state.toLowerCase()} document cannot be the evidence for a transaction`);
    if (d.totalPence === null || d.totalPence === 0) refuse('a document with no total cannot carry an allocation — correct its total first');
  }
  await assertPeriodsOpen(db, 'bank.confirm-match', businessId, transactions.map((t) => t.bookedAt));

  const live = await db.match.findMany({
    where: { unmatchedAt: null, OR: [{ transactionId: { in: txnIds } }, { documentId: { in: docIds } }] },
    select: { id: true, transactionId: true, documentId: true, state: true, allocatedPence: true },
  });

  // Idempotent replay: every allocation already confirmed at the same amount.
  const confirmed = live.filter((m) => m.state === 'CONFIRMED');
  const confirmedByPair = new Map(confirmed.map((m) => [pairKey(m), m]));
  if (
    allocations.every((a) => confirmedByPair.get(pairKey(a))?.allocatedPence === a.amountPence) &&
    transactions.every((t) => t.matchState === 'CONFIRMED')
  ) {
    return { changed: docIds.map((id) => ({ entity: 'document' as const, id })), alreadyApplied: true, followUps: [] };
  }

  for (const t of transactions) {
    const others = confirmed.filter((m) => m.transactionId === t.id && !named.has(pairKey(m)));
    if (others.some((m) => m.allocatedPence === null)) refuse('that bank line is already matched in full — unmatch it first');
    const sum =
      others.reduce((n, m) => n + (m.allocatedPence ?? 0), 0) +
      allocations.filter((a) => a.transactionId === t.id).reduce((n, a) => n + a.amountPence, 0);
    if (sum !== t.amountPence) {
      refuse(
        `allocations on a bank line must add up to exactly its amount — the line is ${t.amountPence < 0 ? '-' : '+'}${formatGbp(t.amountPence)}, ` +
          `the allocations come to ${sum < 0 ? '-' : '+'}${formatGbp(sum)}`,
      );
    }
  }
  const docById = new Map(documents.map((d) => [d.id, d]));
  for (const d of documents) {
    const amounts = [
      ...confirmed.filter((m) => m.documentId === d.id && !named.has(pairKey(m))).map((m) => m.allocatedPence),
      ...allocations.filter((a) => a.documentId === d.id).map((a) => a.amountPence),
    ];
    const s = settle(d, amounts);
    const gross = Math.abs(d.totalPence ?? 0);
    if (s.paidPence > gross) refuse(`that would pay a document more than its total of ${formatGbp(gross)}`);
    if (s.refundedPence > gross) refuse(`that would refund a document more than its total of ${formatGbp(gross)}`);
  }

  const confidence = payload.confidence ?? null;
  for (const a of allocations) {
    const doc = docById.get(a.documentId)!;
    // A credit note, or money moving against the document's direction (a
    // refund netted against its purchase), is a CREDIT_NOTE link whatever the
    // dialog called the batch.
    const kind = doc.docType === 'CREDIT_NOTE' || Math.sign(a.amountPence) !== expectedDirection(doc) ? 'CREDIT_NOTE' : payload.matchKind;
    const data = {
      kind,
      confidence,
      state: 'CONFIRMED' as const,
      allocatedPence: a.amountPence,
      matchedByUserId: ctx.actorId,
      matchedBy: 'human',
      unmatchedAt: null,
    };
    const existing = live.find((m) => pairKey(m) === pairKey(a));
    if (existing !== undefined) await db.match.update({ where: { id: existing.id }, data });
    else await db.match.create({ data: { ...data, businessId, documentId: a.documentId, transactionId: a.transactionId } });
  }

  // The lines are fully explained now, so any other pending suggestion on
  // them is a question already answered.
  await db.match.updateMany({
    where: { transactionId: { in: txnIds }, state: 'SUGGESTED', unmatchedAt: null },
    data: { state: 'UNMATCHED', unmatchedAt: new Date() },
  });
  await db.bankTransaction.updateMany({ where: { id: { in: txnIds } }, data: { matchState: 'CONFIRMED' } });

  for (const d of documents) {
    const mine = allocations.filter((a) => a.documentId === d.id);
    await db.documentEvent.create({
      data: {
        documentId: d.id,
        stage: 'match',
        outcome: 'confirmed',
        traceId,
        detail: {
          proposalId,
          matchKind: payload.matchKind,
          transactionIds: mine.map((a) => a.transactionId).join(','),
          allocatedPence: mine.reduce((n, a) => n + a.amountPence, 0),
        },
      },
    });
  }

  return {
    changed: docIds.map((id) => ({ entity: 'document' as const, id })),
    alreadyApplied: false,
    followUps: [],
    detail: { allocations: allocations.length, transactions: txnIds.length, documents: docIds.length },
  };
}
