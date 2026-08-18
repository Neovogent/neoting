import type { BankConfirmMatchPayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
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

    // RLS decides visibility on both rows: an invisible record and an absent
    // one are the same refusal, so neither answer confirms existence
    // (404-never-403, the house rule, applied to effects).
    const transaction = await db.bankTransaction.findUnique({
      where: { id: payload.transactionId },
      select: { id: true, businessId: true, matchState: true },
    });
    if (transaction === null) {
      throw new ProposalExecutionRefused('bank.confirm-match', 'no bank transaction with that id');
    }

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
        'that transaction is already matched to another document — breaking a confirmed match has no approved path yet',
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
