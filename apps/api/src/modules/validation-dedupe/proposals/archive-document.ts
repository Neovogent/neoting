import type { ArchivePayload } from '@neoting/contracts/model';
import type { DocumentState } from '@prisma/client';

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
 * `document.archive` — archive and unarchive, batched (issue #81).
 *
 * Archive sets **both** `state = ARCHIVED` and `archivedAt` — the decision
 * recorded on #81 (decision 5, overridden): the read surface's default
 * exclusion and the Vault's `?state=ARCHIVED` filter both key on `state`, so a
 * timestamp-only archive would leave archived documents sitting in every
 * working queue. The state machine (#80) stamps the timestamp with the edge.
 *
 * Unarchive restores the PRE-ARCHIVE state, read from the event log — the
 * archive transition's own event carries `detail.from`, so the restore target
 * is the audit trail, not a guess. The derivation fallback (a row archived
 * before the machine existed) goes: failure code present → FAILED; otherwise
 * readiness decides READY vs TO_REVIEW. `clearPublishingData` on a PUBLISHED
 * restore demotes the target to readiness's answer and records
 * `publishingDataClearDeferred` — actually clearing Publish rows is the
 * publishing module's seam, named on the issue, never silently done here.
 *
 * Batched (1..500 per the contract), one transaction, all-or-nothing: a
 * partially archived batch is worse than a refused one. Idempotent per
 * document — a doc already in the requested condition is skipped without a
 * second event, and `alreadyApplied` is true only when EVERY doc was.
 */
export const archiveDocumentExecutor: ProposalExecutor<'document.archive', ArchivePayload> = {
  kind: 'document.archive',

  async execute(db: ScopedClient, input: ExecutionInput<ArchivePayload>): Promise<ExecutionResult> {
    const { payload, traceId, proposalId } = input;

    const documents = await db.document.findMany({
      where: { id: { in: [...payload.documentIds] } },
      select: {
        id: true,
        state: true,
        archivedAt: true,
        failureCode: true,
        failureMessage: true,
        totalPence: true,
        supplierName: true,
        categoryCode: true,
      },
    });

    // All-or-nothing: an id RLS cannot see and an id that does not exist are
    // the same refusal, and a batch that silently skipped either would report
    // success over a hole.
    if (documents.length !== payload.documentIds.length) {
      throw new ProposalExecutionRefused('document.archive', 'one or more documents are not reachable');
    }

    let applied = 0;
    const changed: { entity: 'document'; id: string }[] = [];

    for (const document of documents) {
      changed.push({ entity: 'document', id: document.id });

      if (payload.archived) {
        if (document.state === 'ARCHIVED') continue; // idempotent replay
        // The machine refuses the illegal froms (RECEIVED/PROCESSING — a
        // document mid-pipeline has not been seen yet) and stamps archivedAt.
        await transitionDocument(db, document, { to: 'ARCHIVED', traceId, detail: { proposalId } });
        applied += 1;
        continue;
      }

      if (document.state !== 'ARCHIVED') continue; // idempotent replay

      let target = await preArchiveState(db, document.id);
      if (target === null) {
        // Fallback derivation for a row archived before the machine existed.
        // REJECTED vs FAILED is not distinguishable from row data alone; the
        // event path is the real one and this is the honest approximation.
        target = document.failureCode !== null ? 'FAILED' : resolveProcessedState(document);
      }

      let publishingDataClearDeferred = false;
      if (target === 'PUBLISHED' && payload.clearPublishingData === true) {
        // "Unarchiving a published item asks whether to clear its publishing
        // data, because that decides whether it can be republished" (the
        // contract). Clearing the Publish rows themselves belongs to the
        // publishing module — the seam agreed on #81 — so the demotion is
        // recorded and the rows are left for that executor.
        target = resolveProcessedState(document);
        publishingDataClearDeferred = true;
      }

      if (target === 'REJECTED' || target === 'FAILED') {
        // The machine's type-level rule: no failure state without a reason.
        // The reason survived the archive on the row (document-state.ts keeps
        // it for exactly this restore); a row claiming a failure state with no
        // reason is data this executor refuses to launder.
        if (document.failureCode === null || document.failureMessage === null) {
          throw new ProposalExecutionRefused('document.archive', 'cannot restore a failure state without its recorded reason');
        }
        await transitionDocument(db, document, {
          to: target,
          failure: { code: document.failureCode, message: document.failureMessage },
          traceId,
          detail: { proposalId, restored: true },
        });
      } else {
        await transitionDocument(db, document, {
          to: target,
          traceId,
          detail: { proposalId, restored: true, ...(publishingDataClearDeferred ? { publishingDataClearDeferred } : {}) },
        });
      }
      applied += 1;
    }

    return {
      changed,
      alreadyApplied: applied === 0,
      followUps: [],
      detail: { archived: payload.archived, applied, skippedAlreadyInState: documents.length - applied },
    };
  },
};

/**
 * The state the document held when it was archived, from the archive
 * transition's own event — the audit trail as the restore oracle. Null when no
 * such event exists (archived before the machine landed).
 */
async function preArchiveState(db: ScopedClient, documentId: string): Promise<DocumentState | null> {
  const event = await db.documentEvent.findFirst({
    where: { documentId, stage: 'state', outcome: 'ARCHIVED' },
    orderBy: { createdAt: 'desc' },
    select: { detail: true },
  });
  if (event === null) return null;
  const detail = event.detail;
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return null;
  const from = (detail as Record<string, unknown>)['from'];
  return typeof from === 'string' ? (from as DocumentState) : null;
}
