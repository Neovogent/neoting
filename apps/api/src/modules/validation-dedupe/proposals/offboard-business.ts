import type { BusinessOffboardPayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * `business.offboard` — deactivate a client workspace, the first slice of
 * D32's self-serve offboarding.
 *
 * **Soft, never destructive.** The contract says it in as many words: the one
 * effect is `businesses.is_active` flipping to false, so the client leaves the
 * working surfaces (the Clients list excludes inactive workspaces) while the
 * books, documents and audit trail stay exactly where the six-year retention
 * clock (D12) requires them. Nothing here deletes a row, and nothing here may
 * ever grow a delete — D32's whole-firm export and audited erasure are their
 * own, later surfaces. No money column is read or written.
 *
 * ## ⚠ THE SCOPE — review item 67, and it is a data-integrity fix
 *
 * > *"One client was deleted but their document is still here, while deleting a
 * > user ask to select what they want to delete, full user and data, user only,
 * > keep files etc."*
 *
 * Until 7 Sep 2026 this executor said nothing whatsoever about the client's
 * documents, and that silence WAS the bug: the business row left the Clients
 * list while its documents stayed live in the practice's queues, still offering
 * Publish, under a CLIENT column that had nothing left to resolve and rendered
 * the raw cuid. Offboarding states its blast radius at Read review now, and
 * acts on it.
 *
 * **All three scopes are reversible, and that is the whole design.** The honest
 * set is bounded by what UK bookkeeping permits — D12 holds the books six
 * years, D32 promises reading and exporting survive a lapse, D43 refuses to
 * purge anything an export still links to — so no scope this kind can name may
 * destroy a row:
 *
 * - `keep` (the default, and what this executor did before the field existed)
 *   — the documents are untouched.
 * - `trash` — every one of the client's documents not already deleted is
 *   stamped `deleted_at`, through the SAME seam `POST /documents/{id}/deletion`
 *   writes and `POST .../restoration` undoes. Deliberately not a new mechanism:
 *   the client's own Trash lists them, one Restore puts any of them back in the
 *   state it left, and the retention window applies to them exactly as it does
 *   to a hand-deleted document.
 * - `mark-for-erasure` — stamps `erasure_requested_at` and nothing else.
 *   **NOTHING READS THAT COLUMN ON A SCHEDULE** (owner ruling, 7 Sep 2026:
 *   *erasure on request, no automatic date*). It records the practice's stated
 *   intention for a later, deliberate, audited erasure surface. The review card
 *   and the dialog both say "marked", never "scheduled" — the copy has to stay
 *   as narrow as the effect.
 *
 * `offboarded_at` is stamped on every path, because the Removed clients panel
 * counts its restore window from a moment and the audit chain is too expensive
 * to join per row on a list. `docs/Retention_and_Deletion_Policy.md` is the
 * policy all of this implements.
 *
 * The business is resolved through the approver's RLS context BEFORE the
 * write (the route/chase.send guard, applied here): a workspace the approver
 * cannot see and one that does not exist are the same refusal, and the engine
 * reports both as its generic `NT-PRP-006` — the message never distinguishes
 * "does not exist" from "not yours" (404-never-403, applied to effects). The
 * `businesses_tenant` policy has no `isActive` branch, so an already-inactive
 * workspace is still visible here — which is what makes the replay honest
 * rather than a refusal.
 *
 * Idempotent, the archive rule: a workspace already inactive is a replay, not
 * a second effect — no write, no second audit noise, `alreadyApplied: true`.
 * The write itself is compare-and-swap shaped (`updateMany` guarded on
 * `isActive: true`, like every other write in this directory), so two racing
 * approvals cannot both report having offboarded the client.
 *
 * The payload arrives contract-parsed: the engine re-parses the stored row
 * against the kind's generated member schema at execution time
 * (`approvals/proposal-body.ts#parseStoredProposalPayload`) — the #81
 * contract: parse there, not here. `payload.reason` is carried into the
 * result detail verbatim, so the words the reviewer read land in the
 * proposal's `outcome` and the audit trail.
 */
export const offboardBusinessExecutor: ProposalExecutor<'business.offboard', BusinessOffboardPayload> = {
  kind: 'business.offboard',

  async execute(db: ScopedClient, input: ExecutionInput<BusinessOffboardPayload>): Promise<ExecutionResult> {
    const { payload } = input;

    // RLS decides visibility: null for a foreign workspace and for an absent
    // id alike, and the refusal below keeps them indistinguishable.
    const business = await db.business.findUnique({
      where: { id: payload.businessId },
      select: { id: true, name: true, isActive: true },
    });
    if (business === null) {
      throw new ProposalExecutionRefused('business.offboard', 'no reachable business');
    }

    // The contract's own default, applied HERE rather than left to a caller
    // remembering to send it — the `deletedFilterFor` reasoning. orval emits the
    // enum as optional rather than defaulted, so "the caller said nothing" has
    // to mean the safe scope on the server, where the effect actually happens.
    const scope = payload.documentScope ?? 'keep';

    const detail = (offboardedNow: boolean, trashed: number): NonNullable<ExecutionResult['detail']> => ({
      // Honest either way: the workspace IS offboarded after this executor
      // returns; `alreadyInactive` says whether this approval did it.
      offboarded: true,
      alreadyInactive: !offboardedNow,
      businessName: business.name,
      booksRetained: true,
      documentScope: scope,
      // The number this approval actually moved — not the number the review
      // card predicted. A replay moves none, and saying so is the point.
      documentsTrashed: trashed,
      // Said out loud in the stored outcome, so an operator reading this row a
      // year later cannot mistake the flag for an erasure that happened or one
      // that is coming on a date.
      ...(scope === 'mark-for-erasure' ? { erasureRequested: true, erasureScheduled: false } : {}),
      ...(payload.reason == null ? {} : { reason: payload.reason }),
    });

    if (!business.isActive) {
      // Idempotent replay: the effect is already applied. No write — and that
      // includes the scope's write. A second approval must not re-trash
      // documents the accountant has since restored on purpose.
      return {
        changed: [{ entity: 'business', id: business.id }],
        alreadyApplied: true,
        followUps: [],
        detail: detail(false, 0),
      };
    }

    const now = new Date();

    // Guarded on `isActive: true` as well as the id — compare-and-swap shaped.
    // A lost race (the row went inactive between the read above and this
    // write) is a replay, not a failure and not a second effect.
    const updated = await db.business.updateMany({
      where: { id: business.id, isActive: true },
      data: {
        isActive: false,
        offboardedAt: now,
        ...(scope === 'mark-for-erasure' ? { erasureRequestedAt: now } : {}),
      },
    });

    // The scope's effect rides the SAME compare-and-swap: it runs only for the
    // approval that won the flip, so a lost race stays a clean replay rather
    // than a second pass over the documents.
    let trashed = 0;
    if (updated.count > 0 && scope === 'trash') {
      // `deletedAt: null` in the filter, and not merely in spirit: a document
      // the accountant already put in Trash keeps ITS OWN deletion moment, so
      // the retention window it is already serving is not silently restarted by
      // an offboard sweeping past it.
      const moved = await db.document.updateMany({
        where: { businessId: business.id, deletedAt: null },
        data: { deletedAt: now },
      });
      trashed = moved.count;
    }

    return {
      changed: [{ entity: 'business', id: business.id }],
      alreadyApplied: updated.count === 0,
      followUps: [],
      detail: detail(updated.count > 0, trashed),
    };
  },
};
