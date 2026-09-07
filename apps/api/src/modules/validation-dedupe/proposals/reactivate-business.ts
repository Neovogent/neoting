import type { BusinessReactivatePayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * `business.reactivate` — bring a removed client back (review item 67).
 *
 * > *"in the trash keep the client too for some days if any reason the client
 * > gets back the accountant can restart work form where left"*
 *
 * ## Why this kind exists at all
 *
 * `business.offboard` shipped with an entry in `assert-can.ts` that named its
 * own gap out loud — *"there is no `business.reactivate` kind yet, so the undo
 * is a later surface"* — and used that as half the argument for making
 * offboarding tier 1: a flag nobody in the product can flip back. This is that
 * day. Offboarding is now genuinely reversible from inside the product, by a
 * person, through the same Review → Approve spine that removed the client.
 *
 * ⚠ **It is the mirror of offboard, and deliberately nothing more.** There is
 * no `DELETE`, no hard write and no cascade anywhere near this file, exactly as
 * there is none in its counterpart. Two columns go back to where they were:
 * `is_active` to true, and the two offboarding stamps to NULL.
 *
 * ## ⚠ What it does NOT do: restore documents
 *
 * If the offboard ran with `documentScope: 'trash'`, those documents are in
 * Trash and **this executor leaves them there**. That is a limit with a reason
 * rather than an omission:
 *
 * `documents.deleted_at` records THAT a document was deleted, not which act
 * deleted it. A blanket `deletedAt: null` over the business would therefore
 * also resurrect every document a person had put in Trash deliberately, weeks
 * before the client was ever removed — including anything they trashed
 * precisely because it was rubbish. The executor cannot tell those apart, and
 * inventing a link table so it could would be a schema addition bought to
 * automate one click.
 *
 * The one click is the client's own Trash: it lists exactly these documents,
 * Restore is a bulk action on it, and each restored document comes back in the
 * state it left. The review card says this in as many words, because a card
 * that let a reviewer believe their documents were coming back with the client
 * would be the Review → Approve promise broken — what was shown is what
 * happens.
 *
 * ## Idempotent, and reachable
 *
 * The archive rule: a workspace that is already active is a replay, not a
 * second effect — no write, no second audit row, `alreadyApplied: true`. The
 * write is compare-and-swap shaped (`updateMany` guarded on `isActive: false`)
 * like every other write in this directory, so two racing approvals cannot both
 * report having restored the client.
 *
 * The business is resolved through the approver's RLS context first, and
 * `businesses_tenant` has no `isActive` branch — which is what makes an
 * offboarded workspace visible here at all, and is the same property offboard's
 * own replay path relies on. A workspace the approver cannot see and one that
 * does not exist are the same generic `NT-PRP-006` refusal (404-never-403,
 * applied to effects).
 */
export const reactivateBusinessExecutor: ProposalExecutor<'business.reactivate', BusinessReactivatePayload> = {
  kind: 'business.reactivate',

  async execute(db: ScopedClient, input: ExecutionInput<BusinessReactivatePayload>): Promise<ExecutionResult> {
    const { payload } = input;

    const business = await db.business.findUnique({
      where: { id: payload.businessId },
      select: { id: true, name: true, isActive: true, erasureRequestedAt: true },
    });
    if (business === null) {
      throw new ProposalExecutionRefused('business.reactivate', 'no reachable business');
    }

    // Captured BEFORE the write, not read off `business` inside `detail`: the
    // question is what was true when this executor arrived, and the row is about
    // to have the flag cleared out from under it.
    const hadErasureRequest = business.erasureRequestedAt !== null;

    const detail = (restoredNow: boolean): NonNullable<ExecutionResult['detail']> => ({
      // Honest either way, offboard's shape: the workspace IS active after this
      // returns; `alreadyActive` says whether this approval is what did it.
      reactivated: true,
      alreadyActive: !restoredNow,
      businessName: business.name,
      // The half a reviewer must not have to infer. Documents an offboard put
      // in Trash stay in Trash; the client's Trash is where they come back from.
      documentsRestored: false,
      // Worth recording when it was set, because clearing an erasure request is
      // a materially different act from restoring an ordinary removed client.
      ...(hadErasureRequest ? { erasureRequestCleared: true } : {}),
      ...(payload.reason == null ? {} : { reason: payload.reason }),
    });

    if (business.isActive) {
      return {
        changed: [{ entity: 'business', id: business.id }],
        alreadyApplied: true,
        followUps: [],
        detail: detail(false),
      };
    }

    const updated = await db.business.updateMany({
      where: { id: business.id, isActive: false },
      data: {
        isActive: true,
        // Both stamps cleared. A client removed twice must count its restore
        // window from the SECOND removal, and a practice that changed its mind
        // about erasure has changed its mind — leaving the flag set would leave
        // a live client marked for erasure, which no later surface should find.
        offboardedAt: null,
        erasureRequestedAt: null,
      },
    });

    return {
      changed: [{ entity: 'business', id: business.id }],
      alreadyApplied: updated.count === 0,
      followUps: [],
      detail: detail(updated.count > 0),
    };
  },
};
