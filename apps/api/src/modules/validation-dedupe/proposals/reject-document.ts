import type { RejectPayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { isLegalTransition, transitionDocument } from '../document-state.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * The failure code a HUMAN rejection carries (stage A12).
 *
 * Every other writer of `documents.failure_code` names a subsystem that failed:
 * `NT-ING-004` (sanitisation refused the bytes), `NT-EXT-001` (extraction could
 * not read it). A person deciding *"this is not a document for these books"* is
 * not a subsystem failure, and borrowing one of those codes would tell the
 * Rejected/Failed surface — and anyone reading a runbook — that the pipeline
 * broke on a document it read perfectly.
 *
 * So this is a new family: `DOC`, document-lifecycle decisions taken by a human.
 * Its runbook entry is in `docs/runbooks/error-codes.md`, which Governance §13.4
 * requires before a new code passes review. Note what it is NOT: it is not an
 * `ErrorCode` from the contract enum and never reaches the wire as one —
 * `Document.failureCode` is a free `string` in `openapi.yaml`, which is what
 * makes this a documentation decision rather than a LAW change.
 */
export const HUMAN_REJECTION_CODE = 'NT-DOC-001';

/**
 * The batch ceiling this executor applies, and the reason it is written here
 * rather than in the contract.
 *
 * ⚠ `RejectPayload` declares `minItems: 1` and **no `maxItems`**, while every
 * sibling batch payload (`ArchivePayload`, `ReprocessPayload`) declares 500. An
 * all-or-nothing effect holds row locks on every document it touches for the
 * life of the engine's transaction, so an unbounded list is the unbounded load
 * Governance §5.1 forbids — and `scopedDb`'s 10 s transaction timeout would turn
 * it into a 500 rather than a refusal. The house number is applied here and the
 * gap is recorded for a contract change (see `validation-dedupe/CLAUDE.md`).
 */
export const MAX_REJECT_BATCH = 500;

/**
 * `document.reject` — a human marking a document as one these books should not
 * carry (stage A12; the last of issue #81's holes but `document.split` and
 * `document.move-business`).
 *
 * Rejecting is an ordinary day-one act: a personal receipt in the business pile,
 * a supplier statement mistaken for an invoice, a duplicate somebody photographed
 * twice. Until this executor existed the kind was registered, contracted and
 * unbuilt, so the only way out of the inbox was `document.archive` — which says
 * *"filed"*, not *"wrong"*, and which the Rejected view cannot show.
 *
 * **The reason is the whole point.** `document-state.ts` makes REJECTED
 * unreachable without `{ code, message }` in the type system, and the contract
 * says the reason is *"surfaced verbatim in the Rejected view. A rejection
 * without a reason is not a rejection."* The payload's `reason` is stored
 * verbatim as `failure_message`, exactly as `chase.send` stores the composed SMS
 * verbatim: the human wrote it at proposal time, the reviewer read it, and
 * nothing here rewrites it.
 *
 * **Reversible, which is why it is not a release.** A rejected document goes
 * back through `document.reprocess`, which clears the reason and re-evaluates
 * readiness. That is the test A12's `RELEASE_KINDS` map applies — an
 * irreversible outward act needs the super admin; an internal decision a
 * colleague can undo is D44's compose-and-edit half, and any member may approve
 * it.
 *
 * Batched and **all-or-nothing**, like archive: an id RLS cannot see and an id
 * that does not exist are the same refusal, and a batch that silently skipped
 * either would report success over a hole. Idempotent per document — one already
 * REJECTED is skipped with no second event and no overwritten reason (the FIRST
 * rejection's words are the record).
 */
export const rejectDocumentExecutor: ProposalExecutor<'document.reject', RejectPayload> = {
  kind: 'document.reject',

  async execute(db: ScopedClient, input: ExecutionInput<RejectPayload>): Promise<ExecutionResult> {
    const { payload, traceId, proposalId } = input;

    if (payload.documentIds.length > MAX_REJECT_BATCH) {
      throw new ProposalExecutionRefused(
        'document.reject',
        `a rejection batch is limited to ${MAX_REJECT_BATCH} documents — split it and propose again`,
      );
    }

    const documents = await db.document.findMany({
      where: { id: { in: [...payload.documentIds] } },
      select: { id: true, state: true },
    });
    if (documents.length !== payload.documentIds.length) {
      throw new ProposalExecutionRefused('document.reject', 'one or more documents are not reachable');
    }

    let applied = 0;
    const changed: { entity: 'document'; id: string }[] = [];

    for (const document of documents) {
      changed.push({ entity: 'document', id: document.id });

      // Idempotent replay: the first rejection's reason stands. Overwriting it
      // with a second proposal's words would edit the record rather than add to
      // it, and the event log already carries both proposals.
      if (document.state === 'REJECTED') continue;

      // ⚠ ARCHIVED → REJECTED is LEGAL in `LEGAL_TRANSITIONS`, and this executor
      // still refuses it. That edge exists for the UNARCHIVE restore (a document
      // archived while rejected comes back as rejected, #81's ruling), and taking
      // it from here would also clear `archived_at` — silently unarchiving a
      // document as a side effect of rejecting it. Two acts, two proposals.
      if (document.state === 'ARCHIVED') {
        throw new ProposalExecutionRefused(
          'document.reject',
          'an archived document cannot be rejected — restore it from the archive first, then reject it',
        );
      }

      // Everything else defers to the ONE legality table rather than restating
      // it: PUBLISHED (already released for export) and FAILED (the pipeline's
      // own verdict, which a human overrides by reprocessing, not by rejecting)
      // are refused because the machine says so, and a future edit to
      // `LEGAL_TRANSITIONS` moves this refusal with it.
      if (!isLegalTransition(document.state, 'REJECTED')) {
        throw new ProposalExecutionRefused(
          'document.reject',
          `a ${document.state.toLowerCase()} document cannot be rejected`,
        );
      }

      await transitionDocument(db, document, {
        to: 'REJECTED',
        failure: { code: HUMAN_REJECTION_CODE, message: payload.reason },
        traceId,
        detail: { proposalId, via: 'reject' },
      });
      applied += 1;
    }

    return {
      changed,
      alreadyApplied: applied === 0,
      followUps: [],
      detail: { rejected: applied, skippedAlreadyRejected: documents.length - applied, code: HUMAN_REJECTION_CODE },
    };
  },
};
