import type { ReprocessPayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { transitionDocument } from '../document-state.js';
import { resolveProcessedState } from '../readiness.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * The states a reprocess accepts — exactly the two the read surface marks
 * `retryable`.
 *
 * `common/documents/document-response.ts` derives
 * `retryable = state === 'REJECTED' || state === 'FAILED'` and its comment says
 * *"a retry is offered only for a document the Rejected/Failed view shows, and
 * retrying is itself a `document.reprocess` proposal"*. So the affordance and the
 * effect are the same set by construction: every document the UI offers Retry on
 * is one this executor accepts, and there is no document it offers Retry on that
 * this refuses.
 */
const RETRYABLE_STATES = ['REJECTED', 'FAILED'] as const;

/** The house batch ceiling, matching the contract's own `maxItems: 500`. */
const MAX_REPROCESS_BATCH = 500;

/**
 * `document.reprocess` — the Retry button behind the Rejected/Failed view
 * (stage A12; one of issue #81's four holes).
 *
 * Until this landed the kind was registered, contracted, rendered and unbuilt:
 * `select-extractor.ts`, `demo-extractor.ts`, `bedrock-extractor.ts`,
 * `prisma-upload-sanitisation.ts` and `ingest-processor.ts` all tell the user
 * their failed document is *"retryable through a reprocess proposal"*, and
 * `documents.service.ts` refuses to grow a `POST /documents/{id}/retry` because
 * this is where retry belongs. Approving one threw
 * `ProposalNotImplementedError`, so a document that failed extraction sat on the
 * Rejected/Failed surface for ever.
 *
 * ## What one approval does
 *
 * Per document, inside the engine's open transaction:
 *
 * 1. **REJECTED|FAILED → PROCESSING.** PROCESSING is the machine's only exit
 *    from either failure state, and the only edge that CLEARS
 *    `failure_code`/`failure_message` — `document-state.ts` already does that
 *    and this executor relies on it rather than writing null itself. A document
 *    being retried must not still carry why its last attempt failed.
 * 2. **PROCESSING → READY | TO_REVIEW**, decided by `resolveProcessedState` over
 *    the document's own header fields. So a document rejected by a human with
 *    good coding returns to READY (reject → reprocess is a clean undo), and one
 *    whose extraction never landed returns to TO_REVIEW with its missing fields
 *    named — in front of a human, in the queue humans work, instead of parked in
 *    a failure state nobody can act on.
 *
 * That two-step is the same edge `publish-batch.ts`'s `admitForRelease` takes
 * for a release retry, which its own TODO asked for: *"the REJECTED → PROCESSING
 * → READY re-arm written there is the same edge, and when the reprocess executor
 * lands the two should not be two implementations of it."* They are not two
 * implementations of the legality or of the reason-clearing — both go through
 * `transitionDocument`, which owns both. They stay two call sites because
 * `admitForRelease` additionally demands a prior FAILED `publishes` row (a
 * release retry is a narrower thing than a retry) and lands on READY
 * unconditionally, which is only correct because the batch already proved the
 * publish minimum.
 *
 * ## ⚠ What it deliberately does NOT do: re-run the extractor
 *
 * **The document is re-armed and re-evaluated; the bytes are not read again.**
 * That is a real limitation, it is stated on the review card a human approves
 * (`approvals/render-summary.ts` renders it in words), and it is not something
 * this stage could honestly fix:
 *
 * - re-reading means enqueuing an ingest job, and the queue producer
 *   (`INGEST_QUEUE`, `ingestion-routing/queue/`) is not on that module's public
 *   seam — growing it is a boundary decision in a lane this stage does not own;
 * - an executor may not make an external call anyway. It runs inside the
 *   engine's transaction, and *an external call must never hold a tenant
 *   transaction open* (`proposal-executor.ts`'s `FollowUp` header). The correct
 *   shape is a post-commit follow-up that enqueues — one BullMQ push, not a
 *   500-document synchronous Bedrock loop on the approve request.
 *
 * `PrismaExtractionStep.begin()` already treats a PROCESSING document as
 * re-entrant, so the day that enqueue exists this executor needs no change: the
 * job it dispatches will find exactly the state this leaves behind. Recorded in
 * `validation-dedupe/CLAUDE.md` as the follow-up, with the seam it needs named.
 *
 * `fromStage` is carried onto the event and the outcome rather than honoured,
 * for the same reason — *"re-run from this stage onward"* is a statement about a
 * pipeline this executor cannot start. It is recorded, never silently dropped.
 *
 * Batched (1..500), all-or-nothing, and idempotent in the only sense available:
 * the engine consumes a proposal exactly once, and a document no longer in a
 * retryable state refuses rather than round-tripping a second time.
 */
export const reprocessDocumentExecutor: ProposalExecutor<'document.reprocess', ReprocessPayload> = {
  kind: 'document.reprocess',

  async execute(db: ScopedClient, input: ExecutionInput<ReprocessPayload>): Promise<ExecutionResult> {
    const { payload, traceId, proposalId } = input;

    if (payload.documentIds.length > MAX_REPROCESS_BATCH) {
      throw new ProposalExecutionRefused(
        'document.reprocess',
        `a retry batch is limited to ${MAX_REPROCESS_BATCH} documents — split it and propose again`,
      );
    }

    const documents = await db.document.findMany({
      where: { id: { in: [...payload.documentIds] } },
      select: { id: true, state: true, totalPence: true, supplierName: true, categoryCode: true },
    });
    // All-or-nothing (the archive rule): an id RLS cannot see and an id that
    // does not exist are the same refusal, and neither confirms existence.
    if (documents.length !== payload.documentIds.length) {
      throw new ProposalExecutionRefused('document.reprocess', 'one or more documents are not reachable');
    }

    const fromStage = payload.fromStage ?? null;
    const detail = {
      proposalId,
      via: 'reprocess',
      ...(fromStage === null ? {} : { fromStage }),
    };

    let ready = 0;
    let toReview = 0;
    const changed: { entity: 'document'; id: string }[] = [];

    for (const document of documents) {
      changed.push({ entity: 'document', id: document.id });

      if (!isRetryable(document.state)) {
        // Named states, not "illegal transition": TO_REVIEW and READY are legal
        // moves to PROCESSING in the machine, but retrying a document that never
        // failed is not what the button means, and it would cost two state events
        // and a readiness re-decision for nothing. PUBLISHED and ARCHIVED cannot
        // reach PROCESSING at all.
        throw new ProposalExecutionRefused(
          'document.reprocess',
          `a ${document.state.toLowerCase()} document cannot be retried — only one on the Rejected/Failed surface can`,
        );
      }

      // Step 1: back to PROCESSING. The machine clears the failure reason on
      // this edge — the retried document must not still carry why it failed.
      await transitionDocument(db, document, { to: 'PROCESSING', traceId, detail });

      // Step 2: land it where readiness says, from the header fields as they
      // stand. `resolveProcessedState` is the ONE place that choice is made, so
      // this cannot disagree with the pipeline or with the unarchive restore.
      const target = resolveProcessedState(document);
      await transitionDocument(db, { id: document.id, state: 'PROCESSING' }, { to: target, traceId, detail });
      if (target === 'READY') ready += 1;
      else toReview += 1;
    }

    return {
      changed,
      alreadyApplied: false,
      followUps: [],
      detail: {
        retried: documents.length,
        ready,
        toReview,
        // Stored in the outcome so the audit says what happened rather than what
        // the button is called. See the header: the bytes were not read again.
        extractionRerun: false,
        ...(fromStage === null ? {} : { fromStage }),
      },
    };
  },
};

function isRetryable(state: string): boolean {
  return (RETRYABLE_STATES as readonly string[]).includes(state);
}
