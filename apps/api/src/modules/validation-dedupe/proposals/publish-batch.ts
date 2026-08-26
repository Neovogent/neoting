import type { PublishBatchPayload } from '@neoting/contracts/model';
import type { DocumentState } from '@prisma/client';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import {
  type ExportDestination,
  isExportDestination,
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
 * `publish.batch` — the effect half of METH Stage 10 (SoT §4 Stage 10, §17.1),
 * rebuilt for Initial Delivery by **D42, which supersedes D6** (SoT §24.3).
 *
 * ⚠ **THIS EXECUTOR RELEASES DOCUMENTS FOR EXPORT. IT DOES NOT TALK TO A
 * LEDGER, AND UNDER D42 NOTHING DOES.** *Published* is an INTERNAL state
 * meaning **approved and released for export**. It asserts nothing about Xero,
 * QuickBooks, VT or anything else: no bill was posted, nothing was synced, and
 * nothing was sent anywhere. Every string this file emits — refusals, event
 * details, the execution `detail` the audit trail stores — says
 * *released for export*, and any future edit that reintroduces the words
 * "posted", "synced" or "sent to" here is a D42 defect rather than a copy
 * preference.
 *
 * **What changed, and why it had to.** Until this stage the executor demanded
 * an active ledger connection through `resolveIntegration` and refused without
 * one. There was no OAuth flow, no endpoint and no `integration.create` outside
 * `prisma/seed.ts`, and D47 forbids client intake from asking for a connection
 * — so no document could ever reach PUBLISHED, and the export (which is ID's
 * ONLY egress) had nothing to export. The release no longer depends on a
 * connection existing:
 *
 * - A client's `integrations` row, when it has one, is an **export
 *   destination** — `VT` or `MANUAL`, the kinds S0 added for exactly this
 *   (`modules/publishing/export-destination.ts`). It records which import file
 *   the accountant will produce. It is never called.
 * - A client with **no** row still releases. `publishes.integration_id` is
 *   nullable in the schema, and null is the honest value for "released for
 *   export, destination not yet recorded" — far better than a refusal that
 *   would strand every document at READY again.
 * - A **ledger-vendor** row (XERO/QUICKBOOKS/SAGE/FREEAGENT — seeded, dormant,
 *   v1) is NOT an export destination and is never chosen. Stamping a vendor's
 *   id on a row that released a document for export is the lie D42 exists to
 *   prevent.
 *
 * **The ledger seam is dormant, not deleted.** `PublishGateway.ledger`,
 * `publish-follow-up.ts`, the `publish` `FollowUp` variant and the
 * `LedgerAdapter` interface all still exist, untouched, for D6/v1. This
 * executor simply no longer returns that follow-up, so nothing drives them —
 * which is what makes the real Xero adapter a later *addition* rather than a
 * later rewrite.
 *
 * **The follow-up went away, and the reason it existed went with it.** The
 * post-commit split was there for one sentence: *an external HTTP call must
 * never hold a tenant transaction open*. Releasing for export makes no call —
 * it is `publishes` rows and a state transition, in the same database, in the
 * transaction the engine already opened. So the whole effect is committed
 * atomically with the approval, and the window in which a document was READY
 * in the inbox while QUEUED in `publishes` no longer exists.
 *
 * ⚠ **AUTO-ARCHIVE IS GONE, AND THAT IS LOAD-BEARING.** The ledger follow-up
 * archived a document the moment the vendor confirmed it, which was right when
 * PUBLISHED meant "the books have it". Under D42 it means "ready to be
 * exported", and the contract is explicit on `POST /v1/exports`: **"Only
 * `PUBLISHED` documents are exported."** A release that archived on the way
 * out would move every document straight past the only state the export can
 * see, and `NT-EXP-001` ("nothing to export") would be the permanent answer.
 * Archiving stays a `document.archive` proposal, which is where a human
 * decides it.
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
 *   different set of facts. With the vendor gone the asymmetry the old header
 *   described goes with it: there is no post-commit per-item failure left to
 *   have, because there is no post-commit step.
 * - **The reviewed figures.** The payload carries the server-computed preview
 *   — that is what Read review rendered and what a human approved. If the
 *   live totals no longer agree (someone re-coded a document between propose
 *   and approve, itself through a proposal), the batch refuses: `NT-PRP-004`
 *   cannot catch this, because review is idempotent and the render is
 *   payload-pure, so this is the only place the drift is visible.
 * - **The retry edge.** A document that was REJECTED by the dormant ledger
 *   lane, or by a future export-side failure, re-enters through
 *   {@link admitForRelease} — REJECTED → PROCESSING → READY, because
 *   PROCESSING is the machine's only exit from REJECTED and the only edge that
 *   clears the reason. Retry is a NEW proposal over the failed item (the
 *   contract: "the old attempt is never replayed and never deleted").
 * - **Idempotency.** `publishes.idempotency_key` is `<proposalId>:<documentId>`
 *   — globally unique per the schema, one row per item per proposal. A replay
 *   sees its own rows and returns `alreadyApplied` with no second row and no
 *   second release.
 *
 * ⚠ **D44 — THE RELEASE GATE IS NOT HERE, AND MUST NOT BE.** Only the
 * practice's **super admin** may release Ready → Published; accountants
 * compose and edit. That check is **stage A12, and it has landed** — on the
 * ENGINE's approve path (`modules/approvals/assert-can.ts`, called from
 * `action-proposals.service.ts` as
 * `assertCan(actor, 'publish.release', resource)` before this executor is
 * entered) — not in this file. The reason is the executor contract itself: the
 * engine owns authorisation, the review gate, the shown-hash check and the
 * audit write, and *an executor performs exactly one effect and decides
 * nothing about whether it may happen* (`proposal-executor.ts`). Putting the
 * permission check here would be a second authorisation mechanism beside the
 * engine's, and the more permissive of two mechanisms wins exactly when it
 * matters. **Do not add one here when this file next changes.**
 *
 * What this file leaves the gate is the fact it needs: every `publishes` row
 * records `publishedByUserId = ctx.actorId`, so who released what is on the row.
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
  /**
   * publishing's `LedgerAdapter`, config-selected.
   *
   * ⚠ **Dormant under D42, and this executor never touches it.** It stays on
   * the gateway because the engine still carries the `publish` `FollowUp` arm
   * for the v1 ledger lane (D6), and because deleting a seam is how a later
   * Xero adapter becomes a rewrite instead of an addition. Nothing in the
   * Initial Delivery release path calls it — `publish-batch.test.ts` passes a
   * throwing adapter as a tripwire.
   */
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

/** The document projection this executor reads. */
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
      // transaction rather than releasing twice, which is the correct
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
          detail: { released: 0, alreadyReleased: existing.length },
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

      // One batch, one client. A batch spanning two clients has no single
      // export destination and no single set of books behind it, and an export
      // file is produced per client — guessing per item would put one client's
      // invoice in another's import file.
      const businessId = documents[0]?.businessId ?? null;
      if (businessId === null) {
        throw new ProposalExecutionRefused('publish.batch', 'an unrouted document has no client to release it for — route it first');
      }
      if (documents.some((document) => document.businessId !== businessId)) {
        throw new ProposalExecutionRefused('publish.batch', 'a release belongs to one client — propose one batch per client');
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
          `the batch no longer matches the figures that were reviewed (reviewed ${payload.preview.itemCount} items, gross ${payload.preview.grossPence}p, VAT ${payload.preview.vatPence}p; now ${preview.itemCount} items, gross ${preview.grossPence}p, VAT ${preview.vatPence}p) — propose the release again so a human approves what would actually be released`,
        );
      }

      const destination = await resolveExportDestination(db, businessId, payload.integrationId ?? null);

      for (const document of documents) {
        await admitForRelease(db, document, { proposalId, traceId });
      }

      // One `releasedAt` for the whole batch: the approval was one act, and
      // rows that share a `completedAt` to the microsecond are what the export
      // lane groups on. UTC, always — Europe/London happens at render.
      const releasedAt = new Date();
      for (const document of documents) {
        await releaseDocument(db, document.id, {
          businessId,
          destination,
          proposalId,
          actorId: ctx.actorId,
          traceId,
          releasedAt,
        });
      }

      return {
        changed: documents.map((document) => ({ entity: 'document' as const, id: document.id })),
        alreadyApplied: false,
        // No follow-up. Releasing for export calls nothing and waits for
        // nothing, so there is no work that must not run in this transaction —
        // see the header for why the ledger lane's post-commit split existed
        // and why D42 removes its reason along with the call.
        followUps: [],
        detail: {
          released: documents.length,
          releasedForExport: true,
          grossPence: preview.grossPence,
          vatPence: preview.vatPence,
          // Omitted rather than null when a client has no destination row yet:
          // `ExecutionResult.detail` stores strings, numbers and booleans, and
          // an absent key says "not recorded" without inventing a value.
          ...(destination === null ? {} : { exportDestinationId: destination.id, exportDestinationKind: destination.kind }),
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

/**
 * The client's export destination, resolved through RLS. **Optional by
 * design** (D42 + D47), which is the single change that lets a document reach
 * Published at all.
 *
 * Three cases and one non-case:
 *
 * - `integrationId` NAMED — resolved by id, must belong to this client, must
 *   be active, and must be an EXPORT destination. A named ledger-vendor row is
 *   refused rather than recorded: under D42 nothing is published to a vendor,
 *   so stamping one on the row would describe an act that did not happen.
 * - `integrationId` NULL, one active export destination — that one.
 * - `integrationId` NULL, none — **`null`, and the release proceeds.** There
 *   is nothing to connect (D47: intake asks for no connections) and
 *   `publishes.integration_id` is nullable in the schema. This is the case
 *   that used to throw "this client has no active ledger connection", and it
 *   is why nothing could ever reach Published.
 * - Two active export destinations (`@@unique([businessId, kind])` permits VT
 *   *and* MANUAL) — refused rather than picked, exactly as before. A11 creates
 *   one row per client, so this is unreachable in practice and stays a refusal
 *   rather than a coin toss.
 *
 * Dormant ledger-vendor rows are simply not candidates — `prisma/seed.ts` has
 * seeded `XERO` rows since long before D42, and they must not be silently
 * adopted by a release.
 */
async function resolveExportDestination(
  db: ScopedClient,
  businessId: string,
  requested: string | null,
): Promise<ExportDestination | null> {
  if (requested !== null) {
    const row = await db.integration.findUnique({
      where: { id: requested },
      select: { id: true, businessId: true, kind: true, isActive: true },
    });
    // Unreachable, absent and belonging to another client are one refusal —
    // the same 404-never-403 wording the document lookup uses.
    if (row === null || row.businessId !== businessId) {
      throw new ProposalExecutionRefused('publish.batch', 'that export destination is not reachable for this batch');
    }
    if (!row.isActive) {
      throw new ProposalExecutionRefused('publish.batch', 'that export destination is switched off — turn it back on, then propose the release again');
    }
    if (!isExportDestination(row.kind)) {
      throw new ProposalExecutionRefused(
        'publish.batch',
        'that connection is an accounting-software connection, and this release does not write to accounting software — approved documents are released for export and the accountant imports the file',
      );
    }
    return { id: row.id, kind: row.kind };
  }

  // `integrationId: null` means "the client's single export destination" (the
  // contract). SINGLE is the operative word.
  const active = await db.integration.findMany({
    where: { businessId, isActive: true },
    select: { id: true, kind: true },
    orderBy: { createdAt: 'asc' },
  });
  const destinations = active.filter((row): row is { id: string; kind: ExportDestination['kind'] } => isExportDestination(row.kind));
  if (destinations.length > 1) {
    throw new ProposalExecutionRefused('publish.batch', 'this client has more than one export destination — name the one to release for');
  }
  return destinations[0] ?? null;
}

/**
 * Get one document into the state a release can legally leave from, or refuse.
 *
 * READY is the normal case and costs nothing. The interesting case is the
 * RETRY, and it is worth reading slowly:
 *
 * a document can sit in **REJECTED** carrying a publish failure's reason —
 * today only from the dormant ledger lane (`publish-follow-up.ts`, kept for
 * v1), tomorrow from whatever export-side failure earns the same treatment,
 * because "a failure with no reason attached is a bug, not a state" and the
 * Rejected/Failed surface is where a human finds it. But `LEGAL_TRANSITIONS`
 * offers REJECTED exactly two exits, `PROCESSING` and `ARCHIVED` — so a retry
 * cannot go straight back to PUBLISHED, and it should not: the state machine's
 * rule is that the way out of a failure is through PROCESSING, which is also
 * the ONLY edge that clears `failureCode`/`failureMessage`. Carrying a stale
 * failure reason onto a document that is then released would be a lie on the
 * row.
 *
 * So a retry takes REJECTED → PROCESSING → READY here, both edges logged, both
 * inside the effect transaction. Nothing is re-extracted: PROCESSING is a
 * pass-through whose whole purpose is the machine's own reason-clearing rule,
 * and READY is what the minimum check (which has already run, on the same
 * fields readiness uses) just said. A document rejected for any OTHER reason
 * is refused — proposing a release is not how a human rejection gets undone.
 */
async function admitForRelease(
  db: ScopedClient,
  document: { id: string; state: DocumentState },
  meta: { proposalId: string; traceId: string },
): Promise<void> {
  // The in-flight guard, kept for the lane that can still produce one.
  //
  // Under D42 this executor cannot leave a QUEUED row behind: the row is
  // created and resolved inside the same transaction as the document's
  // transition, so a crash rolls back both and there is no window in which a
  // document is READY in the inbox and QUEUED in `publishes`. The guard stays
  // because the dormant ledger lane (`publish-follow-up.ts`) DOES open that
  // window when v1 re-enables it, and because a row left QUEUED by an older
  // release of this code is a real row on a real database. `<proposalId>:
  // <documentId>` cannot catch that case — a different proposal is a different
  // key — and the engine's `SELECT … FOR UPDATE` locks the PROPOSAL row, not
  // the document, so the two do not serialise either.
  const inFlight = await db.publish.count({ where: { documentId: document.id, state: 'QUEUED' } });
  if (inFlight > 0) {
    throw new ProposalExecutionRefused(
      'publish.batch',
      'a release of that document is already in flight — wait for it to land, then retry it if it fails',
    );
  }

  if (document.state === 'READY') return;

  if (document.state !== 'REJECTED') {
    // PUBLISHED and ARCHIVED are the loudest of these: the document has
    // already been released, and releasing it twice would put it in two export
    // files.
    throw new ProposalExecutionRefused('publish.batch', `a ${document.state.toLowerCase()} document cannot be released — only a Ready document, or one whose last release failed, may enter a batch`);
  }

  const failedAttempts = await db.publish.count({ where: { documentId: document.id, state: 'FAILED' } });
  if (failedAttempts === 0) {
    throw new ProposalExecutionRefused('publish.batch', 'that document was rejected for something other than a failed release — fix what was rejected before proposing a release');
  }

  const detail = { proposalId: meta.proposalId, via: 'release-retry', priorFailedAttempts: failedAttempts };
  await transitionDocument(db, { id: document.id, state: 'REJECTED' }, { to: 'PROCESSING', traceId: meta.traceId, detail });
  await transitionDocument(db, { id: document.id, state: 'PROCESSING' }, { to: 'READY', traceId: meta.traceId, detail });
}

/**
 * Release ONE document for export: the `publishes` row and the document's
 * state, atomically, with nothing called and nothing sent.
 *
 * **The `QUEUED → SUCCEEDED` lifecycle is kept, and it is kept on purpose.**
 * The row is born QUEUED — the state the schema has for durable intent — and
 * resolved to SUCCEEDED with a `completedAt` in the same breath, because the
 * thing the old code was waiting for (a vendor's answer) does not exist. Two
 * writes rather than one insert is a deliberate half-second of extra work: it
 * keeps `publishes` a truthful audit of a lifecycle rather than a table whose
 * rows appear fully formed, it is the shape a v1 ledger follow-up resolves in
 * its own transaction, and a reader who greps for the release path finds the
 * same two states in both lanes.
 *
 * **`external_ref` stays NULL and `attachment_sent` stays FALSE.** There is no
 * external reference to record, because nothing external was reached, and
 * nothing travelled anywhere. The link back to the source document is the D43
 * capability code the export emits (stage A8), not a vendor's id.
 */
async function releaseDocument(
  db: ScopedClient,
  documentId: string,
  meta: {
    businessId: string;
    destination: ExportDestination | null;
    proposalId: string;
    actorId: string;
    traceId: string;
    releasedAt: Date;
  },
): Promise<void> {
  const row = await db.publish.create({
    data: {
      businessId: meta.businessId,
      documentId,
      // Null when the client carries no export destination row yet — the
      // schema's own nullability, used for what it is for.
      integrationId: meta.destination?.id ?? null,
      // MANUAL: a human read the review and pressed Approve. AUTO is the rules
      // lane and AI is the agent's own initiative; neither is what just
      // happened. It says nothing about the destination's kind.
      mode: 'MANUAL',
      state: 'QUEUED',
      idempotencyKey: publishIdempotencyKey(meta.proposalId, documentId),
      actionProposalId: meta.proposalId,
      // D44's evidence: who released this. A12's `assertCan` decides WHETHER
      // they may; this records that they did, gate or no gate.
      publishedByUserId: meta.actorId,
    },
    select: { id: true },
  });

  await db.publish.update({
    where: { id: row.id },
    data: { state: 'SUCCEEDED', completedAt: meta.releasedAt },
  });

  await transitionDocument(
    db,
    { id: documentId, state: 'READY' },
    {
      to: 'PUBLISHED',
      traceId: meta.traceId,
      detail: {
        proposalId: meta.proposalId,
        // The audit trail's own word for what happened. Not "posted", not
        // "synced", not "sent" — D42, and the processing log is read by
        // humans.
        via: 'release-for-export',
        releasedForExport: true,
        publishId: row.id,
        exportDestinationId: meta.destination?.id ?? null,
        exportDestinationKind: meta.destination?.kind ?? null,
      },
    },
  );
}
