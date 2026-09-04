/**
 * The approval-workflow CARD and the blank-workflow template, extracted out of
 * `views/ApprovalsView.tsx`, where they used to live.
 *
 * ## Why they moved
 *
 * `ClientDetailView` renders a client's workflows too, and was reaching them
 * with `import { WorkflowCard, blankWorkflow } from './ApprovalsView'`. Rollup
 * cannot shake a 1,900-line view module down to two exports, so it emitted a
 * bare side-effect import of the WHOLE `ApprovalsView` chunk (15.9 kB gzip) and
 * dragged `DocumentPreview`, `LiveProposalCard`, `ReviewGate` and `Tooltip`
 * behind it — the bug class `apps/web/CLAUDE.md` records under
 * *`import { Modal } from './ApprovalsView'` costs ~32 kB gzip a route*. Both
 * views now import the card from here and neither pays for the other's screen.
 *
 * The editor is deliberately a SEPARATE module (`./WorkflowEditor`): it is a
 * modal, roughly three times this file's weight, and no route needs it on
 * arrival. Keep that split — merging them would put the editor back on both
 * routes' static graph.
 *
 * Nothing about the markup or the copy changed in the move; the message ids are
 * the ones already in `lang/en-GB.json`.
 */
import { GitBranch, Trash2 } from 'lucide-react';
import { defineMessages, useIntl, type IntlShape } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { Pill } from './DataTable';
import { currency } from '../../lib/resolver';
import type { ApprovalWorkflow } from '../../lib/types';

const mCard = defineMessages({
  noClients: {
    id: 'approvals.workflowCard.noClients',
    defaultMessage: 'No client opted in — this stops nothing',
  },
  statusActive: { id: 'approvals.workflowCard.statusActive', defaultMessage: 'Active' },
  statusPaused: { id: 'approvals.workflowCard.statusPaused', defaultMessage: 'Paused' },
  stagesHeading: { id: 'approvals.workflowCard.stagesHeading', defaultMessage: 'Stages' },
  clientStage: { id: 'approvals.workflowCard.clientStage', defaultMessage: 'Client · email link' },
  // The threshold and the edit right are independent of each other, so the
  // four readings are four messages rather than one with two inserted clauses.
  stageAlways: { id: 'approvals.workflowCard.stageAlways', defaultMessage: '{approver} · always' },
  stageAlwaysCanEdit: {
    id: 'approvals.workflowCard.stageAlwaysCanEdit',
    defaultMessage: '{approver} · always · can edit',
  },
  stageThreshold: {
    id: 'approvals.workflowCard.stageThreshold',
    defaultMessage: '{approver} · only when over {amount}',
  },
  stageThresholdCanEdit: {
    id: 'approvals.workflowCard.stageThresholdCanEdit',
    defaultMessage: '{approver} · only when over {amount} · can edit',
  },
  branchingHeading: {
    id: 'approvals.workflowCard.branchingHeading',
    defaultMessage: 'Conditional branching',
  },
  autoPublish: { id: 'approvals.workflowCard.autoPublish', defaultMessage: 'Auto-publish once approved' },
  selfApprovalAllowed: {
    id: 'approvals.workflowCard.selfApprovalAllowed',
    defaultMessage: 'Self-approval allowed',
  },
  selfApprovalBlocked: {
    id: 'approvals.workflowCard.selfApprovalBlocked',
    defaultMessage: 'No self-approval',
  },
  specificity: { id: 'approvals.workflowCard.specificity', defaultMessage: 'Specificity {level}' },
  editAction: { id: 'approvals.workflowCard.editAction', defaultMessage: 'Edit' },
  pauseAction: { id: 'approvals.workflowCard.pauseAction', defaultMessage: 'Pause' },
  activateAction: { id: 'approvals.workflowCard.activateAction', defaultMessage: 'Activate' },
  usage: { id: 'approvals.workflowCard.usage', defaultMessage: '{count} in queue' },
});
export function WorkflowCard({ workflow, usage, onEdit, onToggle, onDelete }: {
  workflow: ApprovalWorkflow; usage: number; onEdit: () => void; onToggle: () => void; onDelete: () => void;
}) {
  const { clients } = useAppContext();
  const intl = useIntl();
  return (
    <div className="border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
      <div className="p-6 flex items-start justify-between gap-4 border-b border-white/5">
        <div className="min-w-0">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">{workflow.name}</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider truncate">{workflow.appliesTo}</p>
          {/* Who it governs. Approvals are opt-in per client, so a workflow
              naming nobody stops nothing however active it looks. */}
          <p className="text-[12px] mt-1 font-semibold truncate">
            {workflow.clientIds.length ? (
              <span className="text-zinc-400">
                {workflow.clientIds.map((id) => clients.find((c) => c.id === id)?.name ?? id).join(' · ')}
              </span>
            ) : (
              <span className="text-amber-400">{intl.formatMessage(mCard.noClients)}</span>
            )}
          </p>
        </div>
        {workflow.active ? (
          <Pill tone="green">{intl.formatMessage(mCard.statusActive)}</Pill>
        ) : (
          <Pill>{intl.formatMessage(mCard.statusPaused)}</Pill>
        )}
      </div>

      <div className="p-6 flex flex-col gap-4">
        <div>
          <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
            {intl.formatMessage(mCard.stagesHeading)}
          </div>
          <div className="flex flex-col gap-2">
            {workflow.stages.map((s, i) => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-2xl bg-ground/60 border border-white/5">
                <span className="w-6 h-6 rounded-lg bg-raised text-[11px] font-bold text-zinc-400 flex items-center justify-center shrink-0">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-bold text-white truncate flex items-center gap-2">
                    {s.name}
                    {/* Which side of the relationship this stage sits on is the
                        most consequential thing about it — it decides whether
                        the item leaves the practice by SMS. */}
                    {s.clientSide && <Pill tone="amber">{intl.formatMessage(mCard.clientStage)}</Pill>}
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    {intl.formatMessage(
                      s.thresholdAbove
                        ? s.canEdit
                          ? mCard.stageThresholdCanEdit
                          : mCard.stageThreshold
                        : s.canEdit
                        ? mCard.stageAlwaysCanEdit
                        : mCard.stageAlways,
                      {
                        approver: s.approver,
                        amount: s.thresholdAbove ? currency(s.thresholdAbove) : '',
                      },
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {workflow.branches.length > 0 && (
          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3 flex items-center gap-1.5">
              <GitBranch size={11} /> {intl.formatMessage(mCard.branchingHeading)}
            </div>
            <div className="flex flex-col gap-2">
              {workflow.branches.map((b, i) => (
                <div key={i} className="text-[12px] text-brand bg-brand/[0.07] border border-brand/20 rounded-xl px-3 py-2">
                  {b.label}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {workflow.autoPublishOnApproval && <Pill tone="blue">{intl.formatMessage(mCard.autoPublish)}</Pill>}
          {workflow.selfApproval ? (
            <Pill>{intl.formatMessage(mCard.selfApprovalAllowed)}</Pill>
          ) : (
            <Pill>{intl.formatMessage(mCard.selfApprovalBlocked)}</Pill>
          )}
          <Pill>{intl.formatMessage(mCard.specificity, { level: workflow.specificity })}</Pill>
        </div>
      </div>

      <div className="p-4 bg-raised/50 flex items-center gap-3 flex-wrap">
        <button onClick={onEdit} className="px-5 py-2.5 rounded-2xl text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-colors">
          {intl.formatMessage(mCard.editAction)}
        </button>
        <button onClick={onToggle} className="px-4 py-2.5 rounded-2xl text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5 transition-colors">
          {intl.formatMessage(workflow.active ? mCard.pauseAction : mCard.activateAction)}
        </button>
        <button onClick={onDelete} className="p-2.5 rounded-2xl text-zinc-500 hover:text-red-400 hover:bg-white/5 transition-colors">
          <Trash2 size={16} />
        </button>
        <span className="ml-auto text-[12px] text-zinc-600 font-semibold">
          {intl.formatMessage(mCard.usage, { count: usage })}
        </span>
      </div>
    </div>
  );
}
const mBlank = defineMessages({
  stageName: { id: 'approvals.blankWorkflow.stageName', defaultMessage: 'Manager review' },
});

/**
 * The template behind every "New workflow" button.
 *
 * `intl` is a parameter because this is a plain function and cannot hold a
 * hook (§12.6). It is *optional* only while #65 is mid-flight: `ClientDetailView`
 * also calls this and belongs to another lane, so the argument cannot be made
 * required without breaking that file from here. Omitted, the stage name falls
 * back to the descriptor's own `defaultMessage`, which is the en-GB source text
 * and therefore renders exactly what shipped before. Make it required — and pass
 * `intl` at ClientDetailView's call site — once that lane lands.
 */
export function blankWorkflow(intl?: IntlShape): ApprovalWorkflow {
  return {
    id: `wf-${Date.now()}`,
    name: '',
    appliesTo: 'All cost items',
    // A new workflow governs nobody until a client is named — opt-in means
    // opt-in, so it cannot start by capturing the whole practice.
    clientIds: [],
    specificity: 1,
    // The approver starts empty: prefilling a person invents a colleague the
    // practice may not have — the editor makes the user pick one (launch M8).
    stages: [
      {
        name: intl ? intl.formatMessage(mBlank.stageName) : String(mBlank.stageName.defaultMessage),
        approver: '',
        canEdit: true,
      },
    ],
    branches: [],
    selfApproval: false,
    autoPublishOnApproval: false,
    active: true,
  };
}