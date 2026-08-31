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

    const detail = (offboardedNow: boolean): NonNullable<ExecutionResult['detail']> => ({
      // Honest either way: the workspace IS offboarded after this executor
      // returns; `alreadyInactive` says whether this approval did it.
      offboarded: true,
      alreadyInactive: !offboardedNow,
      businessName: business.name,
      booksRetained: true,
      ...(payload.reason == null ? {} : { reason: payload.reason }),
    });

    if (!business.isActive) {
      // Idempotent replay: the effect is already applied. No write.
      return {
        changed: [{ entity: 'business', id: business.id }],
        alreadyApplied: true,
        followUps: [],
        detail: detail(false),
      };
    }

    // Guarded on `isActive: true` as well as the id — compare-and-swap shaped.
    // A lost race (the row went inactive between the read above and this
    // write) is a replay, not a failure and not a second effect.
    const updated = await db.business.updateMany({
      where: { id: business.id, isActive: true },
      data: { isActive: false },
    });

    return {
      changed: [{ entity: 'business', id: business.id }],
      alreadyApplied: updated.count === 0,
      followUps: [],
      detail: detail(updated.count > 0),
    };
  },
};
