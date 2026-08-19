import type { PublishBatchPayload } from '@neoting/contracts/model';
import type { DocumentState, IntegrationKind } from '@prisma/client';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import {
  type LedgerAdapter,
  PUBLISH_MINIMUM_CODE,
  type PublishItemRefusal,
  type PublishPreviewItem,
  type PublishPreviewOutcome,
} from '../../publishing/index.js';
import { transitionDocument } from '../document-state.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * `publish.batch` — the effect half of METH Stage 10 (SoT §4 Stage 10, §17.1).
 *
 * ⚠ THIS EXECUTOR DOES NOT TALK TO THE LEDGER. It re-validates, resolves the
 * integration and writes one `publishes` row per item in **`QUEUED`**, then
 * returns a `publish` follow-up; `publish-follow-up.ts` makes the vendor call
 * after the engine commits. **An external HTTP call must never hold a tenant
 * transaction open** — the reasoning, the 500-item arithmetic and the
 * alternative that was rejected are all written out in
 * `modules/publishing/CLAUDE.md`. If a future edit moves `publishBill` into
 * this function it will look tidier and will be wrong.
 *
 * What this function owns, all inside the engine's one transaction:
 *
 * - **Reachability.** Every `documentId` is resolved through RLS BEFORE
 *   anything is written. An id this approver cannot see and an id that does
 *   not exist are the SAME refusal, worded so neither confirms existence
 *   (404-never-403, applied to effects — the archive precedent).
 * - **The contract's mandated re-validation.** `PublishBatchPayload`'s own
 *   description: "Execution re-validates that each item still meets the
 *   minimum (Total + Supplier + Category); an item that no longer does refuses
 *   with `NT-PUB-001` rather than publishing half-coded books." The check is
 *   publishing's `previewPublishBatch`, injected (see {@link PublishGateway}),
 *   never re-stated here.
 * - **ALL-OR-NOTHING, deliberately.** One item short of the minimum refuses
 *   the whole batch. Two reasons, and the first is the contract's own verb:
 *   it says the execution *refuses* rather than publishing half-coded books,
 *   which is a statement about the batch, not about one row. The second is
 *   precedent: `archive-document.ts` is batched and all-or-nothing for the
 *   same reason — a partially applied approved action is worse than a refused
 *   one, because the human who pressed Approve saw one summary and got a
 *   different set of facts. Note the asymmetry, which is intentional: a
 *   VENDOR failure is per item (39 of 40 publish and item 12 lands on the
 *   Rejected/Failed surface with a reason) because by then the batch is
 *   approved and committed and refusing it retroactively is not a thing that
 *   exists. Pre-flight refuses the batch; post-commit fails the row.
 * - **The reviewed figures.** The payload carries the server-computed preview
 *   — that is what Read review rendered and what a human approved. If the
 *   live totals no longer agree (someone re-coded a document between propose
 *   and approve, itself through a proposal), the batch refuses: `NT-PRP-004`
 *   cannot catch this, because review is idempotent and the render is
 *   payload-pure, so this is the only place the drift is visible.
 * - **The retry edge.** Retry is a NEW proposal over the failed item (the
 *   contract: "the old attempt is never replayed and never deleted"), and the
 *   failed item is sitting in REJECTED with its reason. See
 *   {@link admitForPublish} for why that costs two transitions.
 * - **Idempotency.** `publishes.idempotency_key` is `<proposalId>:<documentId>`
 *   — globally unique per the schema, one row per item per proposal. A replay
 *   sees its own rows and returns `alreadyApplied` with no second row, no
 *   second follow-up and therefore no second vendor call.
 */

/**
 * Publishing, as this executor names it — a DEPENDENCY, not an import, and the
 * reason is mechanical rather than stylistic.
 *
 * `modules/publishing` imports `validation-dedupe/index.ts` (the publish
 * minimum IS the readiness rule, `evaluateReadiness`). A runtime import back
 * the other way would close a cycle between two public seams, which ESM
 * survives only for as long as nobody calls anything during module
 * evaluation — a trap laid for a future edit. So the SHAPES come in as
 * `import type` (erased, no cycle, one source of truth for the types) and the
 * FUNCTIONS are handed over by the composition root, exactly as the engine
 * hands `DedupeDetection` to the route follow-up.
 */
export interface PublishGateway {
  /** publishing's `LedgerAdapter`, config-selected. Called post-commit only. */
  readonly ledger: LedgerAdapter;
  /** publishing's `previewPublishBatch`: the minimum check AND the totals, one implementation. */
  previewPublishBatch(items: readonly PublishPreviewItem[]): PublishPreviewOutcome;
}

/**
 * `<proposalId>:<documentId>`. Globally unique because `publishes.idempotency_key`
 * is (the schema's `@@unique`, whose own comment is "Republishing must never
 * create a duplicate vendor or double-post a bill"), and one row per item per
 * proposal because that is what makes a replay a no-op and a RETRY — a new
 * proposal — a genuinely new attempt rather than a collision.
 */
export function publishIdempotencyKey(proposalId: string, documentId: string): string {
  return `${proposalId}:${documentId}`;
}

/** The document projection this executor and the follow-up both read. */
const DOCUMENT_SELECT = {
  id: true,
  state: true,
  businessId: true,
  supplierName: true,
  categoryCode: true,
  totalPence: true,
  taxPence: true,
} as const;

/**
 * The CREATION half of the contract's preview promise: "`preview` is computed
 * by the server at proposal time … and is exactly what Read review renders."
 * The engine calls this in `create()` before storing the payload, so the
 * figures a human reviews are the server's — whatever a caller sent in
 * `preview` is discarded and replaced. An item short of the publish minimum
 * refuses HERE with `NT-PUB-001` ("refusing at proposal time beats publishing
 * half-coded books"); the executor above re-runs the same check at approve
 * time, which is what catches facts that moved between review and approval.
 */
export async function computePublishBatchPayload(
  db: ScopedClient,
  publishing: PublishGateway,
  payload: PublishBatchPayload,
): Promise<PublishBatchPayload> {
  const documents = await db.document.findMany({
    where: { id: { in: [...payload.documentIds] } },
    select: DOCUMENT_SELECT,
  });
  // Same refusal for unreachable, absent and named-twice (404-never-403): a
  // preview over a partial batch would show a human smaller figures than the
  // batch claims to contain.
  if (documents.length !== payload.documentIds.length) {
    throw new ProposalExecutionRefused('publish.batch', 'one or more documents are not reachable');
  }
  const outcome = publishing.previewPublishBatch(documents);
  if (!outcome.ok) {
    throw new ProposalExecutionRefused('publish.batch', minimumRefusal(outcome.refusals), PUBLISH_MINIMUM_CODE);
  }
  return { ...payload, preview: outcome.preview };
}

export function createPublishBatchExecutor(publishing: PublishGateway): ProposalExecutor<'publish.batch', PublishBatchPayload> {
  return {
    kind: 'publish.batch',

    async execute(db: ScopedClient, input: ExecutionInput<PublishBatchPayload>): Promise<ExecutionResult> {
      const { payload, ctx, proposalId, traceId } = input;

      // Replay first, before anything is read or written. The unique
      // idempotency key is the DURABLE guarantee (a race aborts the whole
      // transaction rather than double-posting, which is the correct
      // outcome); this read is what turns the ordinary retry into a quiet
      // no-op instead of a rolled-back error.
      const existing = await db.publish.findMany({
        where: { actionProposalId: proposalId },
        select: { documentId: true },
      });
      if (existing.length > 0) {
        return {
          changed: existing.map((row) => ({ entity: 'document' as const, id: row.documentId })),
          alreadyApplied: true,
          followUps: [],
          detail: { queued: 0, alreadyQueued: existing.length },
        };
      }

      const documents = await db.document.findMany({
        where: { id: { in: [...payload.documentIds] } },
        select: DOCUMENT_SELECT,
      });
      // Same refusal for unreachable, absent and named-twice: a batch that
      // silently skipped any of them would report success over a hole.
      if (documents.length !== payload.documentIds.length) {
        throw new ProposalExecutionRefused('publish.batch', 'one or more documents are not reachable');
      }

      // One batch, one business, one ledger connection. A batch spanning two
      // businesses has no single integration to publish through, and guessing
      // per item would post one client's bill into another's books.
      const businessId = documents[0]?.businessId ?? null;
      if (businessId === null) {
        throw new ProposalExecutionRefused('publish.batch', 'an unrouted document has no client books to publish into');
      }
      if (documents.some((document) => document.businessId !== businessId)) {
        throw new ProposalExecutionRefused('publish.batch', 'a publish batch belongs to one business — propose one batch per client');
      }

      // The contract's mandated re-validation, through publishing's own rule.
      const outcome = publishing.previewPublishBatch(documents);
      if (!outcome.ok) {
        // NT-PUB-001 travels as the Problem CODE, not just inside the prose: the
        // contract names it on this exact refusal so a client can branch on it.
        throw new ProposalExecutionRefused(
          'publish.batch',
          minimumRefusal(outcome.refusals),
          PUBLISH_MINIMUM_CODE,
        );
      }
      const preview = outcome.preview;
      if (
        preview.itemCount !== payload.preview.itemCount ||
        preview.grossPence !== payload.preview.grossPence ||
        preview.vatPence !== payload.preview.vatPence
      ) {
        throw new ProposalExecutionRefused(
          'publish.batch',
          `the batch no longer matches the figures that were reviewed (reviewed ${payload.preview.itemCount} items, gross ${payload.preview.grossPence}p, VAT ${payload.preview.vatPence}p; now ${preview.itemCount} items, gross ${preview.grossPence}p, VAT ${preview.vatPence}p) — propose the publish again so a human approves what would actually post`,
        );
      }

      const integration = await resolveIntegration(db, businessId, payload.integrationId ?? null);

      for (const document of documents) {
        await admitForPublish(db, document, { proposalId, traceId });
      }

      for (const document of documents) {
        await db.publish.create({
          data: {
            businessId,
            documentId: document.id,
            integrationId: integration.id,
            // MANUAL: a human read the review and pressed Approve. AUTO is the
            // rules lane and AI is the agent's own initiative; neither is what
            // just happened, and the column is how the demo tells them apart.
            mode: 'MANUAL',
            state: 'QUEUED',
            idempotencyKey: publishIdempotencyKey(proposalId, document.id),
            actionProposalId: proposalId,
            publishedByUserId: ctx.actorId,
          },
        });
      }

      return {
        changed: documents.map((document) => ({ entity: 'document' as const, id: document.id })),
        alreadyApplied: false,
        followUps: [{ kind: 'publish', proposalId, businessId }],
        detail: {
          queued: documents.length,
          integrationId: integration.id,
          integrationKind: integration.kind,
          grossPence: preview.grossPence,
          vatPence: preview.vatPence,
        },
      };
    },
  };
}

/** The refusal message for `NT-PUB-001`, naming every failing item and every missing field. */
function minimumRefusal(refusals: readonly PublishItemRefusal[]): string {
  // The code comes off the refusals themselves rather than a literal here:
  // publishing owns `NT-PUB-001` and this module must not be a second place
  // that claims to know it.
  const codes = [...new Set(refusals.map((refusal) => refusal.code))].join('/');
  const items = refusals.map((refusal) => `${refusal.documentId} (missing ${refusal.missing.join(', ')})`).join('; ');
  return `${codes} — ${refusals.length} item(s) no longer meet the publish minimum of total, supplier and category: ${items}. The whole batch is refused rather than publishing half-coded books.`;
}

/** The ledger connection, resolved through RLS. Never guessed, never null. */
async function resolveIntegration(
  db: ScopedClient,
  businessId: string,
  requested: string | null,
): Promise<{ id: string; kind: IntegrationKind; orgRef: string | null }> {
  if (requested !== null) {
    const row = await db.integration.findUnique({
      where: { id: requested },
      select: { id: true, businessId: true, kind: true, orgRef: true, isActive: true },
    });
    // Unreachable, absent and belonging to another client are one refusal —
    // the same 404-never-403 wording the document lookup uses.
    if (row === null || row.businessId !== businessId) {
      throw new ProposalExecutionRefused('publish.batch', 'that ledger connection is not reachable for this batch');
    }
    if (!row.isActive) {
      throw new ProposalExecutionRefused('publish.batch', 'that ledger connection is disconnected — reconnect it, then propose the publish again');
    }
    return { id: row.id, kind: row.kind, orgRef: row.orgRef };
  }

  // `integrationId: null` means "the business's single active integration"
  // (the contract). SINGLE is the operative word: `@@unique([businessId, kind])`
  // permits a business to hold both a Xero and a QuickBooks connection, and
  // picking one for the approver would be posting the books to whichever row
  // sorted first.
  const active = await db.integration.findMany({
    where: { businessId, isActive: true },
    select: { id: true, kind: true, orgRef: true },
    orderBy: { createdAt: 'asc' },
  });
  const only = active[0];
  if (only === undefined) {
    throw new ProposalExecutionRefused('publish.batch', 'this client has no active ledger connection — connect one before publishing');
  }
  if (active.length > 1) {
    throw new ProposalExecutionRefused('publish.batch', 'this client has more than one active ledger connection — name the one to publish through');
  }
  return only;
}

/**
 * Get one document into the state a publish can legally leave from, or refuse.
 *
 * READY is the normal case and costs nothing. The interesting case is the
 * RETRY, and it is worth reading slowly:
 *
 * a failed publish puts the document in **REJECTED** with the ledger's reason
 * (the follow-up does that — see its header for why REJECTED and not FAILED),
 * because "a failure with no reason attached is a bug, not a state" and the
 * Rejected/Failed surface is where a human finds it. But `LEGAL_TRANSITIONS`
 * offers REJECTED exactly two exits, `PROCESSING` and `ARCHIVED` — so a retry
 * cannot go straight back to PUBLISHED, and it should not: the state machine's
 * rule is that the way out of a failure is through PROCESSING, which is also
 * the ONLY edge that clears `failureCode`/`failureMessage`. Carrying a stale
 * "Xero rejected this" onto a document that then publishes successfully would
 * be a lie on the row.
 *
 * So a retry takes REJECTED → PROCESSING → READY here, both edges logged, both
 * inside the effect transaction. Nothing is re-extracted: PROCESSING is a
 * pass-through whose whole purpose is the machine's own reason-clearing rule,
 * and READY is what the minimum check (which has already run, on the same
 * fields readiness uses) just said. A document rejected for any OTHER reason
 * is refused — proposing a publish is not how a human rejection gets undone.
 */
async function admitForPublish(
  db: ScopedClient,
  document: { id: string; state: DocumentState },
  meta: { proposalId: string; traceId: string },
): Promise<void> {
  // ⚠ READY IS NOT ENOUGH — the in-flight window is real and it double-posts.
  //
  // The happy path deliberately leaves the document READY until the post-commit
  // follow-up hears back from the ledger, so between this transaction's commit
  // and that answer a document is simultaneously READY in the inbox and QUEUED
  // in `publishes`. A SECOND proposal over the same document therefore passes
  // the state gate, and `idempotency_key` cannot catch it: it is
  // `<proposalId>:<documentId>` by construction, so a different proposal is a
  // different key. The engine's `SELECT … FOR UPDATE` locks the PROPOSAL row,
  // not the document, so the two do not serialise either. Result: the same bill
  // posted to Xero twice — exactly what the idempotency key exists to prevent.
  //
  // QUEUED specifically: SUCCEEDED leaves the document PUBLISHED/ARCHIVED, which
  // the state gate below already refuses, and FAILED is the retry path this
  // function exists to admit.
  const inFlight = await db.publish.count({ where: { documentId: document.id, state: 'QUEUED' } });
  if (inFlight > 0) {
    throw new ProposalExecutionRefused(
      'publish.batch',
      'a publish of that document is already in flight — wait for it to land, then retry it if it fails',
    );
  }

  if (document.state === 'READY') return;

  if (document.state !== 'REJECTED') {
    // PUBLISHED and ARCHIVED are the loudest of these: the books already
    // moved, and a second post is the double-post the idempotency key exists
    // to prevent.
    throw new ProposalExecutionRefused('publish.batch', `a ${document.state.toLowerCase()} document cannot be published — only a Ready document, or one whose last publish attempt failed, may enter a batch`);
  }

  const failedAttempts = await db.publish.count({ where: { documentId: document.id, state: 'FAILED' } });
  if (failedAttempts === 0) {
    throw new ProposalExecutionRefused('publish.batch', 'that document was rejected for something other than a failed publish — fix what was rejected before proposing a publish');
  }

  const detail = { proposalId: meta.proposalId, via: 'publish-retry', priorFailedAttempts: failedAttempts };
  await transitionDocument(db, { id: document.id, state: 'REJECTED' }, { to: 'PROCESSING', traceId: meta.traceId, detail });
  await transitionDocument(db, { id: document.id, state: 'PROCESSING' }, { to: 'READY', traceId: meta.traceId, detail });
}
