import type { PolicyActivatePayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * `policy.activate` — an approval workflow is armed, or disarmed (review
 * package H, 7 Sep 2026).
 *
 * ## Why this kind exists at all
 *
 * Everything else about a workflow — its name, its stages, its thresholds, its
 * branches — is written by ordinary `ingest`-class operations, because
 * composing a policy is an accountant's own work and D44 gives them that half
 * outright. What it does NOT give them is the gate itself. The moment a
 * workflow goes active, other people's documents stop and wait for a signature
 * that did not previously exist; the moment it goes inactive, a control a
 * client may be relying on disappears and their items flow straight through.
 * Both are changes to what the approval spine does, and Governance §10 admits
 * exactly one way to make one.
 *
 * That is also why there is one kind and not two. `active: false` is not the
 * safe direction here — it is the direction that removes a check — so routing
 * the two through the same review is the honest arrangement rather than a
 * convenience.
 *
 * ## What it does not do
 *
 * It writes one boolean. It does not touch the stages (an edit is a text edit,
 * through `PUT /approval-workflows/{id}`), it creates no `approvals` rows, and
 * it re-reads the workflow through RLS rather than trusting the proposal's
 * anchor — the route/chase.send guard, applied to a policy.
 */
export const activatePolicyExecutor: ProposalExecutor<'policy.activate', PolicyActivatePayload> = {
  kind: 'policy.activate',

  async execute(db: ScopedClient, input: ExecutionInput<PolicyActivatePayload>): Promise<ExecutionResult> {
    const { payload } = input;

    const workflow = await db.approvalWorkflow.findUnique({
      where: { id: payload.workflowId },
      select: { id: true, isActive: true, businessId: true },
    });
    // Unreachable and absent are the same refusal, and neither confirms that
    // the id names anything.
    if (workflow === null) {
      throw new ProposalExecutionRefused('policy.activate', 'that approval workflow is not reachable');
    }

    // Idempotent replay: the engine may retry after a crash between the effect
    // and the record, and an approval re-run must not report a second change.
    // A boolean has no proposal stamp to key on the way `rules` does, so the
    // idempotency check is the STATE — which is the honest test anyway: a
    // workflow already in the requested state has nothing left to do.
    if (workflow.isActive === payload.active) {
      return {
        changed: [{ entity: 'approvalWorkflow', id: workflow.id }],
        alreadyApplied: true,
        followUps: [],
      };
    }

    await db.approvalWorkflow.update({
      where: { id: workflow.id },
      data: { isActive: payload.active },
    });

    return {
      changed: [{ entity: 'approvalWorkflow', id: workflow.id }],
      alreadyApplied: false,
      followUps: [],
      detail: { workflowId: workflow.id, active: payload.active, businessId: workflow.businessId },
    };
  },
};
