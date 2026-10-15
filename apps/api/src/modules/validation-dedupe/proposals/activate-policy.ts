import type { ChasePolicySettings, PolicyActivatePayload } from '@neoting/contracts/model';

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

    // rush/chase-scheduler — the practice's chasing schedule rides the same
    // kind: it is a standing automation, and arming it is the gate.
    if (payload.chasePolicy !== undefined) {
      if (payload.workflowId !== undefined) {
        throw new ProposalExecutionRefused('policy.activate', 'name a workflow OR a chasing schedule, not both');
      }
      return activateChasePolicy(db, input, payload.chasePolicy);
    }
    if (payload.workflowId === undefined) {
      throw new ProposalExecutionRefused('policy.activate', 'names neither a workflow nor a chasing schedule');
    }

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

/**
 * Upsert the practice's `chase_policies` row — the ONLY writer of it. The
 * practice is the PROPOSAL's own anchor (read back by id, the `rule.create`
 * pattern), never a payload field. Idempotent by the proposal stamp: a replay
 * finds its own id on the row and reports `alreadyApplied`.
 */
async function activateChasePolicy(
  db: ScopedClient,
  input: ExecutionInput<PolicyActivatePayload>,
  settings: ChasePolicySettings,
): Promise<ExecutionResult> {
  const values = Object.values(settings);
  if (!values.every((v) => Number.isInteger(v))) {
    throw new ProposalExecutionRefused('policy.activate', 'every chasing-schedule setting is a whole number');
  }
  if (settings.secondReminderDays <= settings.firstReminderDays) {
    throw new ProposalExecutionRefused('policy.activate', 'the second reminder must come after the first');
  }

  const proposal = await db.actionProposal.findUnique({
    where: { id: input.proposalId },
    select: { practiceId: true },
  });
  const practiceId = proposal?.practiceId ?? null;
  if (practiceId === null) {
    throw new ProposalExecutionRefused('policy.activate', 'a chasing schedule belongs to a practice, and this proposal names none');
  }

  const existing = await db.chasePolicy.findUnique({ where: { practiceId }, select: { actionProposalId: true } });
  if (existing?.actionProposalId === input.proposalId) {
    return { changed: [{ entity: 'chasePolicy', id: practiceId }], alreadyApplied: true, followUps: [] };
  }

  const data = {
    enabled: input.payload.active,
    firstReminderDays: settings.firstReminderDays,
    secondReminderDays: settings.secondReminderDays,
    escalateAfterDays: settings.escalateAfterDays,
    maxReminders: settings.maxReminders,
    quietHoursStart: settings.quietHoursStart,
    quietHoursEnd: settings.quietHoursEnd,
    actionProposalId: input.proposalId,
  };
  await db.chasePolicy.upsert({ where: { practiceId }, create: { practiceId, ...data }, update: data });

  return {
    changed: [{ entity: 'chasePolicy', id: practiceId }],
    alreadyApplied: false,
    followUps: [],
    detail: { chasePolicy: true, ...data },
  };
}
