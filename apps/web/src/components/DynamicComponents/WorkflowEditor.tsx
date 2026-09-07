/**
 * The approval-workflow EDITOR, extracted out of `views/ApprovalsView.tsx`.
 *
 * It is its own module, separate from `./WorkflowCard`, for one reason: it is a
 * modal that opens on a click, it is the heaviest thing on the Workflows tab,
 * and both `ApprovalsView` and `ClientDetailView` were carrying it in their
 * STATIC import graph — i.e. every visitor to either route downloaded the whole
 * editor before the route could paint, whether or not they ever opened it. Both
 * call sites now reach it through `lazy()`. Do not merge this file back into
 * `WorkflowCard`, and do not import it eagerly: `ClientDetailView` is one of the
 * two routes that were over the 250,000 B budget, and this is part of how they
 * got back under it. See `apps/web/CLAUDE.md` → *Bundle*.
 *
 * Nothing about the markup or the copy changed in the move; the message ids are
 * the ones already in `lang/en-GB.json`.
 */
import { useState } from 'react';
import { Check, Sparkles, Trash2 } from 'lucide-react';
import { defineMessages, useIntl, type IntlShape } from 'react-intl';
import { commonActions } from '../../i18n/common';
import { useAppContext } from '../../context/AppContext';
import { API_ENABLED } from '../../api/config';
import { draftWorkflow } from '../../api/workflows';
import { parseWorkflow, WORKFLOW_EXAMPLES } from '../../lib/workflowParser';
import { Modal } from './Modal';
import { Field, Toggle } from './FormControls';
import type { ApprovalBranch, ApprovalWorkflow } from '../../lib/types';

const mEditor = defineMessages({
  editHeading: { id: 'approvals.workflowEditor.editHeading', defaultMessage: 'Edit workflow' },
  newHeading: { id: 'approvals.workflowEditor.newHeading', defaultMessage: 'New workflow' },
  subheading: {
    id: 'approvals.workflowEditor.subheading',
    defaultMessage: 'No stage cap · branches allowed · practice-side approvers',
  },
  describeAction: { id: 'approvals.workflowEditor.describeAction', defaultMessage: 'Describe it instead' },
  describeHeading: { id: 'approvals.workflowEditor.describeHeading', defaultMessage: 'Describe the policy' },
  describePlaceholder: {
    id: 'approvals.workflowEditor.describePlaceholder',
    defaultMessage:
      'Anything over £500 needs a manager, and over £2,000 the Finance Director too.',
  },
  buildAction: { id: 'approvals.workflowEditor.buildAction', defaultMessage: 'Build the workflow' },
  buildingAction: { id: 'approvals.workflowEditor.buildingAction', defaultMessage: 'Reading it…' },
  describeNeedsClient: {
    id: 'approvals.workflowEditor.describeNeedsClient',
    defaultMessage: 'Pick the client first — a policy is compiled against their own chart of accounts.',
  },
  buildFailed: { id: 'approvals.workflowEditor.buildFailed', defaultMessage: '{error}' },
  refusedHeading: {
    id: 'approvals.workflowEditor.refusedHeading',
    defaultMessage: 'That could not be turned into a workflow',
  },
  manualAction: { id: 'approvals.workflowEditor.manualAction', defaultMessage: 'Set it up by hand' },
  readHeading: {
    id: 'approvals.workflowEditor.readHeading',
    defaultMessage: 'Filled in from your description',
  },
  readNote: {
    id: 'approvals.workflowEditor.readNote',
    defaultMessage: 'Every field below is editable — change anything that is not what you meant.',
  },
  nameLabel: { id: 'approvals.workflowEditor.nameLabel', defaultMessage: 'Name' },
  appliesToLabel: { id: 'approvals.workflowEditor.appliesToLabel', defaultMessage: 'Applies to' },
  clientsHeading: {
    id: 'approvals.workflowEditor.clientsHeading',
    defaultMessage: 'Client this applies to',
  },
  noClientsWarning: {
    id: 'approvals.workflowEditor.noClientsWarning',
    defaultMessage: 'Pick the client this governs — one workflow, one client.',
  },
  clientLocked: {
    id: 'approvals.workflowEditor.clientLocked',
    defaultMessage: 'Fixed when the workflow was created — pointing a policy at a different client is a new workflow, not an edit.',
  },
  stagesHeading: { id: 'approvals.workflowEditor.stagesHeading', defaultMessage: 'Stages' },
  stageNameLabel: { id: 'approvals.workflowEditor.stageNameLabel', defaultMessage: 'Stage name' },
  approverLabel: { id: 'approvals.workflowEditor.approverLabel', defaultMessage: 'Approver' },
  thresholdLabel: { id: 'approvals.workflowEditor.thresholdLabel', defaultMessage: 'Threshold above' },
  removeLabel: { id: 'approvals.workflowEditor.removeLabel', defaultMessage: 'Remove' },
  addStageAction: { id: 'approvals.workflowEditor.addStageAction', defaultMessage: '+ Add stage' },
  // The name a freshly added stage carries. It is pushed into state and lands
  // straight in the editable name field, so it is read before it is changed —
  // copy, not a placeholder attribute. Its sibling `approver: 'Manager'` is
  // deliberately NOT here; see the note on the button.
  newStageName: { id: 'approvals.workflowEditor.newStageName', defaultMessage: 'New stage' },
  thresholdPlaceholder: {
    id: 'approvals.workflowEditor.thresholdPlaceholder',
    defaultMessage: 'threshold',
  },
  clientSideTitle: {
    id: 'approvals.workflowEditor.clientSideTitle',
    defaultMessage: 'Approved by the business, from an emailed link',
  },
  practiceSideTitle: {
    id: 'approvals.workflowEditor.practiceSideTitle',
    defaultMessage: 'Approved inside the practice',
  },
  clientSideLabel: { id: 'approvals.workflowEditor.clientSideLabel', defaultMessage: 'Client' },
  practiceSideLabel: { id: 'approvals.workflowEditor.practiceSideLabel', defaultMessage: 'Practice' },
  canEditBlockedTitle: {
    id: 'approvals.workflowEditor.canEditBlockedTitle',
    defaultMessage: 'A client-side approver never edits the coding',
  },
  canEditTitle: {
    id: 'approvals.workflowEditor.canEditTitle',
    defaultMessage: 'Can this approver correct the coding?',
  },
  canEditLabel: { id: 'approvals.workflowEditor.canEditLabel', defaultMessage: 'Can edit' },
  branchesHeading: {
    id: 'approvals.workflowEditor.branchesHeading',
    defaultMessage: 'Conditional branches',
  },
  addBranchAction: { id: 'approvals.workflowEditor.addBranchAction', defaultMessage: '+ Add branch' },
  branchFieldLabel: { id: 'approvals.workflowEditor.branchFieldLabel', defaultMessage: 'Condition' },
  branchFieldAmount: { id: 'approvals.workflowEditor.branchFieldAmount', defaultMessage: 'Amount over' },
  branchFieldSupplierAge: {
    id: 'approvals.workflowEditor.branchFieldSupplierAge',
    defaultMessage: 'A brand-new supplier',
  },
  branchFieldCategory: { id: 'approvals.workflowEditor.branchFieldCategory', defaultMessage: 'Category is' },
  branchAmountLabel: { id: 'approvals.workflowEditor.branchAmountLabel', defaultMessage: 'Amount in pounds' },
  branchCategoryLabel: { id: 'approvals.workflowEditor.branchCategoryLabel', defaultMessage: 'Category' },
  branchCategoryPlaceholder: {
    id: 'approvals.workflowEditor.branchCategoryPlaceholder',
    defaultMessage: 'e.g. Computer Equipment',
  },
  branchAdds: { id: 'approvals.workflowEditor.branchAdds', defaultMessage: 'adds' },
  branchApproverLabel: { id: 'approvals.workflowEditor.branchApproverLabel', defaultMessage: 'Approver this adds' },
  branchApproverPlaceholder: {
    id: 'approvals.workflowEditor.branchApproverPlaceholder',
    defaultMessage: 'e.g. Finance Director',
  },
  // The derived sentence, one message per condition. Composed rather than
  // typed: the label and the condition the rules engine tests come out of the
  // same object, so they cannot drift apart the way an editable label could.
  branchLabelAmount: {
    id: 'approvals.workflowEditor.branchLabelAmount',
    defaultMessage: 'Amount over {amount} adds {approver}',
  },
  branchLabelSupplierAge: {
    id: 'approvals.workflowEditor.branchLabelSupplierAge',
    defaultMessage: 'A brand-new supplier adds {approver}',
  },
  branchLabelCategory: {
    id: 'approvals.workflowEditor.branchLabelCategory',
    defaultMessage: 'Category {category} adds {approver}',
  },
  branchIncomplete: {
    id: 'approvals.workflowEditor.branchIncomplete',
    defaultMessage: 'Finish this branch — it needs a value and an approver.',
  },
  branchDuplicate: {
    id: 'approvals.workflowEditor.branchDuplicate',
    defaultMessage:
      '“{label}” is in this workflow twice. Two identical branches add the same approver twice.',
  },
  saveBlocked: {
    id: 'approvals.workflowEditor.saveBlocked',
    defaultMessage: 'Finish or remove the unfinished branches first.',
  },
  noBranches: {
    id: 'approvals.workflowEditor.noBranches',
    defaultMessage: 'No branches — the chain is linear.',
  },
  selfApprovalToggle: {
    id: 'approvals.workflowEditor.selfApprovalToggle',
    defaultMessage: 'Allow self-approval',
  },
  releaseNote: {
    id: 'approvals.workflowEditor.releaseNote',
    defaultMessage:
      'Clearing the last stage approves the item. Releasing it for export stays a separate act, and only your super admin can do it.',
  },
  saveAction: { id: 'approvals.workflowEditor.saveAction', defaultMessage: 'Save workflow' },
});

/** A fresh branch row — deliberately EMPTY, so nothing is created by clicking. */
const BLANK_BRANCH: ApprovalBranch = { field: 'amount', addApprover: '', label: '' };

/** Switching the condition clears the operand that belonged to the old one. */
function blankFor(field: ApprovalBranch['field']): Partial<ApprovalBranch> {
  return { field, thresholdAbovePence: undefined, value: undefined };
}

/**
 * The sentence, DERIVED from the condition — never typed.
 *
 * This is item 53's real fix. The old row let a person edit the label while
 * `field`/`value`/`addApprover` stayed whatever the template had put there, so
 * a branch could read "Over £5,000 adds the Partner" and actually add the
 * Finance Director at £2,000. An incomplete branch gets an EMPTY label,
 * which is what the save guard keys on.
 */
function withLabel(branch: ApprovalBranch, intl: IntlShape): ApprovalBranch {
  const approver = branch.addApprover.trim();
  if (approver === '') return { ...branch, label: '' };

  if (branch.field === 'amount') {
    if (branch.thresholdAbovePence === undefined || branch.thresholdAbovePence <= 0) return { ...branch, label: '' };
    return {
      ...branch,
      label: intl.formatMessage(mEditor.branchLabelAmount, {
        // Pounds on screen from pence in the value; `toLocaleString` rather
        // than an ICU currency skeleton because that renders £2,000.00 and
        // these sentences have always said £2,000.
        amount: POUND + (branch.thresholdAbovePence / 100).toLocaleString('en-GB'),
        approver,
      }),
    };
  }
  if (branch.field === 'category') {
    const category = (branch.value ?? '').trim();
    if (category === '') return { ...branch, label: '' };
    return { ...branch, label: intl.formatMessage(mEditor.branchLabelCategory, { category, approver }) };
  }
  // `supplierAge` has no operand — "new" is the only thing it can test —
  // so the value is stamped here rather than asked for.
  return {
    ...branch,
    value: 'new',
    label: intl.formatMessage(mEditor.branchLabelSupplierAge, { approver }),
  };
}

/**
 * The first label this workflow carries twice, or null.
 *
 * Two identical branches add the same approver twice, which is a policy nobody
 * means — and duplicating one was the whole of what "+ Add branch" could
 * do before this. Surfaced as a warning rather than a refusal: the composer
 * cannot know whether the person is mid-edit on the second one.
 */
function firstDuplicate(branches: readonly ApprovalBranch[]): string | null {
  const seen = new Set<string>();
  for (const branch of branches) {
    if (branch.label === '') continue;
    if (seen.has(branch.label)) return branch.label;
    seen.add(branch.label);
  }
  return null;
}

/** Not copy — a currency symbol inside a derived sentence. */
const POUND = '\u00a3';

export function WorkflowEditor({ workflow, onSave, onClose }: { workflow: ApprovalWorkflow; onSave: (w: ApprovalWorkflow) => void; onClose: () => void }) {
  const { clients } = useAppContext();
  const intl = useIntl();
  const [draft, setDraft] = useState<ApprovalWorkflow>(workflow);
  const set = <K extends keyof ApprovalWorkflow>(k: K, v: ApprovalWorkflow[K]) => setDraft({ ...draft, [k]: v });

  const duplicateBranch = firstDuplicate(draft.branches);
  // An unfinished branch is one whose derived label came out empty. Save is
  // blocked rather than the row being dropped: silently discarding a condition
  // somebody typed half of is how a policy ships missing a rule.
  const unfinishedBranches = draft.branches.some((b) => b.label === '');
  const canSave = draft.name.trim() !== '' && draft.businessId !== '' && !unfinishedBranches;

  const isNew = !workflow.name;
  const [describing, setDescribing] = useState(isNew);
  const [prompt, setPrompt] = useState('');
  const [read, setRead] = useState<{ understood: string[]; assumed: string[] } | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  /**
   * "Describe it instead" — review item 52.
   *
   * ⚠ **With the API on this is a SERVER call to the pinned model**
   * (`POST /v1/approval-workflows/draft`), compiled against this client's own
   * chart of accounts and refusing a category that is not on it. The local
   * `parseWorkflow` survives for SYNTHETIC mode only, where there is no server
   * to ask; it recognises the vocabulary it was written for and little else,
   * which is the defect this replaces.
   *
   * Either way the result fills an EDITABLE form and saves an inert workflow —
   * so a wrong reading costs a correction, never a policy in force.
   */
  const build = async () => {
    if (!API_ENABLED) {
      const parsed = parseWorkflow(prompt, draft);
      setDraft(parsed.workflow);
      setRead({ understood: parsed.understood, assumed: parsed.assumed });
      setDescribing(false);
      return;
    }
    setBuilding(true);
    setBuildError(null);
    try {
      const result = await draftWorkflow(draft.businessId, prompt);
      if (result.status === 'refused') {
        // A refusal is an ANSWER, not an error: the model read the description
        // and will not guess at a category this client does not have. It stays
        // on the describe panel with the reason, because the next move is to
        // re-word — not to fall through to a half-filled form.
        setBuildError(result.reason ?? '');
        return;
      }
      const workflow = result.workflow;
      if (workflow === undefined) return;
      setDraft({
        ...draft,
        name: workflow.name,
        appliesTo: workflow.appliesTo,
        specificity: workflow.specificity,
        selfApproval: workflow.selfApproval,
        stages: workflow.stages,
        branches: workflow.branches,
      });
      setRead({ understood: result.understood, assumed: result.assumed });
      setDescribing(false);
    } catch (error) {
      setBuildError(error instanceof Error ? error.message : String(error));
    } finally {
      setBuilding(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-2xl border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5 flex items-start justify-between gap-4">
          <div>
            <h3 className="font-sans font-bold text-xl text-white tracking-tight">
              {intl.formatMessage(workflow.name ? mEditor.editHeading : mEditor.newHeading)}
            </h3>
            <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
              {intl.formatMessage(mEditor.subheading)}
            </p>
          </div>
          {!describing && (
            <button
              onClick={() => setDescribing(true)}
              className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-brand bg-brand/10 border border-brand/20 hover:bg-brand/20 transition-colors"
            >
              <Sparkles size={13} />
              {intl.formatMessage(mEditor.describeAction)}
            </button>
          )}
        </div>

        {/* Describe the policy in a sentence and the fields below fill in.
            Every one stays editable — the parse is a starting point, not an
            answer, which is why the reading of it is shown alongside. */}
        {describing && (
          <div className="p-6 border-b border-white/5 flex flex-col gap-4">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
                <Sparkles size={12} className="text-brand" />
                {intl.formatMessage(mEditor.describeHeading)}
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim()) void build();
                }}
                rows={3}
                placeholder={intl.formatMessage(mEditor.describePlaceholder)}
                className="w-full bg-ground border border-white/5 rounded-2xl px-4 py-3 text-[13.5px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors resize-none"
              />
            </div>

            {API_ENABLED && draft.businessId === '' && (
              <p className="text-[11.5px] text-amber-400 font-semibold">
                {intl.formatMessage(mEditor.describeNeedsClient)}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {WORKFLOW_EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => setPrompt(ex)}
                  className="px-3 py-1.5 rounded-full text-[11px] font-semibold text-zinc-400 bg-ground border border-white/5 hover:text-white hover:border-white/20 transition-colors text-left max-w-full truncate"
                >
                  {ex}
                </button>
              ))}
            </div>

            {buildError !== null && (
              <div className="p-4 rounded-2xl bg-amber-500/[0.07] border border-amber-500/25 flex flex-col gap-1">
                <div className="text-[11px] font-bold text-amber-400 uppercase tracking-widest">
                  {intl.formatMessage(mEditor.refusedHeading)}
                </div>
                <p className="text-[12.5px] text-zinc-300 leading-relaxed">
                  {intl.formatMessage(mEditor.buildFailed, { error: buildError })}
                </p>
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={() => void build()}
                disabled={!prompt.trim() || building || (API_ENABLED && draft.businessId === '')}
                title={API_ENABLED && draft.businessId === '' ? intl.formatMessage(mEditor.describeNeedsClient) : undefined}
                className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-btn"
              >
                <Sparkles size={15} />
                {intl.formatMessage(building ? mEditor.buildingAction : mEditor.buildAction)}
              </button>
              {!isNew || draft.stages.length > 0 ? (
                <button
                  onClick={() => setDescribing(false)}
                  className="px-4 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
                >
                  {intl.formatMessage(mEditor.manualAction)}
                </button>
              ) : null}
              <span className="text-[11px] text-zinc-600 font-semibold ml-auto">⌘↵</span>
            </div>
          </div>
        )}

        {/* What the description was taken to mean, and what it did not say. */}
        {read && !describing && (
          <div className="px-6 pt-5">
            <div className="p-4 rounded-2xl bg-brand/[0.06] border border-brand/20 flex flex-col gap-2">
              <div className="text-[11px] font-bold text-brand uppercase tracking-widest">
                {intl.formatMessage(mEditor.readHeading)}
              </div>
              {read.understood.map((u) => (
                <div key={u} className="text-[12.5px] text-zinc-300 flex items-start gap-2">
                  <Check size={13} className="text-brand mt-0.5 shrink-0" strokeWidth={3} />
                  {u}
                </div>
              ))}
              {read.assumed.map((a) => (
                <div key={a} className="text-[12.5px] text-zinc-500 flex items-start gap-2">
                  <span className="text-zinc-600 mt-0.5 shrink-0">·</span>
                  {a}
                </div>
              ))}
              <p className="text-[12px] text-zinc-500 leading-relaxed mt-1">
                {intl.formatMessage(mEditor.readNote)}
              </p>
            </div>
          </div>
        )}

        <div className="p-6 flex flex-col gap-5 max-h-[55dvh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={intl.formatMessage(mEditor.nameLabel)} value={draft.name} onChange={(v) => set('name', v)} />
            <Field label={intl.formatMessage(mEditor.appliesToLabel)} value={draft.appliesTo} onChange={(v) => set('appliesTo', v)} />
          </div>

          {/* ONE client (review package H) — prisma's shape, and the reason
              ClientDetailView used to show every practice workflow on every
              client. Fixed once the workflow exists: re-pointing a policy at
              a different client is a new policy, not a text edit, and the
              contract has no field for it on the replace request. */}
          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
              {intl.formatMessage(mEditor.clientsHeading)}
            </div>
            <div className="flex flex-wrap gap-2">
              {clients.map((c) => {
                const on = draft.businessId === c.id;
                return (
                  <button
                    key={c.id}
                    disabled={!isNew}
                    title={isNew ? undefined : intl.formatMessage(mEditor.clientLocked)}
                    onClick={() => set('businessId', c.id)}
                    className={`px-3.5 py-2 rounded-full text-[12.5px] font-bold border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      on
                        ? 'text-brand bg-brand/10 border-brand/30'
                        : 'text-zinc-400 bg-ground/60 border-white/5 hover:text-white'
                    }`}
                  >
                    {on ? '✓ ' : ''}{c.name}
                  </button>
                );
              })}
            </div>
            {draft.businessId === '' && (
              <p className="text-[11.5px] text-amber-400 font-semibold mt-2">
                {intl.formatMessage(mEditor.noClientsWarning)}
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
                {intl.formatMessage(mEditor.stagesHeading)}
              </span>
              {/* `approver: 'Manager'` stays English on purpose: it is a value,
                  not copy. `workflowParser`'s APPROVERS list matches it out of a
                  description, `isClientSide` tests it lowercased, and approver
                  strings are compared with `===` (see `a.approver === 'You'`
                  above), so a translated one would stop matching. */}
              <button
                onClick={() =>
                  set('stages', [
                    ...draft.stages,
                    { name: intl.formatMessage(mEditor.newStageName), approver: 'Manager', canEdit: false },
                  ])
                }
                className="text-[12px] font-bold text-brand hover:underline"
              >
                {intl.formatMessage(mEditor.addStageAction)}
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {draft.stages.map((s, i) => (
                <div key={i} className="flex items-center gap-2 p-3 rounded-2xl bg-ground/60 border border-white/5 flex-wrap">
                  <input
                    value={s.name}
                    aria-label={intl.formatMessage(mEditor.stageNameLabel)}
                    onChange={(e) => set('stages', draft.stages.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    className="flex-1 basis-full sm:basis-auto min-w-[8rem] bg-transparent text-[13px] font-bold text-white focus:outline-none py-1"
                  />
                  <input
                    value={s.approver}
                    aria-label={intl.formatMessage(mEditor.approverLabel)}
                    onChange={(e) => set('stages', draft.stages.map((x, j) => (j === i ? { ...x, approver: e.target.value } : x)))}
                    className="flex-1 sm:flex-none min-w-0 sm:w-32 bg-card border border-white/5 rounded-lg px-2 py-1.5 text-[12px] text-zinc-300 focus:outline-none focus:border-brand"
                  />
                  <input
                    type="number"
                    inputMode="decimal"
                    aria-label={intl.formatMessage(mEditor.thresholdLabel)}
                    placeholder={intl.formatMessage(mEditor.thresholdPlaceholder)}
                    /* Pounds on screen, PENCE in the value — the app's one
                       money boundary, at the control. `Math.round` is what
                       keeps `12.345` from becoming a fractional penny. */
                    value={s.thresholdAbovePence === undefined ? '' : s.thresholdAbovePence / 100}
                    onChange={(e) =>
                      set(
                        'stages',
                        draft.stages.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                ...(e.target.value === ''
                                  ? { thresholdAbovePence: undefined }
                                  : { thresholdAbovePence: Math.round(Number(e.target.value) * 100) }),
                              }
                            : x,
                        ),
                      )
                    }
                    className="w-24 bg-card border border-white/5 rounded-lg px-2 py-1.5 text-[12px] text-zinc-300 focus:outline-none focus:border-brand"
                  />
                  {/* Whether this stage leaves the practice. A client-side
                      stage is delivered by SMS + OTP, so it can never edit. */}
                  <button
                    onClick={() =>
                      set('stages', draft.stages.map((x, j) =>
                        j === i ? { ...x, clientSide: !x.clientSide, canEdit: x.clientSide ? x.canEdit : false } : x,
                      ))
                    }
                    title={intl.formatMessage(s.clientSide ? mEditor.clientSideTitle : mEditor.practiceSideTitle)}
                    className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-bold border transition-colors ${
                      s.clientSide
                        ? 'text-brand bg-brand/10 border-brand/25'
                        : 'text-zinc-500 border-white/5 hover:text-white hover:border-white/15'
                    }`}
                  >
                    {intl.formatMessage(s.clientSide ? mEditor.clientSideLabel : mEditor.practiceSideLabel)}
                  </button>
                  <button
                    onClick={() => set('stages', draft.stages.map((x, j) => (j === i ? { ...x, canEdit: !x.canEdit } : x)))}
                    disabled={s.clientSide}
                    title={intl.formatMessage(s.clientSide ? mEditor.canEditBlockedTitle : mEditor.canEditTitle)}
                    className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-bold border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                      s.canEdit
                        ? 'text-brand bg-brand/10 border-brand/25'
                        : 'text-zinc-500 border-white/5 hover:text-white hover:border-white/15'
                    }`}
                  >
                    {intl.formatMessage(mEditor.canEditLabel)}
                  </button>
                  <button
                    onClick={() => set('stages', draft.stages.filter((_, j) => j !== i))}
                    aria-label={intl.formatMessage(mEditor.removeLabel)}
                    className="hit-area p-1.5 rounded-lg text-zinc-600 hover:text-red-400 transition-colors shrink-0"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* ⚠ **THE BRANCH COMPOSER — review item 53.**
              "+ Add branch" used to push ONE hardcoded object ("Amount over
              £2,000 adds the Finance Director") and the only editable thing on
              the row was its `label` — so clicking it twice produced two
              identical branches, and editing the sentence changed the words a
              person reads without touching the condition the engine tests.
              Each row is now the composer: the condition is chosen, and the
              LABEL IS DERIVED from it, so the two cannot disagree. */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
                {intl.formatMessage(mEditor.branchesHeading)}
              </span>
              <button
                onClick={() => set('branches', [...draft.branches, BLANK_BRANCH])}
                className="text-[12px] font-bold text-brand hover:underline"
              >
                {intl.formatMessage(mEditor.addBranchAction)}
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {draft.branches.map((b, i) => {
                const editBranch = (next: Partial<ApprovalBranch>) =>
                  set(
                    'branches',
                    draft.branches.map((x, j) => (j === i ? withLabel({ ...x, ...next }, intl) : x)),
                  );
                return (
                  <div key={i} className="flex flex-col gap-2 p-3 rounded-2xl bg-ground/60 border border-white/5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <select
                        value={b.field}
                        aria-label={intl.formatMessage(mEditor.branchFieldLabel)}
                        onChange={(e) => editBranch(blankFor(e.target.value as ApprovalBranch['field']))}
                        className="bg-card border border-white/5 rounded-lg px-2 py-1.5 text-[12px] text-zinc-300 focus:outline-none focus:border-brand"
                      >
                        <option value="amount">{intl.formatMessage(mEditor.branchFieldAmount)}</option>
                        <option value="supplierAge">{intl.formatMessage(mEditor.branchFieldSupplierAge)}</option>
                        <option value="category">{intl.formatMessage(mEditor.branchFieldCategory)}</option>
                      </select>

                      {/* The condition's own operand. An amount is money and a
                          category is a name, so they are different controls
                          rather than one string field that has to mean both;
                          a new supplier has no operand at all. */}
                      {b.field === 'amount' && (
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          aria-label={intl.formatMessage(mEditor.branchAmountLabel)}
                          placeholder={intl.formatMessage(mEditor.thresholdPlaceholder)}
                          value={b.thresholdAbovePence === undefined ? '' : b.thresholdAbovePence / 100}
                          onChange={(e) =>
                            editBranch(
                              e.target.value === ''
                                ? { thresholdAbovePence: undefined }
                                : { thresholdAbovePence: Math.round(Number(e.target.value) * 100) },
                            )
                          }
                          className="w-28 bg-card border border-white/5 rounded-lg px-2 py-1.5 text-[12px] text-zinc-300 focus:outline-none focus:border-brand"
                        />
                      )}
                      {b.field === 'category' && (
                        <input
                          value={b.value ?? ''}
                          aria-label={intl.formatMessage(mEditor.branchCategoryLabel)}
                          placeholder={intl.formatMessage(mEditor.branchCategoryPlaceholder)}
                          onChange={(e) => editBranch({ value: e.target.value })}
                          className="flex-1 min-w-[8rem] bg-card border border-white/5 rounded-lg px-2 py-1.5 text-[12px] text-zinc-300 focus:outline-none focus:border-brand"
                        />
                      )}

                      <span className="text-[12px] text-zinc-500">{intl.formatMessage(mEditor.branchAdds)}</span>
                      <input
                        value={b.addApprover}
                        aria-label={intl.formatMessage(mEditor.branchApproverLabel)}
                        placeholder={intl.formatMessage(mEditor.branchApproverPlaceholder)}
                        onChange={(e) => editBranch({ addApprover: e.target.value })}
                        className="flex-1 min-w-[8rem] bg-card border border-white/5 rounded-lg px-2 py-1.5 text-[12px] text-zinc-300 focus:outline-none focus:border-brand"
                      />
                      <button
                        onClick={() => set('branches', draft.branches.filter((_, j) => j !== i))}
                        aria-label={intl.formatMessage(mEditor.removeLabel)}
                        className="hit-area p-1.5 rounded-lg text-zinc-600 hover:text-red-400 transition-colors shrink-0 ml-auto"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {/* The sentence, derived and READ-ONLY. It was an editable
                        input, which is how a branch could say one thing and do
                        another. */}
                    <p className="text-[12px] text-brand">
                      {b.label === '' ? intl.formatMessage(mEditor.branchIncomplete) : b.label}
                    </p>
                  </div>
                );
              })}
              {draft.branches.length === 0 && (
                <p className="text-[12px] text-zinc-600">{intl.formatMessage(mEditor.noBranches)}</p>
              )}
              {duplicateBranch !== null && (
                <p className="text-[11.5px] text-amber-400 font-semibold">
                  {intl.formatMessage(mEditor.branchDuplicate, { label: duplicateBranch })}
                </p>
              )}
            </div>
          </div>

          <Toggle
            label={intl.formatMessage(mEditor.selfApprovalToggle)}
            value={draft.selfApproval}
            onChange={(v) => set('selfApproval', v)}
          />
          {/* ⚠ There was an "Auto-publish once approved" toggle here, and
              deleting it is the fix rather than the loss (review item 52 §3):
              D42 removed auto-publish from this release and D44 reserves
              release for the super admin, so the switch could not do what its
              name said. What replaces it is a sentence, not a control. */}
          <p className="text-[12px] text-zinc-500 leading-relaxed">{intl.formatMessage(mEditor.releaseNote)}</p>
        </div>

        <div className="p-4 bg-raised/50 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-full text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 transition-colors">
            {intl.formatMessage(commonActions.cancel)}
          </button>
          <button
            onClick={() => onSave(draft)}
            disabled={!canSave}
            title={unfinishedBranches ? intl.formatMessage(mEditor.saveBlocked) : undefined}
            className="px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {intl.formatMessage(mEditor.saveAction)}
          </button>
        </div>
      </div>
    </Modal>
  );
}