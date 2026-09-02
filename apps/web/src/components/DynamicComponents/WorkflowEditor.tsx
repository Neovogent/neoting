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
import { defineMessages, useIntl } from 'react-intl';
import { commonActions } from '../../i18n/common';
import { useAppContext } from '../../context/AppContext';
import { parseWorkflow, WORKFLOW_EXAMPLES } from '../../lib/workflowParser';
import { Modal } from './Modal';
import { Field, Toggle } from './FormControls';
import type { ApprovalWorkflow } from '../../lib/types';

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
      'Anything over £500 needs a manager, and over £2,000 the Finance Director too. Auto-publish once approved.',
  },
  buildAction: { id: 'approvals.workflowEditor.buildAction', defaultMessage: 'Build the workflow' },
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
    defaultMessage: 'Clients this applies to',
  },
  noClientsWarning: {
    id: 'approvals.workflowEditor.noClientsWarning',
    defaultMessage: 'No client selected — nothing will pause for approval until one is.',
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
  // The sentence a freshly added branch carries, rendered immediately in the
  // row's editable label field. The figure is an argument rather than part of
  // the sentence so the copy and the `value` the rules engine tests cannot
  // drift apart — see BRANCH_TEMPLATE_AMOUNT.
  addBranchLabel: {
    id: 'approvals.workflowEditor.addBranchLabel',
    defaultMessage: 'Amount over {amount} adds the Finance Director',
  },
  noBranches: {
    id: 'approvals.workflowEditor.noBranches',
    defaultMessage: 'No branches — the chain is linear.',
  },
  selfApprovalToggle: {
    id: 'approvals.workflowEditor.selfApprovalToggle',
    defaultMessage: 'Allow self-approval',
  },
  autoPublishToggle: {
    id: 'approvals.workflowEditor.autoPublishToggle',
    defaultMessage: 'Auto-publish once approved',
  },
  autoPublishHint: {
    id: 'approvals.workflowEditor.autoPublishHint',
    defaultMessage: 'Approval always wins over an auto-publish rule, never the other way round.',
  },
  saveAction: { id: 'approvals.workflowEditor.saveAction', defaultMessage: 'Save workflow' },
});

/**
 * The threshold the "+ Add branch" template starts from.
 *
 * One constant because the figure appears twice in the row it creates — as the
 * machine-readable `value` the rules engine tests, and inside the sentence the
 * user reads — and a template whose words and figure disagree is worse than no
 * template at all.
 *
 * Formatted through `toLocaleString` rather than ICU's `::currency/GBP`
 * skeleton because that renders `£2,000.00`; this sentence has always said
 * `£2,000`, and #65 does not change visible copy.
 */
const BRANCH_TEMPLATE_AMOUNT = 2000;
const branchTemplateAmount = () => `£${BRANCH_TEMPLATE_AMOUNT.toLocaleString('en-GB')}`;
export function WorkflowEditor({ workflow, onSave, onClose }: { workflow: ApprovalWorkflow; onSave: (w: ApprovalWorkflow) => void; onClose: () => void }) {
  const { clients } = useAppContext();
  const intl = useIntl();
  const [draft, setDraft] = useState<ApprovalWorkflow>(workflow);
  const set = <K extends keyof ApprovalWorkflow>(k: K, v: ApprovalWorkflow[K]) => setDraft({ ...draft, [k]: v });

  const isNew = !workflow.name;
  const [describing, setDescribing] = useState(isNew);
  const [prompt, setPrompt] = useState('');
  const [read, setRead] = useState<{ understood: string[]; assumed: string[] } | null>(null);

  const build = () => {
    const parsed = parseWorkflow(prompt, draft);
    setDraft(parsed.workflow);
    setRead({ understood: parsed.understood, assumed: parsed.assumed });
    setDescribing(false);
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
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim()) build();
                }}
                rows={3}
                placeholder={intl.formatMessage(mEditor.describePlaceholder)}
                className="w-full bg-ground border border-white/5 rounded-2xl px-4 py-3 text-[13.5px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors resize-none"
              />
            </div>

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

            <div className="flex items-center gap-3">
              <button
                onClick={build}
                disabled={!prompt.trim()}
                className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-btn"
              >
                <Sparkles size={15} />
                {intl.formatMessage(mEditor.buildAction)}
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

          {/* Opt-in, one client at a time. A workflow with nobody ticked is
              inert by design, and says so rather than looking armed. */}
          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
              {intl.formatMessage(mEditor.clientsHeading)}
            </div>
            <div className="flex flex-wrap gap-2">
              {clients.map((c) => {
                const on = draft.clientIds.includes(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() =>
                      set('clientIds', on ? draft.clientIds.filter((id) => id !== c.id) : [...draft.clientIds, c.id])
                    }
                    className={`px-3.5 py-2 rounded-full text-[12.5px] font-bold border transition-colors ${
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
            {draft.clientIds.length === 0 && (
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
                    value={s.thresholdAbove ?? ''}
                    onChange={(e) => set('stages', draft.stages.map((x, j) => (j === i ? { ...x, thresholdAbove: e.target.value ? Number(e.target.value) : undefined } : x)))}
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

          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
                {intl.formatMessage(mEditor.branchesHeading)}
              </span>
              {/* `field`, `operator`, `value` and `addApprover` are all values
                  the rules engine reads — only `label` is read by a person. */}
              <button
                onClick={() =>
                  set('branches', [
                    ...draft.branches,
                    {
                      field: 'amount',
                      operator: '>',
                      value: String(BRANCH_TEMPLATE_AMOUNT),
                      addApprover: 'Finance Director',
                      label: intl.formatMessage(mEditor.addBranchLabel, { amount: branchTemplateAmount() }),
                    },
                  ])
                }
                className="text-[12px] font-bold text-brand hover:underline"
              >
                {intl.formatMessage(mEditor.addBranchAction)}
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {draft.branches.map((b, i) => (
                <div key={i} className="flex items-center gap-2 p-3 rounded-2xl bg-ground/60 border border-white/5">
                  <input
                    value={b.label}
                    onChange={(e) => set('branches', draft.branches.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                    className="flex-1 bg-transparent text-[12px] text-brand focus:outline-none min-w-0"
                  />
                  <button
                    onClick={() => set('branches', draft.branches.filter((_, j) => j !== i))}
                    aria-label={intl.formatMessage(mEditor.removeLabel)}
                    className="hit-area p-1.5 rounded-lg text-zinc-600 hover:text-red-400 transition-colors shrink-0"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {draft.branches.length === 0 && (
                <p className="text-[12px] text-zinc-600">{intl.formatMessage(mEditor.noBranches)}</p>
              )}
            </div>
          </div>

          <Toggle
            label={intl.formatMessage(mEditor.selfApprovalToggle)}
            value={draft.selfApproval}
            onChange={(v) => set('selfApproval', v)}
          />
          <Toggle
            label={intl.formatMessage(mEditor.autoPublishToggle)}
            hint={intl.formatMessage(mEditor.autoPublishHint)}
            value={draft.autoPublishOnApproval}
            onChange={(v) => set('autoPublishOnApproval', v)}
          />
        </div>

        <div className="p-4 bg-raised/50 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-full text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 transition-colors">
            {intl.formatMessage(commonActions.cancel)}
          </button>
          <button onClick={() => onSave(draft)} className="px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-all">
            {intl.formatMessage(mEditor.saveAction)}
          </button>
        </div>
      </div>
    </Modal>
  );
}