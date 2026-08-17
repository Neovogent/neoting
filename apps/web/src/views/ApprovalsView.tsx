import { useMemo, useState } from 'react';
import {
  CheckCircle, X, GitBranch, Plus, Trash2, ShieldCheck, Lock, Clock, Search, Send, Download,
  Smartphone, Sparkles, Check, MessageSquare, Eye, FileWarning,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl, type IntlShape, type MessageDescriptor } from 'react-intl';
import { useAppContext } from '../context/AppContext';
import { fromSlug, slug, useSegment } from '../lib/router';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { currency } from '../lib/resolver';
import { parseWorkflow, WORKFLOW_EXAMPLES } from '../lib/workflowParser';
import { ConfirmStep } from '../components/DynamicComponents/ConfirmStep';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import type { ApprovalItem, ApprovalWorkflow, Document } from '../lib/types';
import { Tooltip } from '../components/DynamicComponents/Tooltip';
import { DocumentPreview } from '../components/DynamicComponents/DocumentPreview';
import { EXPORT_HINT } from '../lib/exportRules';

const TABS = ['Queue', 'Workflows', 'History'] as const;
type Tab = (typeof TABS)[number];

/**
 * A tab name is also its URL slug — `fromSlug(tabSlug, TABS)` round-trips the
 * union through the address bar — so the union stays English and only the label
 * shown on the button is translated.
 */
const mTab = defineMessages({
  queue: { id: 'approvals.tabLabel.queue', defaultMessage: 'Queue' },
  workflows: { id: 'approvals.tabLabel.workflows', defaultMessage: 'Workflows' },
  history: { id: 'approvals.tabLabel.history', defaultMessage: 'History' },
});

// Descriptors, not text: a hook cannot be called at module scope, so each label
// is formatted where its tab is rendered.
const TAB_LABEL: Record<Tab, MessageDescriptor> = {
  Queue: mTab.queue,
  Workflows: mTab.workflows,
  History: mTab.history,
};

const m = defineMessages({
  heading: { id: 'approvals.approvalsView.heading', defaultMessage: 'Approvals' },
  summary: {
    id: 'approvals.approvalsView.summary',
    defaultMessage: '{count} pending · {total} · {aging} aging over 5 days',
  },
  clientFilterAll: { id: 'approvals.approvalsView.clientFilterAll', defaultMessage: 'All clients' },
  newWorkflowAction: { id: 'approvals.approvalsView.newWorkflowAction', defaultMessage: 'New workflow' },
  scopeMine: { id: 'approvals.approvalsView.scopeMine', defaultMessage: 'Waiting on me' },
  scopeAll: { id: 'approvals.approvalsView.scopeAll', defaultMessage: 'All pending' },
  searchPlaceholder: {
    id: 'approvals.approvalsView.searchPlaceholder',
    defaultMessage: 'Search supplier or approver...',
  },
  columnSupplier: { id: 'approvals.approvalsView.columnSupplier', defaultMessage: 'Supplier' },
  columnClient: { id: 'approvals.approvalsView.columnClient', defaultMessage: 'Client' },
  columnStage: { id: 'approvals.approvalsView.columnStage', defaultMessage: 'Stage' },
  columnApprover: { id: 'approvals.approvalsView.columnApprover', defaultMessage: 'Approver' },
  columnBranching: { id: 'approvals.approvalsView.columnBranching', defaultMessage: 'Branching' },
  columnWaiting: { id: 'approvals.approvalsView.columnWaiting', defaultMessage: 'Waiting' },
  columnTotal: { id: 'approvals.approvalsView.columnTotal', defaultMessage: 'Total' },
  waitingDays: { id: 'approvals.approvalsView.waitingDays', defaultMessage: '{days}d' },
  viewAction: { id: 'approvals.approvalsView.viewAction', defaultMessage: 'View' },
  viewTitle: {
    id: 'approvals.approvalsView.viewTitle',
    defaultMessage: 'Open the document — every extracted field with its confidence',
  },
  noDocumentLabel: { id: 'approvals.approvalsView.noDocumentLabel', defaultMessage: 'No document attached' },
  noDocumentDetail: {
    id: 'approvals.approvalsView.noDocumentDetail',
    defaultMessage:
      'This approval was raised without a document behind it, so there is nothing to open. Approving it signs for the figures on this row alone.',
  },
  noDocumentPill: { id: 'approvals.approvalsView.noDocumentPill', defaultMessage: 'No doc' },
  emptyMine: {
    id: 'approvals.approvalsView.emptyMine',
    defaultMessage: 'Nothing waiting on you. Switch to All pending to see the rest of the practice.',
  },
  emptyAll: { id: 'approvals.approvalsView.emptyAll', defaultMessage: 'Nothing awaiting approval.' },
  exportAction: { id: 'approvals.approvalsView.exportAction', defaultMessage: 'Export CSV' },
  approveSelectedAction: {
    id: 'approvals.approvalsView.approveSelectedAction',
    defaultMessage: 'Approve selected',
  },
  // Two whole footers rather than one with an optional tail: the clause about
  // the client is a sentence of its own in every language but this one.
  queueFooter: {
    id: 'approvals.approvalsView.queueFooter',
    defaultMessage: '{count} pending • click a row for the stage detail',
  },
  queueFooterWithClient: {
    id: 'approvals.approvalsView.queueFooterWithClient',
    defaultMessage: '{count} pending • click a row for the stage detail • {clientCount} with the client',
  },
  bulkApproveRequest: {
    id: 'approvals.approvalsView.bulkApproveRequest',
    defaultMessage: 'Approve {count} pending items',
  },
  bulkApproveReply: {
    id: 'approvals.approvalsView.bulkApproveReply',
    defaultMessage:
      'Read the review to see exactly what will be approved. Approvals override every auto-publish path.',
  },
  deleteWorkflowTitle: {
    id: 'approvals.approvalsView.deleteWorkflowTitle',
    defaultMessage: 'Delete the "{name}" workflow?',
  },
  deleteWorkflowDetail: {
    id: 'approvals.approvalsView.deleteWorkflowDetail',
    defaultMessage: '{count, plural, one {# stage} other {# stages}}, applying to {appliesTo}.',
  },
  deleteWorkflowConsequence: {
    id: 'approvals.approvalsView.deleteWorkflowConsequence',
    defaultMessage: 'Items on it stop pausing for approval and publish straight through.',
  },
  deleteWorkflowConfirm: {
    id: 'approvals.approvalsView.deleteWorkflowConfirm',
    defaultMessage: 'Yes, delete it',
  },
  deleteWorkflowAudit: {
    id: 'approvals.approvalsView.deleteWorkflowAudit',
    defaultMessage: 'Deleted approval workflow',
  },
  workflowsBlurb: {
    id: 'approvals.approvalsView.workflowsBlurb',
    defaultMessage:
      'No cap on how many workflows you can run, and stages can branch on conditions — the two things that push firms onto ApprovalMax.',
  },
  columnOutcome: { id: 'approvals.approvalsView.columnOutcome', defaultMessage: 'Outcome' },
  outcomeApproved: { id: 'approvals.approvalsView.outcomeApproved', defaultMessage: 'Approved' },
  outcomeRejected: { id: 'approvals.approvalsView.outcomeRejected', defaultMessage: 'Rejected' },
  columnReason: { id: 'approvals.approvalsView.columnReason', defaultMessage: 'Reason' },
  readNoteAction: { id: 'approvals.approvalsView.readNoteAction', defaultMessage: 'Read the note' },
  columnLocked: { id: 'approvals.approvalsView.columnLocked', defaultMessage: 'Locked' },
  lockedPill: { id: 'approvals.approvalsView.lockedPill', defaultMessage: 'Locked' },
  historyEmpty: {
    id: 'approvals.approvalsView.historyEmpty',
    defaultMessage: 'Nothing decided yet in this session.',
  },
  approveAudit: { id: 'approvals.approvalsView.approveAudit', defaultMessage: 'Passed approval stage' },
  approveAuditScope: {
    id: 'approvals.approvalsView.approveAuditScope',
    defaultMessage: '{supplier} — {client}',
  },
  rejectAudit: { id: 'approvals.approvalsView.rejectAudit', defaultMessage: 'Rejected item' },
  rejectAuditScope: {
    id: 'approvals.approvalsView.rejectAuditScope',
    defaultMessage: '{supplier} — {reason}',
  },
  editRequest: {
    id: 'approvals.approvalsView.editRequest',
    defaultMessage: 'Review the {supplier} document before I approve it',
  },
  editReply: {
    id: 'approvals.approvalsView.editReply',
    defaultMessage:
      'Click any value to correct it — the item stays on its approval stage until you pass it.',
  },
  saveWorkflowAudit: {
    id: 'approvals.approvalsView.saveWorkflowAudit',
    defaultMessage: 'Saved approval workflow',
  },
  closePreviewLabel: {
    id: 'approvals.approvalsView.closePreviewLabel',
    defaultMessage: 'Close the document',
  },
});

export function ApprovalsView() {
  const intl = useIntl();
  const {
    approvals, approvalWorkflows, clients, saveWorkflow, deleteWorkflow,
    advanceApproval, rejectApproval, startConversation, logAudit, documents,
  } = useAppContext();

  /** The document an approver is looking at before deciding. */
  const [preview, setPreview] = useState<Document | null>(null);
  const documentFor = (a: ApprovalItem) => documents.find((d) => d.id === a.documentId);

  // The sub-tab is the second path segment, so every one has a link.
  const [tabSlug, setTabSlug] = useSegment(1);
  const tab: Tab = fromSlug(tabSlug, TABS) ?? 'Queue';
  const setTab = (next: Tab) => setTabSlug(next === 'Queue' ? null : slug(next));
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [clientFilter, setClientFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<ApprovalItem | null>(null);
  const [noteFor, setNoteFor] = useState<ApprovalItem | null>(null);
  const confirm = useConfirm();
  const [editing, setEditing] = useState<ApprovalWorkflow | null>(null);

  /**
   * The stage an item sits on, which decides both whether the current user can
   * edit it and whether it has left the practice for the client to sign off.
   */
  const stageOf = (a: ApprovalItem) =>
    approvalWorkflows.find((w) => w.id === a.workflowId)?.stages[a.stageIndex];

  const allPending = useMemo(() => {
    const q = query.trim().toLowerCase();
    return approvals.filter((a) => {
      if (a.state !== 'pending') return false;
      if (clientFilter !== 'all' && a.clientId !== clientFilter) return false;
      if (q && !`${a.supplier} ${a.clientName} ${a.approver}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [approvals, clientFilter, query]);

  /**
   * Wireframe screen 12 opens on "Waiting on me" — an approver should never
   * have to read past other people's queue to find their own. Items sitting on
   * a client-side stage are nobody in the practice's to approve, so they are
   * excluded from both practice views and shown separately.
   */
  const waitingOnClient = allPending.filter((a) => stageOf(a)?.clientSide);
  const practicePending = allPending.filter((a) => !stageOf(a)?.clientSide);
  const mine = practicePending.filter((a) => a.approver === 'You');
  const pending = scope === 'mine' ? mine : practicePending;

  /**
   * Resolved out here so the detail panel can be given the workflow or nothing
   * at all — an item whose workflow has since been deleted draws no stage rail
   * rather than an empty one.
   */
  const detailWorkflow = detail ? approvalWorkflows.find((w) => w.id === detail.workflowId) : undefined;

  const history = approvals.filter((a) => a.state !== 'pending');
  const totalPending = pending.reduce((n, a) => n + a.total, 0);
  const aging = pending.filter((a) => a.waitingDays >= 5).length;

  const bulkApprove = (rows: ApprovalItem[]) => {
    const ids = [...new Set(rows.map((r) => r.clientId))];
    const names = clients.filter((c) => ids.includes(c.id)).map((c) => c.name);
    startConversation(ids, [
      { id: `${Date.now()}-u`, role: 'user', content: intl.formatMessage(m.bulkApproveRequest, { count: rows.length }) },
      {
        id: `${Date.now()}-a`,
        role: 'assistant',
        content: intl.formatMessage(m.bulkApproveReply),
        intent: 'APPROVE_ITEMS',
        payload: { clientIds: ids, clientNames: names, query: '' },
      },
    ]);
  };

  const columns: Column<ApprovalItem>[] = [
    {
      key: 'supplier', label: intl.formatMessage(m.columnSupplier), sortValue: (a) => a.supplier,
      render: (a) => {
        const doc = documentFor(a);
        return (
          <span>
            <span className="block text-white font-semibold">{a.supplier}</span>
            {/* The date as well as the category: two rows for the same
                supplier at the same amount are otherwise indistinguishable,
                and an approver cannot tell which one they just approved. */}
            <span className="block text-[11px] text-zinc-500 font-medium">
              {[doc?.date, a.category !== '—' ? a.category : null].filter(Boolean).join(' · ') || '—'}
            </span>
          </span>
        );
      },
    },
    { key: 'clientName', label: intl.formatMessage(m.columnClient), sortValue: (a) => a.clientName },
    { key: 'stage', label: intl.formatMessage(m.columnStage), sortValue: (a) => a.stage },
    { key: 'approver', label: intl.formatMessage(m.columnApprover), sortValue: (a) => a.approver },
    {
      key: 'branch', label: intl.formatMessage(m.columnBranching),
      render: (a) =>
        a.addedByBranch.length ? (
          <span className="flex flex-wrap gap-1">
            {a.addedByBranch.map((b) => (
              <Pill key={b} tone="blue">+{b}</Pill>
            ))}
          </span>
        ) : (
          <span className="text-zinc-700">—</span>
        ),
    },
    {
      key: 'waitingDays', label: intl.formatMessage(m.columnWaiting), align: 'right', sortValue: (a) => a.waitingDays,
      render: (a) =>
        a.waitingDays >= 5 ? (
          <Pill tone="red">{intl.formatMessage(m.waitingDays, { days: a.waitingDays })}</Pill>
        ) : (
          <Pill>{intl.formatMessage(m.waitingDays, { days: a.waitingDays })}</Pill>
        ),
    },
    {
      key: 'total', label: intl.formatMessage(m.columnTotal), align: 'right', sortValue: (a) => a.total,
      render: (a) => <span className="text-white font-bold tabular-nums">{currency(a.total)}</span>,
    },
    {
      key: 'view', label: '', align: 'right',
      render: (a) => {
        const doc = documentFor(a);
        // Approving is signing for a document. Not being able to open the
        // thing you are signing for is the gap this closes.
        return doc ? (
          <button
            onClick={(e) => { e.stopPropagation(); setPreview(doc); }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold text-zinc-400 border border-white/10 hover:text-white hover:border-white/25 transition-colors whitespace-nowrap"
            title={intl.formatMessage(m.viewTitle)}
          >
            <Eye size={13} />
            {intl.formatMessage(m.viewAction)}
          </button>
        ) : (
          <Tooltip
            label={intl.formatMessage(m.noDocumentLabel)}
            detail={intl.formatMessage(m.noDocumentDetail)}
          >
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold text-amber-400 bg-amber-400/10 whitespace-nowrap cursor-help">
              <FileWarning size={13} />
              {intl.formatMessage(m.noDocumentPill)}
            </span>
          </Tooltip>
        );
      },
    },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-hidden">
      <header className="px-10 pt-8 pb-5 shrink-0">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white border border-white/5 shadow-inner">
              <CheckCircle size={22} />
            </div>
            <div>
              <h1 className="font-sans text-3xl font-semibold text-white tracking-tight">
                {intl.formatMessage(m.heading)}
              </h1>
              <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                {intl.formatMessage(m.summary, { count: pending.length, total: currency(totalPending), aging })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <select
              value={clientFilter}
              onChange={(e) => setClientFilter(e.target.value)}
              className="bg-card border border-white/5 rounded-full py-2.5 px-4 text-sm font-semibold text-zinc-300 focus:outline-none focus:border-brand shadow-inner"
            >
              <option value="all">{intl.formatMessage(m.clientFilterAll)}</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {tab === 'Workflows' && (
              <button
                onClick={() => setEditing(blankWorkflow(intl))}
                className="flex items-center gap-2 px-6 py-2.5 bg-brand text-white text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-[0_0_15px_rgba(20,227,196,0.2)]"
              >
                <Plus size={16} strokeWidth={2.5} />
                {intl.formatMessage(m.newWorkflowAction)}
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="px-10 pb-5 flex items-center gap-2 shrink-0">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-full text-[13px] font-bold transition-all border ${
              tab === t
                ? 'bg-brand text-white border-brand shadow-[0_0_12px_rgba(20,227,196,0.25)]'
                : 'bg-card text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
            }`}
          >
            {intl.formatMessage(TAB_LABEL[t])}
            {t === 'Queue' && pending.length > 0 && <span className="ml-2 opacity-60">{pending.length}</span>}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-10 pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {tab === 'Queue' && (
            <>
              <div className="flex items-center gap-3 mb-5 flex-wrap">
                {/* Screen 12 opens on my own queue, not the practice's. */}
                <div className="flex items-center bg-card border border-white/5 rounded-full p-1 shadow-inner">
                  <ScopePill
                    active={scope === 'mine'}
                    onClick={() => setScope('mine')}
                    label={intl.formatMessage(m.scopeMine)}
                    count={mine.length}
                  />
                  <ScopePill
                    active={scope === 'all'}
                    onClick={() => setScope('all')}
                    label={intl.formatMessage(m.scopeAll)}
                    count={practicePending.length}
                  />
                </div>
                <div className="relative w-72">
                  <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={intl.formatMessage(m.searchPlaceholder)}
                    className="w-full bg-card border border-white/5 rounded-full py-2.5 pl-11 pr-4 text-sm focus:outline-none focus:border-brand placeholder:text-zinc-600 text-white font-medium shadow-inner"
                  />
                </div>
              </div>

              {/* Items that have left the practice. They are nobody here's to
                  approve — the only action is getting the SMS to the client. */}
              {waitingOnClient.length > 0 && <ClientSideBatch items={waitingOnClient} />}

              <DataTable<ApprovalItem>
                className="max-w-none"
                columns={columns}
                rows={pending}
                rowId={(a) => a.id}
                selectable
                onRowClick={(a) => setDetail(a)}
                emptyMessage={intl.formatMessage(scope === 'mine' ? m.emptyMine : m.emptyAll)}
                bulkActions={[
                  { label: intl.formatMessage(m.exportAction), icon: Download, minSelected: 2, disabledHint: intl.formatMessage(EXPORT_HINT), onClick: (sel) => exportApprovals(sel) },
                  { label: intl.formatMessage(m.approveSelectedAction), icon: Send, primary: true, onClick: bulkApprove },
                ]}
                footer={intl.formatMessage(
                  waitingOnClient.length > 0 ? m.queueFooterWithClient : m.queueFooter,
                  { count: pending.length, clientCount: waitingOnClient.length },
                )}
              />
            </>
          )}

          {tab === 'Workflows' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {approvalWorkflows.map((w) => (
                <WorkflowCard
                  key={w.id}
                  workflow={w}
                  usage={approvals.filter((a) => a.workflowId === w.id && a.state === 'pending').length}
                  onEdit={() => setEditing(w)}
                  onToggle={() => saveWorkflow({ ...w, active: !w.active })}
                  onDelete={async () => {
                    const ok = await confirm({
                      tone: 'red',
                      title: intl.formatMessage(m.deleteWorkflowTitle, { name: w.name }),
                      detail: intl.formatMessage(m.deleteWorkflowDetail, {
                        count: w.stages.length,
                        appliesTo: w.appliesTo,
                      }),
                      consequence: intl.formatMessage(m.deleteWorkflowConsequence),
                      confirmLabel: intl.formatMessage(m.deleteWorkflowConfirm),
                    });
                    if (!ok) return;
                    deleteWorkflow(w.id);
                    logAudit({ action: intl.formatMessage(m.deleteWorkflowAudit), scope: w.name, reviewOpened: true });
                  }}
                />
              ))}
              <div className="border border-dashed border-white/10 rounded-[32px] p-6 flex flex-col items-center justify-center text-center gap-3 min-h-[220px]">
                <p className="text-[13px] text-zinc-500 leading-relaxed max-w-xs">
                  {intl.formatMessage(m.workflowsBlurb)}
                </p>
                <button
                  onClick={() => setEditing(blankWorkflow(intl))}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                >
                  <Plus size={15} />
                  {intl.formatMessage(m.newWorkflowAction)}
                </button>
              </div>
            </div>
          )}

          {tab === 'History' && (
            <DataTable<ApprovalItem>
              className="max-w-none"
              columns={[
                { key: 'supplier', label: intl.formatMessage(m.columnSupplier), sortValue: (a) => a.supplier, render: (a) => <span className="text-white font-semibold">{a.supplier}</span> },
                { key: 'clientName', label: intl.formatMessage(m.columnClient), sortValue: (a) => a.clientName },
                {
                  key: 'state', label: intl.formatMessage(m.columnOutcome), sortValue: (a) => a.state,
                  render: (a) =>
                    a.state === 'approved' ? (
                      <Pill tone="green">{intl.formatMessage(m.outcomeApproved)}</Pill>
                    ) : (
                      <Pill tone="red">{intl.formatMessage(m.outcomeRejected)}</Pill>
                    ),
                },
                {
                  // A rejection's reason is the whole point of the row, and it
                  // is usually longer than a table cell. The button opens the
                  // full trail rather than truncating it here.
                  key: 'note', label: intl.formatMessage(m.columnReason),
                  render: (a) => {
                    const note = a.history.find((h) => h.note)?.note;
                    if (a.state === 'rejected') {
                      return (
                        <button
                          onClick={(e) => { e.stopPropagation(); setNoteFor(a); }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold text-red-400 bg-red-400/10 border border-red-400/25 hover:bg-red-400/20 transition-colors"
                        >
                          <MessageSquare size={12} />
                          {intl.formatMessage(m.readNoteAction)}
                        </button>
                      );
                    }
                    return <span className="text-zinc-400 whitespace-normal">{note ?? a.history[0]?.label}</span>;
                  },
                },
                {
                  key: 'locked', label: intl.formatMessage(m.columnLocked), render: (a) => (a.locked ? <Pill tone="blue"><Lock size={10} className="inline mr-1" />{intl.formatMessage(m.lockedPill)}</Pill> : <span className="text-zinc-700">—</span>),
                },
                { key: 'total', label: intl.formatMessage(m.columnTotal), align: 'right', sortValue: (a) => a.total, render: (a) => <span className="text-white font-bold tabular-nums">{currency(a.total)}</span> },
              ]}
              rows={history}
              rowId={(a) => a.id}
              onRowClick={(a) => setDetail(a)}
              emptyMessage={intl.formatMessage(m.historyEmpty)}
            />
          )}
        </motion.div>
      </div>

      <AnimatePresence>
        {noteFor && <RejectionNote item={noteFor} onClose={() => setNoteFor(null)} />}
        {detail && (
          <ApprovalDetail
            item={approvals.find((a) => a.id === detail.id) ?? detail}
            {...(detailWorkflow ? { workflow: detailWorkflow } : {})}
            onApprove={(note) => {
              advanceApproval(detail.id, note);
              logAudit({
                action: intl.formatMessage(m.approveAudit),
                scope: intl.formatMessage(m.approveAuditScope, { supplier: detail.supplier, client: detail.clientName }),
                reviewOpened: true,
              });
            }}
            onReject={(reason) => {
              rejectApproval(detail.id, reason);
              logAudit({
                action: intl.formatMessage(m.rejectAudit),
                scope: intl.formatMessage(m.rejectAuditScope, { supplier: detail.supplier, reason }),
                reviewOpened: true,
              });
            }}
            // Correcting the coding happens where every other correction
            // happens — the document itself, with confidence and provenance
            // on every field. Withheld entirely when there is no document to
            // open, rather than offered and inert.
            {...(detail.documentId ? {
              onEdit: () => {
                setDetail(null);
                startConversation([detail.clientId], [
                  { id: `${Date.now()}-u`, role: 'user', content: intl.formatMessage(m.editRequest, { supplier: detail.supplier }) },
                  {
                    id: `${Date.now()}-a`,
                    role: 'assistant',
                    content: intl.formatMessage(m.editReply),
                    intent: 'REVIEW_DOCUMENT',
                    payload: { documentId: detail.documentId, clientIds: [detail.clientId], clientNames: [detail.clientName] },
                  },
                ]);
              },
            } : {})}
            onClose={() => setDetail(null)}
          />
        )}
        {editing && (
          <WorkflowEditor
            workflow={editing}
            onSave={(w) => { saveWorkflow(w); logAudit({ action: intl.formatMessage(m.saveWorkflowAudit), scope: w.name, reviewOpened: true }); setEditing(null); }}
            onClose={() => setEditing(null)}
          />
        )}
      </AnimatePresence>
      {/* The document behind the row, opened without leaving the queue. */}
      <AnimatePresence>
        {preview && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setPreview(null)}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <motion.div
              initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 24, scale: 0.97 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-3xl"
            >
              <button
                onClick={() => setPreview(null)}
                aria-label={intl.formatMessage(m.closePreviewLabel)}
                className="absolute -top-3 -right-3 z-10 p-2 bg-card hover:bg-raised text-zinc-400 hover:text-white rounded-full border border-white/10 transition-colors shadow-lg"
              >
                <X size={18} />
              </button>
              <DocumentPreview document={documents.find((d) => d.id === preview.id) ?? preview} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ScopePill({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-1.5 rounded-full flex items-center gap-2 text-[13px] font-bold transition-all ${
        active ? 'bg-brand text-white' : 'text-zinc-500 hover:text-white'
      }`}
    >
      {label}
      <span className={active ? 'opacity-70' : 'opacity-50'}>{count}</span>
    </button>
  );
}

const mBatch = defineMessages({
  heading: { id: 'approvals.clientSideBatch.heading', defaultMessage: 'Waiting on the client' },
  subheading: {
    id: 'approvals.clientSideBatch.subheading',
    defaultMessage:
      'Signed off by the business, not the practice — one SMS link per client, however many items.',
  },
  items: {
    id: 'approvals.clientSideBatch.items',
    defaultMessage: '{count, plural, one {# item} other {# items}} · {suppliers}',
  },
  // Four whole sentences rather than one with two optional tails. Whether the
  // link was resent and whether it has been opened are independent, and a
  // translator handed a message with two inserted clauses has to reason about
  // four readings of it at once.
  sent: {
    id: 'approvals.clientSideBatch.sent',
    defaultMessage: 'Sent {sentAt} to {mobile} · expires in {hours}h · not opened yet',
  },
  sentOpened: {
    id: 'approvals.clientSideBatch.sentOpened',
    defaultMessage: 'Sent {sentAt} to {mobile} · expires in {hours}h · opened',
  },
  sentResent: {
    id: 'approvals.clientSideBatch.sentResent',
    defaultMessage: 'Sent {sentAt} to {mobile} · expires in {hours}h · resent {resendCount}× · not opened yet',
  },
  sentResentOpened: {
    id: 'approvals.clientSideBatch.sentResentOpened',
    defaultMessage: 'Sent {sentAt} to {mobile} · expires in {hours}h · resent {resendCount}× · opened',
  },
  notSent: { id: 'approvals.clientSideBatch.notSent', defaultMessage: 'Not sent yet — goes to {mobile}' },
  noMobile: {
    id: 'approvals.clientSideBatch.noMobile',
    defaultMessage: 'No mobile on file — add one before the link can be sent',
  },
  resendAction: { id: 'approvals.clientSideBatch.resendAction', defaultMessage: 'Resend' },
  openLinkAction: { id: 'approvals.clientSideBatch.openLinkAction', defaultMessage: 'Open the link' },
  sendAction: { id: 'approvals.clientSideBatch.sendAction', defaultMessage: 'Send approval request' },
});

/**
 * Wireframe screen 19's practice-side half: items sitting on a client-side
 * stage, batched per client into one SMS link. Nobody in the practice can
 * approve these — the only move is getting the link to the approver, and
 * chasing it if they go quiet.
 */
function ClientSideBatch({ items }: { items: ApprovalItem[] }) {
  const { approvalRequests, sendApprovalRequest, resendApprovalRequest, openApprovalLink, clients } = useAppContext();
  const intl = useIntl();

  const byClient = [...new Set(items.map((i) => i.clientId))].map((clientId) => ({
    clientId,
    client: clients.find((c) => c.id === clientId),
    rows: items.filter((i) => i.clientId === clientId),
    request: approvalRequests.find((r) => r.clientId === clientId),
  }));

  return (
    <div className="border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden mb-6">
      <div className="p-6 pb-4 flex items-center gap-3 border-b border-white/5">
        <div className="w-9 h-9 rounded-xl bg-raised border border-white/5 flex items-center justify-center text-zinc-400 shadow-inner">
          <Smartphone size={16} />
        </div>
        <div className="min-w-0">
          <h3 className="font-sans font-bold text-lg text-white tracking-tight">{intl.formatMessage(mBatch.heading)}</h3>
          <p className="text-[12px] text-zinc-500">
            {intl.formatMessage(mBatch.subheading)}
          </p>
        </div>
      </div>

      <div className="p-6 flex flex-col gap-3">
        {byClient.map(({ clientId, client, rows, request }) => (
          <div key={clientId} className="p-4 rounded-2xl bg-ground/60 border border-white/5 shadow-inner">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="text-[13px] font-bold text-white">{client?.name ?? clientId}</div>
                <div className="text-[12px] text-zinc-500">
                  {intl.formatMessage(mBatch.items, {
                    count: rows.length,
                    suppliers: rows.map((r) => r.supplier).join(', '),
                  })}
                </div>
                <div className="text-[12px] text-zinc-600 mt-1">
                  {request
                    ? intl.formatMessage(
                        request.resendCount > 0
                          ? request.verified
                            ? mBatch.sentResentOpened
                            : mBatch.sentResent
                          : request.verified
                          ? mBatch.sentOpened
                          : mBatch.sent,
                        {
                          sentAt: request.sentAt,
                          mobile: request.recipientMobile,
                          hours: request.expiresInHours,
                          resendCount: request.resendCount,
                        },
                      )
                    : client?.mobile
                    ? intl.formatMessage(mBatch.notSent, { mobile: client.mobile })
                    : intl.formatMessage(mBatch.noMobile)}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {request ? (
                  <>
                    <button
                      onClick={() => resendApprovalRequest(request.id)}
                      className="px-4 py-2 rounded-full text-[12px] font-bold text-zinc-400 border border-white/5 hover:text-white hover:border-white/15 transition-colors"
                    >
                      {intl.formatMessage(mBatch.resendAction)}
                    </button>
                    {/* Demo affordance: step into the approver's shoes. */}
                    <button
                      onClick={() => openApprovalLink(request.id)}
                      className="flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                    >
                      <Smartphone size={13} strokeWidth={2.5} />
                      {intl.formatMessage(mBatch.openLinkAction)}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => sendApprovalRequest(clientId)}
                    disabled={!client?.mobile}
                    className="flex items-center gap-2 px-5 py-2 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <Send size={13} strokeWidth={2.5} />
                    {intl.formatMessage(mBatch.sendAction)}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const mCard = defineMessages({
  noClients: {
    id: 'approvals.workflowCard.noClients',
    defaultMessage: 'No client opted in — this stops nothing',
  },
  statusActive: { id: 'approvals.workflowCard.statusActive', defaultMessage: 'Active' },
  statusPaused: { id: 'approvals.workflowCard.statusPaused', defaultMessage: 'Paused' },
  stagesHeading: { id: 'approvals.workflowCard.stagesHeading', defaultMessage: 'Stages' },
  clientStage: { id: 'approvals.workflowCard.clientStage', defaultMessage: 'Client · SMS' },
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

const mDetail = defineMessages({
  statusApproved: { id: 'approvals.approvalDetail.statusApproved', defaultMessage: 'Approved' },
  statusRejected: { id: 'approvals.approvalDetail.statusRejected', defaultMessage: 'Rejected' },
  workflowLabel: { id: 'approvals.approvalDetail.workflowLabel', defaultMessage: 'Workflow — {name}' },
  workflowNone: { id: 'approvals.approvalDetail.workflowNone', defaultMessage: 'Workflow — none' },
  branchNote: {
    id: 'approvals.approvalDetail.branchNote',
    defaultMessage:
      'Branch conditions fired on this item — {branches} added to the chain before it can clear.',
  },
  historyHeading: { id: 'approvals.approvalDetail.historyHeading', defaultMessage: 'History' },
  rejectionReasonLabel: {
    id: 'approvals.approvalDetail.rejectionReasonLabel',
    defaultMessage: 'Reason for rejection',
  },
  noteLabel: { id: 'approvals.approvalDetail.noteLabel', defaultMessage: 'Note (optional)' },
  rejectionPlaceholder: {
    id: 'approvals.approvalDetail.rejectionPlaceholder',
    defaultMessage: 'Coding looks wrong — recheck the VAT',
  },
  notePlaceholder: {
    id: 'approvals.approvalDetail.notePlaceholder',
    defaultMessage: 'Add context for the audit log',
  },
  lockedNote: {
    id: 'approvals.approvalDetail.lockedNote',
    defaultMessage: "Item details are locked. Approvals override every auto-publish path, including the AI's.",
  },
  correctAction: { id: 'approvals.approvalDetail.correctAction', defaultMessage: 'Correct in chat' },
  correctTitle: {
    id: 'approvals.approvalDetail.correctTitle',
    defaultMessage: 'Opens the AI workspace on this document — the item stays on its stage until you pass it',
  },
  cannotEditNote: {
    id: 'approvals.approvalDetail.cannotEditNote',
    defaultMessage: 'This stage cannot edit — approve or reject only',
  },
  rejectAction: { id: 'approvals.approvalDetail.rejectAction', defaultMessage: 'Reject' },
  confirmRejectAction: {
    id: 'approvals.approvalDetail.confirmRejectAction',
    defaultMessage: 'Confirm rejection',
  },
  passStageAction: { id: 'approvals.approvalDetail.passStageAction', defaultMessage: 'Pass this stage' },
  approveTitle: {
    id: 'approvals.approvalDetail.approveTitle',
    defaultMessage: 'Pass {stage} on {supplier}?',
  },
  approveDetail: {
    id: 'approvals.approvalDetail.approveDetail',
    defaultMessage: '{total} · {category} · {client}. Your name goes on the approval.',
  },
  approveConsequenceFinal: {
    id: 'approvals.approvalDetail.approveConsequenceFinal',
    defaultMessage:
      'This is the last stage — the item locks, its figures can no longer be edited, and it publishes to the accounting software.',
  },
  approveConsequenceNext: {
    id: 'approvals.approvalDetail.approveConsequenceNext',
    defaultMessage: 'It moves on to the next approver and leaves your queue.',
  },
  approveConfirm: { id: 'approvals.approvalDetail.approveConfirm', defaultMessage: 'Yes, approve' },
  rejectTitle: { id: 'approvals.approvalDetail.rejectTitle', defaultMessage: 'Reject {supplier}?' },
  rejectDetail: {
    id: 'approvals.approvalDetail.rejectDetail',
    defaultMessage: 'Recorded reason: “{note}”',
  },
  rejectDetailNoReason: {
    id: 'approvals.approvalDetail.rejectDetailNoReason',
    defaultMessage: 'No reason given — whoever picks this up will not know what was wrong.',
  },
  rejectConsequence: {
    id: 'approvals.approvalDetail.rejectConsequence',
    defaultMessage: 'The item stops here and is not published.',
  },
  rejectConfirm: { id: 'approvals.approvalDetail.rejectConfirm', defaultMessage: 'Yes, reject' },
  noReasonGiven: { id: 'approvals.approvalDetail.noReasonGiven', defaultMessage: 'No reason given' },
});

function ApprovalDetail({ item, workflow, onApprove, onReject, onEdit, onClose }: {
  item: ApprovalItem;
  workflow?: ApprovalWorkflow;
  onApprove: (note?: string) => void;
  onReject: (reason: string) => void;
  /** Opens the document for correction — only offered when the stage allows it. */
  onEdit?: () => void;
  onClose: () => void;
}) {
  const intl = useIntl();
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);
  const stages = workflow ? [...workflow.stages.map((s) => s.name), ...item.addedByBranch] : [];
  const currentStage = workflow?.stages[item.stageIndex];
  const isFinalStage = !!workflow && item.stageIndex >= workflow.stages.length + item.addedByBranch.length - 1;

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-2xl border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
        <div className="p-6 flex items-start justify-between gap-4 border-b border-white/5">
          <div className="min-w-0">
            <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">{item.supplier}</h3>
            <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider truncate">
              {item.clientName} · {item.category} · {currency(item.total)}
            </p>
          </div>
          {item.state === 'approved' ? <Pill tone="green">{intl.formatMessage(mDetail.statusApproved)}</Pill>
            : item.state === 'rejected' ? <Pill tone="red">{intl.formatMessage(mDetail.statusRejected)}</Pill>
            : <Pill tone="amber">{item.stage}</Pill>}
        </div>

        <div className="p-6 flex flex-col gap-6 max-h-[55vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
              {workflow
                ? intl.formatMessage(mDetail.workflowLabel, { name: workflow.name })
                : intl.formatMessage(mDetail.workflowNone)}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {stages.map((s, i) => (
                <span key={i} className="flex items-center gap-2">
                  <span
                    className={`px-3 py-1.5 rounded-full text-[12px] font-bold ${
                      i < item.stageIndex || item.state === 'approved'
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : i === item.stageIndex
                          ? 'bg-brand text-white'
                          : 'bg-raised text-zinc-500'
                    }`}
                  >
                    {s}
                  </span>
                  {i < stages.length - 1 && <span className="text-zinc-700">→</span>}
                </span>
              ))}
            </div>
          </div>

          {item.addedByBranch.length > 0 && (
            <div className="text-[13px] text-brand bg-brand/[0.07] border border-brand/20 rounded-2xl px-4 py-3 flex items-start gap-2.5">
              <GitBranch size={16} className="shrink-0 mt-0.5" />
              <span>
                {intl.formatMessage(mDetail.branchNote, { branches: item.addedByBranch.join(' and ') })}
              </span>
            </div>
          )}

          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
              {intl.formatMessage(mDetail.historyHeading)}
            </div>
            <div className="flex flex-col gap-3">
              {item.history.map((h, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-lg bg-raised border border-white/5 flex items-center justify-center text-zinc-500 shrink-0 mt-0.5">
                    <Clock size={13} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-bold text-white">{h.label}</div>
                    <div className="text-[12px] text-zinc-500">{h.actor}{h.note ? ` — ${h.note}` : ''}</div>
                  </div>
                  <span className="ml-auto text-[11px] text-zinc-600 font-semibold shrink-0">{h.at}</span>
                </div>
              ))}
            </div>
          </div>

          {item.state === 'pending' && (
            <div>
              <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
                {intl.formatMessage(rejecting ? mDetail.rejectionReasonLabel : mDetail.noteLabel)}
              </div>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={intl.formatMessage(rejecting ? mDetail.rejectionPlaceholder : mDetail.notePlaceholder)}
                className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
              />
            </div>
          )}

          {item.locked && (
            <div className="text-[13px] text-zinc-400 bg-ground/60 border border-white/5 rounded-2xl px-4 py-3 flex items-center gap-2.5">
              <Lock size={15} className="shrink-0" />
              {intl.formatMessage(mDetail.lockedNote)}
            </div>
          )}
        </div>

        {item.state === 'pending' && (
          <div className="p-4 bg-raised/50 flex items-center gap-3 justify-end flex-wrap">
            {/* Screen 12's per-stage can-edit toggle: whether this approver may
                correct the coding, or only pass and reject, is the workflow
                author's call — so the button reflects the stage, not the role. */}
            {onEdit &&
              (currentStage?.canEdit ? (
                <button
                  onClick={onEdit}
                  title={intl.formatMessage(mDetail.correctTitle)}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors mr-auto"
                >
                  {/* Says where it goes. This closes the modal and moves to
                      chat, which a pencil would not lead anyone to expect. */}
                  <MessageSquare size={15} />
                  {intl.formatMessage(mDetail.correctAction)}
                </button>
              ) : (
                <span className="mr-auto text-[12px] text-zinc-600 font-semibold">
                  {intl.formatMessage(mDetail.cannotEditNote)}
                </span>
              ))}
            <button
              onClick={() => (rejecting ? setConfirming('reject') : setRejecting(true))}
              className={`px-5 py-2.5 rounded-full text-sm font-bold transition-colors ${
                rejecting ? 'text-white bg-red-500 hover:bg-red-600' : 'text-zinc-400 hover:text-white hover:bg-white/5'
              }`}
            >
              {intl.formatMessage(rejecting ? mDetail.confirmRejectAction : mDetail.rejectAction)}
            </button>
            <button
              onClick={() => setConfirming('approve')}
              className="flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-all shadow-[0_0_15px_rgba(20,227,196,0.3)]"
            >
              <ShieldCheck size={16} />
              {intl.formatMessage(mDetail.passStageAction)}
            </button>
          </div>
        )}
      </div>

      {/* Every stage asks, because passing one is not something the person can
          take back — and the final stage locks the item and publishes it. */}
      {confirming === 'approve' && (
        <ConfirmStep
          title={intl.formatMessage(mDetail.approveTitle, {
            stage: item.stage.replace(/^Stage \d+ — /, ''),
            supplier: item.supplier,
          })}
          detail={intl.formatMessage(mDetail.approveDetail, {
            total: currency(item.total),
            category: item.category,
            client: item.clientName,
          })}
          consequence={intl.formatMessage(
            isFinalStage ? mDetail.approveConsequenceFinal : mDetail.approveConsequenceNext,
          )}
          confirmLabel={intl.formatMessage(mDetail.approveConfirm)}
          onConfirm={() => { setConfirming(null); onApprove(note || undefined); }}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming === 'reject' && (
        <ConfirmStep
          tone="red"
          title={intl.formatMessage(mDetail.rejectTitle, { supplier: item.supplier })}
          detail={
            note
              ? intl.formatMessage(mDetail.rejectDetail, { note })
              : intl.formatMessage(mDetail.rejectDetailNoReason)
          }
          consequence={intl.formatMessage(mDetail.rejectConsequence)}
          confirmLabel={intl.formatMessage(mDetail.rejectConfirm)}
          onConfirm={() => { setConfirming(null); onReject(note || intl.formatMessage(mDetail.noReasonGiven)); }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </Modal>
  );
}

const mNote = defineMessages({
  heading: { id: 'approvals.rejectionNote.heading', defaultMessage: 'Rejected — {supplier}' },
  reasonHeading: { id: 'approvals.rejectionNote.reasonHeading', defaultMessage: 'Reason given' },
  noReason: { id: 'approvals.rejectionNote.noReason', defaultMessage: 'No reason was recorded.' },
  trailHeading: {
    id: 'approvals.rejectionNote.trailHeading',
    defaultMessage: 'Everything that happened',
  },
  closeAction: { id: 'approvals.rejectionNote.closeAction', defaultMessage: 'Close' },
});

/**
 * Why an item was rejected, and by whom. Kept as its own small window rather
 * than the full detail modal: when someone clicks "read the note" that is the
 * one thing they want, and the trail underneath gives it its context.
 */
function RejectionNote({ item, onClose }: { item: ApprovalItem; onClose: () => void }) {
  const intl = useIntl();
  const rejection = item.history.find((h) => /reject/i.test(h.label)) ?? item.history[0];

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5 flex items-start gap-4">
          <div className="w-11 h-11 rounded-2xl bg-red-500/10 border border-red-400/25 flex items-center justify-center text-red-400 shrink-0">
            <MessageSquare size={18} />
          </div>
          <div className="min-w-0">
            <h3 className="font-sans font-bold text-lg text-white tracking-tight">
              {intl.formatMessage(mNote.heading, { supplier: item.supplier })}
            </h3>
            <p className="text-[12px] text-zinc-500 mt-1">
              {currency(item.total)} · {item.category} · {item.clientName}
            </p>
          </div>
        </div>

        <div className="p-6 flex flex-col gap-5">
          <div className="p-4 rounded-2xl bg-ground/60 border border-white/5 shadow-inner">
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
              {intl.formatMessage(mNote.reasonHeading)}
            </div>
            <p className="text-[14px] text-white leading-relaxed">
              {rejection?.note ?? intl.formatMessage(mNote.noReason)}
            </p>
            <p className="text-[12px] text-zinc-500 mt-2.5">
              {rejection?.actor} · {rejection?.at}
            </p>
          </div>

          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
              {intl.formatMessage(mNote.trailHeading)}
            </div>
            <div className="flex flex-col gap-3">
              {item.history.map((h, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-lg bg-raised border border-white/5 flex items-center justify-center text-zinc-500 shrink-0 mt-0.5">
                    <Clock size={13} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-bold text-white">{h.label}</div>
                    <div className="text-[12px] text-zinc-500">{h.actor}{h.note ? ` — ${h.note}` : ''}</div>
                  </div>
                  <span className="ml-auto text-[11px] text-zinc-600 font-semibold shrink-0">{h.at}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="p-4 bg-raised/50 flex justify-end">
          <button
            onClick={onClose}
            className="px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
          >
            {intl.formatMessage(mNote.closeAction)}
          </button>
        </div>
      </div>
    </Modal>
  );
}

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
    defaultMessage: 'Approved by the business, over SMS',
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
  cancelAction: { id: 'approvals.workflowEditor.cancelAction', defaultMessage: 'Cancel' },
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
                className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-[0_0_15px_rgba(20,227,196,0.25)]"
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

        <div className="p-6 flex flex-col gap-5 max-h-[55vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="grid grid-cols-2 gap-4">
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
                <div key={i} className="flex items-center gap-2 p-3 rounded-2xl bg-ground/60 border border-white/5">
                  <input
                    value={s.name}
                    onChange={(e) => set('stages', draft.stages.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    className="flex-1 bg-transparent text-[13px] font-bold text-white focus:outline-none min-w-0"
                  />
                  <input
                    value={s.approver}
                    onChange={(e) => set('stages', draft.stages.map((x, j) => (j === i ? { ...x, approver: e.target.value } : x)))}
                    className="w-32 bg-card border border-white/5 rounded-lg px-2 py-1 text-[12px] text-zinc-300 focus:outline-none focus:border-brand"
                  />
                  <input
                    type="number"
                    placeholder={intl.formatMessage(mEditor.thresholdPlaceholder)}
                    value={s.thresholdAbove ?? ''}
                    onChange={(e) => set('stages', draft.stages.map((x, j) => (j === i ? { ...x, thresholdAbove: e.target.value ? Number(e.target.value) : undefined } : x)))}
                    className="w-24 bg-card border border-white/5 rounded-lg px-2 py-1 text-[12px] text-zinc-300 focus:outline-none focus:border-brand"
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
                    className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 transition-colors shrink-0"
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
                    className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 transition-colors shrink-0"
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
            {intl.formatMessage(mEditor.cancelAction)}
          </button>
          <button onClick={() => onSave(draft)} className="px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-all">
            {intl.formatMessage(mEditor.saveAction)}
          </button>
        </div>
      </div>
    </Modal>
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
    // Only `name` is copy. 'R. Okafor' is fixture data — a sample person from
    // the synthetic practice, not a string to translate.
    stages: [
      {
        name: intl ? intl.formatMessage(mBlank.stageName) : String(mBlank.stageName.defaultMessage),
        approver: 'R. Okafor',
        canEdit: true,
      },
    ],
    branches: [],
    selfApproval: false,
    autoPublishOnApproval: false,
    active: true,
  };
}

function exportApprovals(rows: ApprovalItem[]) {
  const header = 'Client,Supplier,Category,Stage,Approver,Waiting days,Total\n';
  const body = rows.map((a) => `"${a.clientName}","${a.supplier}","${a.category}","${a.stage}","${a.approver}",${a.waitingDays},${a.total}`).join('\n');
  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const el = document.createElement('a');
  el.href = url;
  el.download = 'approvals.csv';
  el.click();
  URL.revokeObjectURL(url);
}

export function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 24, scale: 0.97 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-2xl flex justify-center"
      >
        <button onClick={onClose} className="absolute -top-3 -right-3 z-10 p-2 bg-card hover:bg-raised text-zinc-400 hover:text-white rounded-full border border-white/10 transition-colors shadow-lg">
          <X size={18} />
        </button>
        {children}
      </motion.div>
    </motion.div>
  );
}

export function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
      />
    </div>
  );
}

export function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="bg-ground/60 border border-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 shadow-inner hover:border-white/10 transition-colors text-left"
    >
      <div>
        <div className="text-sm font-bold text-white">{label}</div>
        {hint && <div className="text-[12px] text-zinc-500 mt-0.5">{hint}</div>}
      </div>
      <span className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${value ? 'bg-brand' : 'bg-white/10'}`}>
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  );
}
