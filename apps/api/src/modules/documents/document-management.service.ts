import { HttpStatus } from '@nestjs/common';

import type { Document } from '@neoting/contracts/model';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../common/db/scoped-db.js';
import { toDocumentResponse, toExtraction } from '../../common/documents/document-response.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { AppException } from '../../common/problem/problem.js';
import { currentTraceId } from '../../common/trace/trace-context.js';
import { appendAuditEvent, canonicalHash } from '../approvals/index.js';

/**
 * Trash and restore — `POST /v1/documents/{documentId}/deletion` and
 * `/restoration` (document management, 2 Sep 2026).
 *
 * ## Why these two are NOT ActionProposals, and purge is
 *
 * Governance §10 forbids a state change outside Review → Approve, and the line
 * it draws is around acts that **cannot be taken back**. `RELEASE_KINDS` states
 * the test in as many words: *"Everything else is internal and reversible by a
 * further proposal — archive unarchives, coding is corrected again, a rejection
 * is reprocessed."* Delete and restore are that, exactly: two operations that
 * undo each other completely, writing one nullable timestamp between them.
 * Nothing is destroyed, nothing leaves the product, and no figure moves.
 *
 * Putting Read review → Approve in front of pressing Delete on one receipt
 * would not add a safeguard, it would remove one: the Approve queue would fill
 * with housekeeping, and Approve fatigue is how a real release gets waved
 * through. PERMANENT deletion is the opposite in every respect, and it IS a
 * proposal — `document.purge`, in `validation-dedupe/proposals/`.
 *
 * ## Why this is a SECOND service class beside `DocumentsService`
 *
 * `documents/CLAUDE.md` recorded a structural invariant: *"There is no write on
 * this module... Because the service class has no mutating method, there is no
 * side-effect path for one to hide in — the invariant is enforced by the absence
 * of code rather than by a promise in prose."* That property is worth keeping
 * rather than spending. `DocumentsService` still has no mutating method; the two
 * writes this product now needs live here, in one small class whose entire
 * surface is the pair, so "what on the documents module can write?" is still
 * answered by reading a file rather than by trusting a claim.
 *
 * ## Tenancy, as everywhere in this module
 *
 * RLS and no second mechanism. Both methods `findUnique` inside `scopedDb`
 * first; a document another practice owns is invisible, comes back null, and
 * raises the same 404 the read surface raises — **404, never 403**, and the
 * detail never echoes the id.
 */
export class DocumentManagementService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly idempotency: IdempotencyStore,
  ) {}

  /**
   * `POST /documents/{documentId}/deletion` — move to Trash.
   *
   * **Idempotent, and the original timestamp survives a replay.** Deleting a
   * document that is already deleted is a `200` with the row as it stands, not
   * a `409`: the caller's goal is already true. The stored `deletedAt` is NOT
   * rewritten, because *when* a document was deleted is the only question a
   * Trash listing sorted by deletion can answer, and a second press of a button
   * that appeared to do nothing must not silently move it.
   *
   * ⚠ **A PUBLISHED document may be moved to Trash, deliberately.** Deleting is
   * reversible housekeeping; refusing it would leave an accountant with
   * released rows they cannot clear off their screen and no way to. What is
   * refused for a published document is the PURGE — see
   * `validation-dedupe/proposals/purge-document.ts` and D43.
   */
  async deleteDocument(ctx: ScopeContext, documentId: string, idempotencyKey: string): Promise<Document> {
    return this.setDeleted(ctx, documentId, idempotencyKey, true);
  }

  /**
   * `POST /documents/{documentId}/restoration` — back out of Trash.
   *
   * The document returns **in the state it left**. `state` was never touched by
   * the deletion, so unlike unarchiving there is nothing to derive, nothing to
   * read back out of the event log, and no fallback guess for a row that
   * predates something. That is the payoff of `deletedAt` being a timestamp
   * beside `state` rather than a ninth `DocumentState` member: a state member
   * would have had to destroy the answer in order to record the question.
   *
   * Idempotent in the same way: restoring a document that is not in Trash is a
   * `200`.
   */
  async restoreDocument(ctx: ScopeContext, documentId: string, idempotencyKey: string): Promise<Document> {
    return this.setDeleted(ctx, documentId, idempotencyKey, false);
  }

  /**
   * The two operations are one write in opposite directions, so they are one
   * method — the shape `document.archive` uses for archive/unarchive.
   *
   * **Everything below happens in ONE `scopedDb` transaction**: the
   * compare-and-swap, the `document_events` row and the audit append. A
   * processing log with a gap where a document vanished from every screen is
   * the thing the log exists to prevent, and an audit row that survived a
   * rolled-back write would be a record of something that did not happen.
   */
  private async setDeleted(
    ctx: ScopeContext,
    documentId: string,
    idempotencyKey: string,
    deleted: boolean,
  ): Promise<Document> {
    const request = { documentId, deleted };
    const replay = await this.replayed(ctx, idempotencyKey, request);
    if (replay !== null) return replay;

    const response = await scopedDb(this.prisma, ctx, async (db) => {
      const before = await db.document.findUnique({
        where: { id: documentId },
        select: { id: true, businessId: true, state: true, deletedAt: true },
      });
      // RLS already removed everything that is not the caller's, so a null here
      // means "not yours" and "does not exist" indistinguishably. That is the
      // house rule and the detail below never says which.
      if (before === null) throw notFound();

      const alreadyInTargetCondition = deleted === (before.deletedAt !== null);
      if (!alreadyInTargetCondition) {
        // Compare-and-swap, guarded on the condition we just read, the shape
        // `transitionDocument` and `revoke-link` both use. Two overlapping
        // requests cannot rewrite each other's timestamp: the loser updates
        // zero rows and falls through to the same read-back, so it returns the
        // WINNER's `deletedAt` and reports success — which is true, and is what
        // an idempotent operation owes a caller.
        const changed = await db.document.updateMany({
          where: { id: documentId, deletedAt: deleted ? null : { not: null } },
          data: { deletedAt: deleted ? new Date() : null },
        });

        if (changed.count > 0) {
          await this.recordDeletion(db, ctx, { documentId, businessId: before.businessId, state: before.state, deleted });
        }
      }

      // Read back rather than project the pre-write row: the response must be
      // what the database now holds, including a concurrent writer's timestamp.
      const after = await db.document.findUnique({
        where: { id: documentId },
        include: { extractions: { where: { isAccepted: true }, take: 1 } },
      });
      if (after === null) throw notFound();

      const accepted = after.extractions[0];
      return {
        ...toDocumentResponse(after),
        acceptedExtraction: accepted === undefined ? null : toExtraction(accepted),
      };
    });

    await this.remember(ctx, idempotencyKey, request, response);
    return response;
  }

  /**
   * The two durable records of the act, both inside the caller's transaction.
   *
   * **`document_events`** is the per-document processing log every other
   * lifecycle move writes to (`document-state.ts` writes one per transition),
   * and it is what makes "where did this document go" answerable on the
   * document's own screen. `stage` is `delete` / `restore` rather than `state`,
   * because this is not a `DocumentState` transition and labelling it one would
   * make the log claim an edge the state machine never took.
   *
   * **`audit_events`** is the hash chain, appended through the approvals seam's
   * `appendAuditEvent` and never through a second copy of the formula — a chain
   * whose links were computed two ways cannot be verified at all
   * (`signup-audit.ts` states the cost). `proposalId` is null, which the writer
   * has admitted since 2 Sep 2026 precisely for acts that legitimately have no
   * proposal. **The actor is named**: `ctx.actorId` rides in the outcome, which
   * is where an approver's identity already goes.
   *
   * ⚠ Nothing untrusted is stored in either. No filename, no supplier name, no
   * extracted text — ids and a state name only. Both of these rows are read
   * back by operators and by the audit verifier, and document content is data,
   * never instructions.
   */
  private async recordDeletion(
    db: ScopedClient,
    ctx: ScopeContext,
    facts: { documentId: string; businessId: string | null; state: string; deleted: boolean },
  ): Promise<void> {
    const stage = facts.deleted ? 'delete' : 'restore';
    // `ScopeContext` carries no trace id — it is per-request async-local state,
    // read the same way `action-proposals.service.ts` reads it.
    const traceId = currentTraceId() ?? null;
    const outcome = {
      documentId: facts.documentId,
      actorId: ctx.actorId,
      // The pipeline state the document holds THROUGHOUT — unchanged by either
      // direction, recorded so the trail shows a restore put back what a delete
      // took away rather than something that was re-derived.
      state: facts.state,
    };

    await db.documentEvent.create({
      data: {
        documentId: facts.documentId,
        stage,
        outcome: facts.deleted ? 'DELETED' : 'RESTORED',
        traceId,
        detail: outcome,
      },
    });

    await appendAuditEvent(db, {
      businessId: facts.businessId,
      event: facts.deleted ? 'document.deleted' : 'document.restored',
      // Null, and legitimately so: these two are ordinary authenticated
      // mutations, not proposals. See this class's header for why.
      proposalId: null,
      payloadHash: canonicalHash(outcome),
      renderedSummaryHash: null,
      traceId,
      outcome,
    });
  }

  /**
   * Replay handling, actor-scoped — copied deliberately from
   * `action-proposals.service.ts#fingerprintFor` rather than reinvented.
   *
   * ⚠ The actor in the fingerprint is the load-bearing part. The store is a
   * process-wide map keyed by a CALLER-CHOSEN string and a replay returns its
   * stored response **before** any scoped query runs, so without it, presenting
   * somebody else's `Idempotency-Key` would replay their document past RLS.
   * These two operations are natively idempotent at the row, so this is a
   * disclosure guard rather than a double-effect one — but the thing disclosed
   * would be another practice's document.
   */
  private async replayed(ctx: ScopeContext, idempotencyKey: string, request: unknown): Promise<Document | null> {
    const record = await this.idempotency.get(idempotencyKey);
    if (record === null) return null;
    if (record.requestHash !== fingerprint({ actorId: ctx.actorId, request })) {
      throw new AppException(
        'NT-IDM-001',
        HttpStatus.CONFLICT,
        'This Idempotency-Key was already used with a different payload',
        'Use a fresh Idempotency-Key for a different request.',
      );
    }
    return record.response as Document;
  }

  private async remember(ctx: ScopeContext, idempotencyKey: string, request: unknown, response: unknown): Promise<void> {
    await this.idempotency.put(idempotencyKey, { requestHash: fingerprint({ actorId: ctx.actorId, request }), response });
  }
}

/**
 * Word for word `documents.service.ts#notFound`, and it has to be: a caller
 * must not be able to tell "that document is not yours" from "there is no such
 * document" by comparing the delete path's refusal with the read path's.
 *
 * `NT-VAL-001` because `NT-NOT-001` does not exist — the `ErrorCode` enum has no
 * dedicated not-found code and this is the house fallback
 * (`ProblemFilter.CODE_BY_STATUS`). See `documents/CLAUDE.md`.
 */
function notFound(): AppException {
  return new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Document not found', 'No document with that id.');
}
