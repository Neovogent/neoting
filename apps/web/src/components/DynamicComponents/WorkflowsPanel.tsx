import { useState } from 'react';
import { Plus, ScrollText } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import type { ApprovalWorkflowEditRequest, CreateActionProposalRequest } from '@neoting/contracts/model';
import { API_ENABLED } from '../../api/config';
import { draftWorkflow, useRules, useWorkflowWrites, useWorkflows } from '../../api/workflows';
import { useAppContext } from '../../context/AppContext';
import type { ApprovalWorkflow } from '../../lib/types';
import { Pill } from './DataTable';
import { LiveProposalFlow } from './LiveProposalFlow';
import { Modal } from './Modal';
import { useConfirm } from './ConfirmProvider';
import { WorkflowCard, blankWorkflow } from './WorkflowCard';
import { WorkflowEditor } from './WorkflowEditor';

/**
 * The **whole Workflows tab**, in one lazily-loaded chunk — cards, editor,
 * the coding-rules list, and the activation proposal.
 *
 * ## Why it is one component and why it is lazy
 *
 * `ApprovalsView` and `ClientDetailView` each carried their own copy of this
 * screen: two "New workflow" buttons, two delete confirmations, two editor
 * mounts, two subtly different card grids — and `ClientDetailView`'s rendered
 * `approvalWorkflows.map(…)` UNFILTERED, so every workflow in the practice
 * appeared on every client. One component is the fix for that class of bug,
 * not merely tidier.
 *
 * Lazy because it is the only thing that needs `api/workflows.ts`, and that
 * module touches the generated approvals client. `apps/web/CLAUDE.md`'s
 * reachability rule: anything a floor-reachable module imports ships on every
 * route. Both views reach this through `lazy()`, so the tab downloads on the
 * click that opens it — and pulling the card and the editor in here took them
 * OFF both routes' static graphs, which is why the package's web half is a net
 * reduction rather than a spend.
 *
 * ## The one behaviour worth reading before editing
 *
 * **Save writes a DRAFT. Turn on / Turn off stages a `policy.activate`
 * proposal.** They are different buttons because they are different acts:
 * composing a policy is an accountant's own work (D44's compose half), and
 * arming one decides what pauses for other people's approvals, which is a
 * state change on the approval spine and goes through Review → Approve like
 * every other one. The server enforces it — no write operation on the resource
 * accepts `isActive` — so this screen is describing the rule, not being it.
 */

const m = defineMessages({
  heading: { id: 'approvals.workflowsPanel.heading', defaultMessage: 'Workflows' },
  intro: {
    id: 'approvals.workflowsPanel.intro',
    defaultMessage:
      'Approvals are opt-in. With no active workflow this client has no approval step at all — items go Ready → released with nothing pausing.',
  },
  newWorkflow: { id: 'approvals.workflowsPanel.newWorkflow', defaultMessage: 'New workflow' },
  empty: {
    id: 'approvals.workflowsPanel.empty',
    defaultMessage: 'No workflows yet. Nothing pauses for approval until one is created and turned on.',
  },
  loading: { id: 'approvals.workflowsPanel.loading', defaultMessage: 'Loading workflows…' },
  loadFailed: {
    id: 'approvals.workflowsPanel.loadFailed',
    defaultMessage: 'The workflows could not be loaded. {error}',
  },
  saveFailed: { id: 'approvals.workflowsPanel.saveFailed', defaultMessage: 'That did not save. {error}' },
  deleteTitle: { id: 'approvals.workflowsPanel.deleteTitle', defaultMessage: 'Delete the "{name}" workflow?' },
  deleteDetail: {
    id: 'approvals.workflowsPanel.deleteDetail',
    defaultMessage: 'Items already waiting under it keep their history. Nothing new will pause under it again.',
  },
  deleteConsequence: {
    id: 'approvals.workflowsPanel.deleteConsequence',
    defaultMessage: 'An active workflow cannot be deleted — turn it off first, which goes through approval.',
  },
  deleteConfirm: { id: 'approvals.workflowsPanel.deleteConfirm', defaultMessage: 'Yes, delete it' },
  // ── The activation proposal ────────────────────────────────────────────
  activateHeading: { id: 'approvals.workflowsPanel.activateHeading', defaultMessage: 'Turn on "{name}"' },
  deactivateHeading: { id: 'approvals.workflowsPanel.deactivateHeading', defaultMessage: 'Turn off "{name}"' },
  activateDetail: {
    id: 'approvals.workflowsPanel.activateDetail',
    defaultMessage:
      'From the moment this is approved, matching items stop and wait for the approvers below. That is a change to what your approval queue does, so it goes through Review → Approve like anything else.',
  },
  deactivateDetail: {
    id: 'approvals.workflowsPanel.deactivateDetail',
    defaultMessage:
      'From the moment this is approved, matching items stop pausing. Turning a control off needs the same signature as turning it on, so it goes through Review → Approve.',
  },
  activateStage: { id: 'approvals.workflowsPanel.activateStage', defaultMessage: 'Send for approval' },
  // ── The rules list (review item 51 §4) ─────────────────────────────────
  rulesHeading: { id: 'approvals.workflowsPanel.rulesHeading', defaultMessage: 'Coding rules in force' },
  rulesIntro: {
    id: 'approvals.workflowsPanel.rulesIntro',
    defaultMessage:
      'What an approved rule actually produced. Every one of these codes documents on its own from the next matching upload.',
  },
  rulesEmpty: {
    id: 'approvals.workflowsPanel.rulesEmpty',
    defaultMessage: 'No coding rules yet. Ask the assistant to make one, or say "make it a rule" on a corrected document.',
  },
  ruleVia: { id: 'approvals.workflowsPanel.ruleVia', defaultMessage: 'from {origin}' },
  ruleEveryDocument: { id: 'approvals.workflowsPanel.ruleEveryDocument', defaultMessage: 'Every document in scope' },
  rulesRetire: {
    id: 'approvals.workflowsPanel.rulesRetire',
    defaultMessage: 'Read-only for now — retiring a rule is its own approval and is not built yet.',
  },
});

export default function WorkflowsPanel({
  /** One client's workflows, or every one the caller can reach. */
  businessId,
  /** Pending approvals per workflow, for the card's queue count. */
  usageFor,
}: {
  businessId?: string | undefined;
  usageFor?: ((workflowId: string) => number) | undefined;
}) {
  const intl = useIntl();
  const { approvalWorkflows, saveWorkflow, deleteWorkflow, logAudit } = useAppContext();
  const confirm = useConfirm();

  const live = useWorkflows({ enabled: API_ENABLED, ...(businessId === undefined ? {} : { businessId }) });
  const writes = useWorkflowWrites(businessId);
  const { rules } = useRules({ enabled: API_ENABLED, ...(businessId === undefined ? {} : { businessId }) });

  const [editing, setEditing] = useState<ApprovalWorkflow | null>(null);
  const [activating, setActivating] = useState<ApprovalWorkflow | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * ⚠ The synthetic list is filtered by client HERE and always was not — this
   * is review item 51 §4's incidental find. `ClientDetailView` rendered every
   * workflow in the practice on every client's Approvals tab, so a policy
   * pointed at American Burger appeared on Ananda Group's screen looking as
   * though it governed them.
   */
  const workflows = API_ENABLED
    ? live.workflows
    : approvalWorkflows.filter((w) => businessId === undefined || w.businessId === businessId);

  const onSave = async (w: ApprovalWorkflow) => {
    setSaveError(null);
    if (!API_ENABLED) {
      saveWorkflow(w);
      setEditing(null);
      return;
    }
    // ⚠ Optionals are dropped rather than sent as `undefined`. The app type
    // and the contract's differ only in `exactOptionalPropertyTypes`, and
    // `JSON.stringify` would drop them anyway — spelling it here is what keeps
    // the request typed rather than cast.
    const body: ApprovalWorkflowEditRequest = {
      name: w.name,
      appliesTo: w.appliesTo,
      specificity: w.specificity,
      selfApproval: w.selfApproval,
      stages: w.stages.map((stage) => ({
        name: stage.name,
        approver: stage.approver,
        canEdit: stage.canEdit,
        ...(stage.thresholdAbovePence === undefined ? {} : { thresholdAbovePence: stage.thresholdAbovePence }),
        ...(stage.clientSide === undefined ? {} : { clientSide: stage.clientSide }),
      })),
      branches: w.branches.map((branch) => ({
        field: branch.field,
        addApprover: branch.addApprover,
        label: branch.label,
        ...(branch.thresholdAbovePence === undefined ? {} : { thresholdAbovePence: branch.thresholdAbovePence }),
        ...(branch.value === undefined ? {} : { value: branch.value }),
      })),
    };
    try {
      // A workflow whose id is not on the server yet is a create. `isNew` is
      // read off the LIST rather than off an id prefix: `blankWorkflow` mints a
      // placeholder id the server never sees, and a prefix test would be a
      // second rule about what an id means.
      if (workflows.some((existing) => existing.id === w.id)) await writes.replace(w.id, body);
      else await writes.create({ ...body, businessId: w.businessId });
      setEditing(null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  const onDelete = async (w: ApprovalWorkflow) => {
    const ok = await confirm({
      title: intl.formatMessage(m.deleteTitle, { name: w.name }),
      detail: intl.formatMessage(m.deleteDetail),
      consequence: intl.formatMessage(m.deleteConsequence),
      confirmLabel: intl.formatMessage(m.deleteConfirm),
    });
    if (!ok) return;
    setSaveError(null);
    if (!API_ENABLED) {
      deleteWorkflow(w.id);
      return;
    }
    try {
      await writes.remove(w.id);
      logAudit({ action: intl.formatMessage(m.deleteTitle, { name: w.name }), scope: w.name, reviewOpened: true });
    } catch (error) {
      // The expected refusal is `NT-WFL-001` — the workflow is still armed.
      // It is shown rather than swallowed, because the fix is a different act
      // (turn it off, through approval) and the person has to be told which.
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h3 className="font-sans font-bold text-lg text-white tracking-tight">{intl.formatMessage(m.heading)}</h3>
          <p className="text-[12.5px] text-zinc-500 mt-1 max-w-xl leading-relaxed">{intl.formatMessage(m.intro)}</p>
        </div>
        <button
          onClick={() => setEditing(blankWorkflow(intl, businessId ?? ''))}
          className="shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-btn"
        >
          <Plus size={15} />
          {intl.formatMessage(m.newWorkflow)}
        </button>
      </div>

      {saveError !== null && (
        <p className="text-[12.5px] text-red-400 font-semibold">
          {intl.formatMessage(m.saveFailed, { error: saveError })}
        </p>
      )}
      {live.contractError !== null && (
        <p className="text-[12.5px] text-red-400 font-semibold">
          {intl.formatMessage(m.loadFailed, { error: live.contractError })}
        </p>
      )}

      {API_ENABLED && live.isLoading ? (
        <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.loading)}</p>
      ) : workflows.length === 0 ? (
        <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.empty)}</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {workflows.map((w) => (
            <WorkflowCard
              key={w.id}
              workflow={w}
              usage={usageFor?.(w.id) ?? 0}
              onEdit={() => setEditing(w)}
              onToggle={() => (API_ENABLED ? setActivating(w) : saveWorkflow({ ...w, isActive: !w.isActive }))}
              onDelete={() => void onDelete(w)}
            />
          ))}
        </div>
      )}

      {/* ── Coding rules (review item 51 §4) ────────────────────────────────
          `rule.create` has been approvable since METH S13 and the row it wrote
          was visible NOWHERE afterwards: no operation listed it and no screen
          rendered it. A rule that starts coding a client's documents
          unattended and cannot be seen cannot be audited or retired. */}
      {API_ENABLED && (
        <div className="pt-2">
          <div className="flex items-center gap-2 mb-1">
            <ScrollText size={14} className="text-zinc-500" />
            <h3 className="font-sans font-bold text-lg text-white tracking-tight">
              {intl.formatMessage(m.rulesHeading)}
            </h3>
          </div>
          <p className="text-[12.5px] text-zinc-500 mb-4 max-w-xl leading-relaxed">{intl.formatMessage(m.rulesIntro)}</p>
          {rules.length === 0 ? (
            <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.rulesEmpty)}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex items-center gap-3 p-3 rounded-2xl bg-ground/60 border border-white/5 flex-wrap"
                >
                  <span className="text-[13px] font-bold text-white truncate">
                    {rule.scopeKey ?? intl.formatMessage(m.ruleEveryDocument)}
                  </span>
                  <span className="text-[12px] text-zinc-500">→</span>
                  {/* `sets` is an open record in the contract, so this renders
                      what is there rather than asserting a shape. */}
                  <span className="text-[12.5px] text-brand truncate">
                    {Object.entries(rule.sets ?? {})
                      .map(([field, value]) => `${field} ${String(value)}`)
                      .join(' · ')}
                  </span>
                  {rule.createdVia != null && (
                    <Pill>{intl.formatMessage(m.ruleVia, { origin: rule.createdVia })}</Pill>
                  )}
                </div>
              ))}
              <p className="text-[11.5px] text-zinc-600 mt-1">{intl.formatMessage(m.rulesRetire)}</p>
            </div>
          )}
        </div>
      )}

      {editing && <WorkflowEditor workflow={editing} onSave={(w) => void onSave(w)} onClose={() => setEditing(null)} />}

      {activating && (
        <ActivationDialog workflow={activating} onClose={() => setActivating(null)} />
      )}
    </div>
  );
}

/**
 * Arming or disarming a workflow, through the ordinary proposal spine.
 *
 * `LiveProposalFlow` is the whole implementation — it stages, renders the
 * server's own review and enforces the release authority, including the super
 * admin's inline fast path. Nothing about `policy.activate` needed a second
 * flow; it needed a payload and a sentence.
 */
function ActivationDialog({ workflow, onClose }: { workflow: ApprovalWorkflow; onClose: () => void }) {
  const intl = useIntl();
  const { clients } = useAppContext();
  const next = !workflow.isActive;
  const clientName = clients.find((c) => c.id === workflow.businessId)?.name ?? null;

  const buildRequest = (): CreateActionProposalRequest => ({
    kind: 'policy.activate',
    businessId: workflow.businessId,
    payload: { workflowId: workflow.id, active: next },
  });

  return (
    <Modal onClose={onClose} width="max-w-lg">
      <div className="w-full bg-card border border-white/10 rounded-[28px] p-6 shadow-2xl">
        <h3 className="font-sans font-bold text-lg text-white tracking-tight">
          {intl.formatMessage(next ? m.activateHeading : m.deactivateHeading, { name: workflow.name })}
        </h3>
        <p className="text-[13px] text-zinc-500 leading-relaxed mt-2 mb-5">
          {intl.formatMessage(next ? m.activateDetail : m.deactivateDetail)}
        </p>
        <LiveProposalFlow
          buildRequest={buildRequest}
          clientName={clientName}
          stageLabel={intl.formatMessage(m.activateStage)}
          onExecuted={onClose}
        />
      </div>
    </Modal>
  );
}

// Re-exported so a caller that already has the panel does not need a second
// import to open the describe flow from elsewhere (review item 51's chat
// hand-off uses it).
export { draftWorkflow };
