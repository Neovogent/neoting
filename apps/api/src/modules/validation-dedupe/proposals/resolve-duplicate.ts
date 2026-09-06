import type { DuplicateResolvePayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * `document.resolve-duplicate` — the human ruling on a suspected duplicate
 * pair (review item 49, D49's four-action resolution; owner-approved
 * 6 Sep 2026, "attach to the original" deliberately deferred).
 *
 * The `duplicates` schema anticipated exactly this — `verdict` already holds
 * PENDING / CONFIRMED_DUPLICATE / CONFIRMED_DIFFERENT / KEEP_BOTH with
 * `decided_by_user_id` / `decided_at` beside it — so the effect is one upsert:
 * the route-time detector's row when one exists (matched in EITHER column
 * order), a fresh row when the pair was derived client-side and never stored.
 * A fresh row carries `score: 0` and `signals: {resolvedBy: 'accountant'}` so
 * it can never be mistaken for a detector's own finding.
 *
 * **`delete-copy` additionally moves the copy to Trash** — `deleted_at`, the
 * reversible seam `POST /documents/{id}/restoration` undoes exactly — and
 * writes the same `document_events` row the Trash endpoint writes
 * (`stage: 'delete'`, outcome `DELETED`), so the document's own log has no
 * gap where it vanished from every screen. Never a purge: `document.purge` is
 * the only irreversible act on a document and has its own refusals (D43).
 *
 * Both documents are resolved through the approver's RLS context BEFORE any
 * write (the route/offboard guard): an unreachable id refuses, and a pair
 * spanning two clients refuses — both rows individually visible does not make
 * them the same client's (the confirm-match rule), and `duplicates.business_id`
 * holds only one.
 *
 * Idempotent by outcome rather than by stamp (`duplicates` carries no proposal
 * column): a pair already ruled with THIS verdict — and, for delete-copy, a
 * copy already in Trash — is a replay, `alreadyApplied: true`, no second write
 * and the original `decided_at` survives (the Trash-timestamp rule). A pair
 * ruled with a DIFFERENT verdict re-rules: a later human decision supersedes
 * an earlier one, which is what "the flag is dismissible" means.
 */
const VERDICT_BY_RESOLUTION = {
  'different-documents': 'CONFIRMED_DIFFERENT',
  'keep-both': 'KEEP_BOTH',
  'delete-copy': 'CONFIRMED_DUPLICATE',
} as const;

export const resolveDuplicateExecutor: ProposalExecutor<'document.resolve-duplicate', DuplicateResolvePayload> = {
  kind: 'document.resolve-duplicate',

  async execute(db: ScopedClient, input: ExecutionInput<DuplicateResolvePayload>): Promise<ExecutionResult> {
    const { payload, ctx, traceId } = input;
    const { documentKeepId, documentCopyId } = payload;

    if (documentKeepId === documentCopyId) {
      throw new ProposalExecutionRefused('document.resolve-duplicate', 'a pair is two different documents');
    }

    // RLS decides visibility — an absent id and a foreign one are the same
    // refusal, and the message never says which (404-never-403, on effects).
    const documents = await db.document.findMany({
      where: { id: { in: [documentKeepId, documentCopyId] } },
      select: { id: true, businessId: true, deletedAt: true, state: true },
    });
    const keep = documents.find((d) => d.id === documentKeepId);
    const copy = documents.find((d) => d.id === documentCopyId);
    if (keep === undefined || copy === undefined) {
      throw new ProposalExecutionRefused('document.resolve-duplicate', 'a referenced document is not reachable');
    }
    // `duplicates.business_id` holds ONE client, and a cross-workspace "pair"
    // is not a pair — the bank.confirm-match rule, applied here.
    if (keep.businessId === null || keep.businessId !== copy.businessId) {
      throw new ProposalExecutionRefused('document.resolve-duplicate', 'a duplicate pair must belong to one client');
    }

    const verdict = VERDICT_BY_RESOLUTION[payload.resolution];
    const wantsTrash = payload.resolution === 'delete-copy';

    // The detector's row when one exists — either column order is the same pair.
    const existing = await db.duplicate.findFirst({
      where: {
        OR: [
          { documentAId: documentKeepId, documentBId: documentCopyId },
          { documentAId: documentCopyId, documentBId: documentKeepId },
        ],
      },
      select: { id: true, verdict: true },
    });

    const alreadyRuled = existing !== null && existing.verdict === verdict;
    const alreadyTrashed = copy.deletedAt !== null;

    if (!alreadyRuled) {
      if (existing !== null) {
        await db.duplicate.update({
          where: { id: existing.id },
          data: { verdict, decidedByUserId: ctx.actorId, decidedAt: new Date() },
        });
      } else {
        await db.duplicate.create({
          data: {
            businessId: keep.businessId,
            documentAId: documentKeepId,
            documentBId: documentCopyId,
            // Not a detector's finding: the pair was derived on a screen and
            // ruled on by a human, and a zero score under an accountant marker
            // is what stops it ever reading as one.
            signals: { resolvedBy: 'accountant' },
            score: 0,
            verdict,
            decidedByUserId: ctx.actorId,
            decidedAt: new Date(),
          },
        });
      }
    }

    let trashedNow = false;
    if (wantsTrash && !alreadyTrashed) {
      // Compare-and-swap on `deletedAt: null` (the Trash endpoint's own shape) —
      // a racing delete keeps ITS timestamp, and this replay stays honest.
      const changed = await db.document.updateMany({
        where: { id: documentCopyId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      trashedNow = changed.count > 0;
      if (trashedNow) {
        // The same per-document log row `POST /documents/{id}/deletion` writes,
        // with the proposal named — the Trash timeline must not have a gap
        // where a resolution made a document vanish. The audit-chain row is
        // the engine's own append for this approval; ids only, nothing
        // untrusted (no filename, no supplier).
        await db.documentEvent.create({
          data: {
            documentId: documentCopyId,
            stage: 'delete',
            outcome: 'DELETED',
            traceId,
            detail: {
              documentId: documentCopyId,
              actorId: ctx.actorId,
              state: copy.state,
              proposalId: input.proposalId,
              reason: 'duplicate-resolution',
            },
          },
        });
      }
    }

    return {
      changed: [
        { entity: 'document', id: documentKeepId },
        { entity: 'document', id: documentCopyId },
      ],
      alreadyApplied: alreadyRuled && (!wantsTrash || alreadyTrashed),
      followUps: [],
      detail: {
        resolution: payload.resolution,
        verdict,
        copyMovedToTrash: wantsTrash && (trashedNow || alreadyTrashed),
        recoverable: true,
      },
    };
  },
};
