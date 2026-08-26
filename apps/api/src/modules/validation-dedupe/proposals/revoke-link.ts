import type { RevokeLinkPayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';

import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * `document.revoke-link` — killing D43 capability URLs that have already left
 * our control (stage A8).
 *
 * **This is why revocation is a proposal and not a `DELETE`.** The contract
 * says it in as many words: the links being revoked are sitting inside an
 * accountant's ledger file right now, revoking one turns a working entry into a
 * `410`, and whoever presses the button should have read a review saying
 * exactly which documents stop being reachable. There is no revoke endpoint,
 * there must not be one, and `GET /d/{code}` is the only route this lane
 * publishes (Governance §10 — no side-effect path outside Review → Approve).
 *
 * ## Why this file is here and not in `exports-public-api`
 *
 * Stage A8 owns the capability-URL lane, and this executor is its effect — but
 * every executor lives in the module that owns the data, and putting this one
 * in `exports-public-api` would close a runtime cycle between two public seams:
 * `validation-dedupe/index.ts` → `proposals/registry.ts` →
 * `exports-public-api/index.ts` → `validation-dedupe/index.ts`, for the
 * `ProposalExecutionRefused` class the engine matches on with `instanceof`.
 * `publish-batch.ts` documents the same hazard and answers it by keeping the
 * executor here. It costs nothing to follow: revoking needs **nothing** from
 * `exports-public-api` — it is one guarded `UPDATE` on a table.
 *
 * ## Revocation mints no replacement
 *
 * Deliberately, and the schema says so on the model: *"A document whose link was
 * revoked has no live link until the next export creates one, and that new link
 * carries a new code — which is the point: an old code that still resolved
 * would not have been revoked."* Nothing here creates a `document_links` row.
 *
 * ## All-or-nothing, and idempotent
 *
 * A link id the approver cannot see and one that does not exist are the same
 * refusal — the `document.archive` rule, for the same reason: a batch that
 * silently skipped either would report success over a hole. A replay finds the
 * links already revoked, changes nothing, and reports `alreadyApplied`; the
 * original `revoked_at` is never overwritten, because the moment a link died is
 * the answer to "when did my January export stop working".
 */
export const revokeLinkExecutor: ProposalExecutor<'document.revoke-link', RevokeLinkPayload> = {
  kind: 'document.revoke-link',

  async execute(db: ScopedClient, input: ExecutionInput<RevokeLinkPayload>): Promise<ExecutionResult> {
    const { payload, traceId, proposalId } = input;
    const requested = [...new Set(payload.documentLinkIds)];

    const links = await db.documentLink.findMany({
      where: { id: { in: requested } },
      select: { id: true, documentId: true, code: true, revokedAt: true },
    });

    if (links.length !== requested.length) {
      throw new ProposalExecutionRefused(
        'document.revoke-link',
        'one or more document links are not reachable',
      );
    }

    const pending = links.filter((link) => link.revokedAt === null);
    const revokedAt = new Date();

    if (pending.length > 0) {
      // Guarded on `revokedAt: null` as well as the id set — compare-and-swap
      // shaped, like every other write in this directory. Two approvers
      // revoking overlapping batches at the same moment must not have the
      // second one rewrite the first one's timestamp.
      await db.documentLink.updateMany({
        where: { id: { in: pending.map((link) => link.id) }, revokedAt: null },
        data: { revokedAt },
      });

      // The per-document processing log gets the narrative, one row per link,
      // so "why does the code in my January export return 410" is answerable
      // from the document's own history rather than from a support ticket.
      // It is the same stage `GET /d/{code}` writes its accesses under, so a
      // link's whole life — minted, opened, opened, revoked — reads in order.
      await db.documentEvent.createMany({
        data: pending.map((link) => ({
          documentId: link.documentId,
          stage: 'source-link',
          outcome: 'revoked',
          traceId,
          detail: {
            linkId: link.id,
            // The dead code, kept on purpose. It is no longer a credential —
            // it resolves to a 410 from this moment — and it is the only thing
            // that connects this event to the row an accountant is staring at
            // in their ledger.
            code: link.code,
            proposalId,
            // Free text a human wrote, stored as data. Nothing here shows it to
            // a model; the contract caps it at 500 characters and the boundary
            // parse has already enforced that.
            ...(payload.reason == null ? {} : { reason: payload.reason }),
          },
        })),
      });
    }

    // `changed` names the DOCUMENTS, not the links: `ChangedEntity` has no
    // `document-link` member, and "these documents stopped being reachable from
    // the ledger" is the sentence the outcome record should read as anyway.
    // De-duplicated, because two links on one document is a legitimate state
    // (revoke, re-export, revoke again).
    const changedDocumentIds = [...new Set(links.map((link) => link.documentId))];

    return {
      changed: changedDocumentIds.map((id) => ({ entity: 'document' as const, id })),
      alreadyApplied: pending.length === 0,
      followUps: [],
      detail: {
        linksRequested: requested.length,
        linksRevoked: pending.length,
        linksAlreadyRevoked: links.length - pending.length,
        documentsAffected: changedDocumentIds.length,
      },
    };
  },
};
