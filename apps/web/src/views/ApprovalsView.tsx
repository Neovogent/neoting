import { useMemo, useState } from 'react';
import {
  CheckCircle, X, GitBranch, Plus, Trash2, ShieldCheck, Lock, Clock, Search, Send, Download,
  Smartphone, Sparkles, Check, MessageSquare, Eye, FileWarning,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
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

export function ApprovalsView() {
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

  const history = approvals.filter((a) => a.state !== 'pending');
  const totalPending = pending.reduce((n, a) => n + a.total, 0);
  const aging = pending.filter((a) => a.waitingDays >= 5).length;

  const bulkApprove = (rows: ApprovalItem[]) => {
    const ids = [...new Set(rows.map((r) => r.clientId))];
    const names = clients.filter((c) => ids.includes(c.id)).map((c) => c.name);
    startConversation(ids, [
      { id: `${Date.now()}-u`, role: 'user', content: `Approve ${rows.length} pending items` },
      {
        id: `${Date.now()}-a`,
        role: 'assistant',
        content: 'Read the review to see exactly what will be approved. Approvals override every auto-publish path.',
        intent: 'APPROVE_ITEMS',
        payload: { clientIds: ids, clientNames: names, query: '' },
      },
    ]);
  };

  const columns: Column<ApprovalItem>[] = [
    {
      key: 'supplier', label: 'Supplier', sortValue: (a) => a.supplier,
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
    { key: 'clientName', label: 'Client', sortValue: (a) => a.clientName },
    { key: 'stage', label: 'Stage', sortValue: (a) => a.stage },
    { key: 'approver', label: 'Approver', sortValue: (a) => a.approver },
    {
      key: 'branch', label: 'Branching',
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
      key: 'waitingDays', label: 'Waiting', align: 'right', sortValue: (a) => a.waitingDays,
      render: (a) => (a.waitingDays >= 5 ? <Pill tone="red">{a.waitingDays}d</Pill> : <Pill>{a.waitingDays}d</Pill>),
    },
    {
      key: 'total', label: 'Total', align: 'right', sortValue: (a) => a.total,
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
            title="Open the document — every extracted field with its confidence"
          >
            <Eye size={13} />
            View
          </button>
        ) : (
          <Tooltip
            label="No document attached"
            detail="This approval was raised without a document behind it, so there is nothing to open. Approving it signs for the figures on this row alone."
          >
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold text-amber-400 bg-amber-400/10 whitespace-nowrap cursor-help">
              <FileWarning size={13} />
              No doc
            </span>
          </Tooltip>
        );
      },
    },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#0a0a0c] h-full overflow-hidden">
      <header className="px-10 pt-8 pb-5 shrink-0">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-[#202026] flex items-center justify-center text-white border border-white/5 shadow-inner">
              <CheckCircle size={22} />
            </div>
            <div>
              <h1 className="font-sans text-3xl font-semibold text-white tracking-tight">Approvals</h1>
              <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                {pending.length} pending · {currency(totalPending)} · {aging} aging over 5 days
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <select
              value={clientFilter}
              onChange={(e) => setClientFilter(e.target.value)}
              className="bg-[#16161a] border border-white/5 rounded-full py-2.5 px-4 text-sm font-semibold text-zinc-300 focus:outline-none focus:border-[#14e3c4] shadow-inner"
            >
              <option value="all">All clients</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {tab === 'Workflows' && (
              <button
                onClick={() => setEditing(blankWorkflow())}
                className="flex items-center gap-2 px-6 py-2.5 bg-[#14e3c4] text-white text-sm font-bold rounded-full hover:bg-[#0fcbaf] transition-all shadow-[0_0_15px_rgba(20,227,196,0.2)]"
              >
                <Plus size={16} strokeWidth={2.5} />
                New workflow
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
                ? 'bg-[#14e3c4] text-white border-[#14e3c4] shadow-[0_0_12px_rgba(20,227,196,0.25)]'
                : 'bg-[#16161a] text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
            }`}
          >
            {t}
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
                <div className="flex items-center bg-[#16161a] border border-white/5 rounded-full p-1 shadow-inner">
                  <ScopePill active={scope === 'mine'} onClick={() => setScope('mine')} label="Waiting on me" count={mine.length} />
                  <ScopePill active={scope === 'all'} onClick={() => setScope('all')} label="All pending" count={practicePending.length} />
                </div>
                <div className="relative w-72">
                  <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search supplier or approver..."
                    className="w-full bg-[#16161a] border border-white/5 rounded-full py-2.5 pl-11 pr-4 text-sm focus:outline-none focus:border-[#14e3c4] placeholder:text-zinc-600 text-white font-medium shadow-inner"
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
                emptyMessage={
                  scope === 'mine'
                    ? 'Nothing waiting on you. Switch to All pending to see the rest of the practice.'
                    : 'Nothing awaiting approval.'
                }
                bulkActions={[
                  { label: 'Export CSV', icon: Download, minSelected: 2, disabledHint: EXPORT_HINT, onClick: (sel) => exportApprovals(sel) },
                  { label: 'Approve selected', icon: Send, primary: true, onClick: bulkApprove },
                ]}
                footer={`${pending.length} pending • click a row for the stage detail${
                  waitingOnClient.length > 0 ? ` • ${waitingOnClient.length} with the client` : ''
                }`}
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
                      title: `Delete the "${w.name}" workflow?`,
                      detail: `${w.stages.length} stage${w.stages.length === 1 ? '' : 's'}, applying to ${w.appliesTo}.`,
                      consequence: 'Items on it stop pausing for approval and publish straight through.',
                      confirmLabel: 'Yes, delete it',
                    });
                    if (!ok) return;
                    deleteWorkflow(w.id);
                    logAudit({ action: 'Deleted approval workflow', scope: w.name, reviewOpened: true });
                  }}
                />
              ))}
              <div className="border border-dashed border-white/10 rounded-[32px] p-6 flex flex-col items-center justify-center text-center gap-3 min-h-[220px]">
                <p className="text-[13px] text-zinc-500 leading-relaxed max-w-xs">
                  No cap on how many workflows you can run, and stages can branch on conditions — the two things that
                  push firms onto ApprovalMax.
                </p>
                <button
                  onClick={() => setEditing(blankWorkflow())}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors"
                >
                  <Plus size={15} />
                  New workflow
                </button>
              </div>
            </div>
          )}

          {tab === 'History' && (
            <DataTable<ApprovalItem>
              className="max-w-none"
              columns={[
                { key: 'supplier', label: 'Supplier', sortValue: (a) => a.supplier, render: (a) => <span className="text-white font-semibold">{a.supplier}</span> },
                { key: 'clientName', label: 'Client', sortValue: (a) => a.clientName },
                {
                  key: 'state', label: 'Outcome', sortValue: (a) => a.state,
                  render: (a) => (a.state === 'approved' ? <Pill tone="green">Approved</Pill> : <Pill tone="red">Rejected</Pill>),
                },
                {
                  // A rejection's reason is the whole point of the row, and it
                  // is usually longer than a table cell. The button opens the
                  // full trail rather than truncating it here.
                  key: 'note', label: 'Reason',
                  render: (a) => {
                    const note = a.history.find((h) => h.note)?.note;
                    if (a.state === 'rejected') {
                      return (
                        <button
                          onClick={(e) => { e.stopPropagation(); setNoteFor(a); }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold text-red-400 bg-red-400/10 border border-red-400/25 hover:bg-red-400/20 transition-colors"
                        >
                          <MessageSquare size={12} />
                          Read the note
                        </button>
                      );
                    }
                    return <span className="text-zinc-400 whitespace-normal">{note ?? a.history[0]?.label}</span>;
                  },
                },
                {
                  key: 'locked', label: 'Locked', render: (a) => (a.locked ? <Pill tone="blue"><Lock size={10} className="inline mr-1" />Locked</Pill> : <span className="text-zinc-700">—</span>),
                },
                { key: 'total', label: 'Total', align: 'right', sortValue: (a) => a.total, render: (a) => <span className="text-white font-bold tabular-nums">{currency(a.total)}</span> },
              ]}
              rows={history}
              rowId={(a) => a.id}
              onRowClick={(a) => setDetail(a)}
              emptyMessage="Nothing decided yet in this session."
            />
          )}
        </motion.div>
      </div>

      <AnimatePresence>
        {noteFor && <RejectionNote item={noteFor} onClose={() => setNoteFor(null)} />}
        {detail && (
          <ApprovalDetail
            item={approvals.find((a) => a.id === detail.id) ?? detail}
            workflow={approvalWorkflows.find((w) => w.id === detail.workflowId)}
            onApprove={(note) => { advanceApproval(detail.id, note); logAudit({ action: 'Passed approval stage', scope: `${detail.supplier} — ${detail.clientName}`, reviewOpened: true }); }}
            onReject={(reason) => { rejectApproval(detail.id, reason); logAudit({ action: 'Rejected item', scope: `${detail.supplier} — ${reason}`, reviewOpened: true }); }}
            // Correcting the coding happens where every other correction
            // happens — the document itself, with confidence and provenance
            // on every field.
            onEdit={detail.documentId ? () => {
              setDetail(null);
              startConversation([detail.clientId], [
                { id: `${Date.now()}-u`, role: 'user', content: `Review the ${detail.supplier} document before I approve it` },
                {
                  id: `${Date.now()}-a`,
                  role: 'assistant',
                  content: 'Click any value to correct it — the item stays on its approval stage until you pass it.',
                  intent: 'REVIEW_DOCUMENT',
                  payload: { documentId: detail.documentId, clientIds: [detail.clientId], clientNames: [detail.clientName] },
                },
              ]);
            } : undefined}
            onClose={() => setDetail(null)}
          />
        )}
        {editing && (
          <WorkflowEditor
            workflow={editing}
            onSave={(w) => { saveWorkflow(w); logAudit({ action: 'Saved approval workflow', scope: w.name, reviewOpened: true }); setEditing(null); }}
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
                aria-label="Close the document"
                className="absolute -top-3 -right-3 z-10 p-2 bg-[#16161a] hover:bg-[#202026] text-zinc-400 hover:text-white rounded-full border border-white/10 transition-colors shadow-lg"
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
        active ? 'bg-[#14e3c4] text-white' : 'text-zinc-500 hover:text-white'
      }`}
    >
      {label}
      <span className={active ? 'opacity-70' : 'opacity-50'}>{count}</span>
    </button>
  );
}

/**
 * Wireframe screen 19's practice-side half: items sitting on a client-side
 * stage, batched per client into one SMS link. Nobody in the practice can
 * approve these — the only move is getting the link to the approver, and
 * chasing it if they go quiet.
 */
function ClientSideBatch({ items }: { items: ApprovalItem[] }) {
  const { approvalRequests, sendApprovalRequest, resendApprovalRequest, openApprovalLink, clients } = useAppContext();

  const byClient = [...new Set(items.map((i) => i.clientId))].map((clientId) => ({
    clientId,
    client: clients.find((c) => c.id === clientId),
    rows: items.filter((i) => i.clientId === clientId),
    request: approvalRequests.find((r) => r.clientId === clientId),
  }));

  return (
    <div className="border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden mb-6">
      <div className="p-6 pb-4 flex items-center gap-3 border-b border-white/5">
        <div className="w-9 h-9 rounded-xl bg-[#202026] border border-white/5 flex items-center justify-center text-zinc-400 shadow-inner">
          <Smartphone size={16} />
        </div>
        <div className="min-w-0">
          <h3 className="font-sans font-bold text-lg text-white tracking-tight">Waiting on the client</h3>
          <p className="text-[12px] text-zinc-500">
            Signed off by the business, not the practice — one SMS link per client, however many items.
          </p>
        </div>
      </div>

      <div className="p-6 flex flex-col gap-3">
        {byClient.map(({ clientId, client, rows, request }) => (
          <div key={clientId} className="p-4 rounded-2xl bg-[#0a0a0c]/60 border border-white/5 shadow-inner">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="text-[13px] font-bold text-white">{client?.name ?? clientId}</div>
                <div className="text-[12px] text-zinc-500">
                  {rows.length} item{rows.length === 1 ? '' : 's'} · {rows.map((r) => r.supplier).join(', ')}
                </div>
                <div className="text-[12px] text-zinc-600 mt-1">
                  {request
                    ? `Sent ${request.sentAt} to ${request.recipientMobile} · expires in ${request.expiresInHours}h${
                        request.resendCount > 0 ? ` · resent ${request.resendCount}×` : ''
                      }${request.verified ? ' · opened' : ' · not opened yet'}`
                    : client?.mobile
                    ? `Not sent yet — goes to ${client.mobile}`
                    : 'No mobile on file — add one before the link can be sent'}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {request ? (
                  <>
                    <button
                      onClick={() => resendApprovalRequest(request.id)}
                      className="px-4 py-2 rounded-full text-[12px] font-bold text-zinc-400 border border-white/5 hover:text-white hover:border-white/15 transition-colors"
                    >
                      Resend
                    </button>
                    {/* Demo affordance: step into the approver's shoes. */}
                    <button
                      onClick={() => openApprovalLink(request.id)}
                      className="flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors"
                    >
                      <Smartphone size={13} strokeWidth={2.5} />
                      Open the link
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => sendApprovalRequest(clientId)}
                    disabled={!client?.mobile}
                    className="flex items-center gap-2 px-5 py-2 rounded-full text-[12px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <Send size={13} strokeWidth={2.5} />
                    Send approval request
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

export function WorkflowCard({ workflow, usage, onEdit, onToggle, onDelete }: {
  workflow: ApprovalWorkflow; usage: number; onEdit: () => void; onToggle: () => void; onDelete: () => void;
}) {
  const { clients } = useAppContext();
  return (
    <div className="border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
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
              <span className="text-amber-400">No client opted in — this stops nothing</span>
            )}
          </p>
        </div>
        {workflow.active ? <Pill tone="green">Active</Pill> : <Pill>Paused</Pill>}
      </div>

      <div className="p-6 flex flex-col gap-4">
        <div>
          <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">Stages</div>
          <div className="flex flex-col gap-2">
            {workflow.stages.map((s, i) => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-2xl bg-[#0a0a0c]/60 border border-white/5">
                <span className="w-6 h-6 rounded-lg bg-[#202026] text-[11px] font-bold text-zinc-400 flex items-center justify-center shrink-0">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-bold text-white truncate flex items-center gap-2">
                    {s.name}
                    {/* Which side of the relationship this stage sits on is the
                        most consequential thing about it — it decides whether
                        the item leaves the practice by SMS. */}
                    {s.clientSide && <Pill tone="amber">Client · SMS</Pill>}
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    {s.approver}
                    {s.thresholdAbove ? ` · only when over ${currency(s.thresholdAbove)}` : ' · always'}
                    {s.canEdit ? ' · can edit' : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {workflow.branches.length > 0 && (
          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3 flex items-center gap-1.5">
              <GitBranch size={11} /> Conditional branching
            </div>
            <div className="flex flex-col gap-2">
              {workflow.branches.map((b, i) => (
                <div key={i} className="text-[12px] text-[#14e3c4] bg-[#14e3c4]/[0.07] border border-[#14e3c4]/20 rounded-xl px-3 py-2">
                  {b.label}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {workflow.autoPublishOnApproval && <Pill tone="blue">Auto-publish once approved</Pill>}
          {workflow.selfApproval ? <Pill>Self-approval allowed</Pill> : <Pill>No self-approval</Pill>}
          <Pill>Specificity {workflow.specificity}</Pill>
        </div>
      </div>

      <div className="p-4 bg-[#202026]/50 flex items-center gap-3 flex-wrap">
        <button onClick={onEdit} className="px-5 py-2.5 rounded-2xl text-sm font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors">
          Edit
        </button>
        <button onClick={onToggle} className="px-4 py-2.5 rounded-2xl text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5 transition-colors">
          {workflow.active ? 'Pause' : 'Activate'}
        </button>
        <button onClick={onDelete} className="p-2.5 rounded-2xl text-zinc-500 hover:text-red-400 hover:bg-white/5 transition-colors">
          <Trash2 size={16} />
        </button>
        <span className="ml-auto text-[12px] text-zinc-600 font-semibold">{usage} in queue</span>
      </div>
    </div>
  );
}

function ApprovalDetail({ item, workflow, onApprove, onReject, onEdit, onClose }: {
  item: ApprovalItem;
  workflow?: ApprovalWorkflow;
  onApprove: (note?: string) => void;
  onReject: (reason: string) => void;
  /** Opens the document for correction — only offered when the stage allows it. */
  onEdit?: () => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);
  const stages = workflow ? [...workflow.stages.map((s) => s.name), ...item.addedByBranch] : [];
  const currentStage = workflow?.stages[item.stageIndex];
  const isFinalStage = !!workflow && item.stageIndex >= workflow.stages.length + item.addedByBranch.length - 1;

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-2xl border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
        <div className="p-6 flex items-start justify-between gap-4 border-b border-white/5">
          <div className="min-w-0">
            <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">{item.supplier}</h3>
            <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider truncate">
              {item.clientName} · {item.category} · {currency(item.total)}
            </p>
          </div>
          {item.state === 'approved' ? <Pill tone="green">Approved</Pill>
            : item.state === 'rejected' ? <Pill tone="red">Rejected</Pill>
            : <Pill tone="amber">{item.stage}</Pill>}
        </div>

        <div className="p-6 flex flex-col gap-6 max-h-[55vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
              Workflow — {workflow?.name ?? 'none'}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {stages.map((s, i) => (
                <span key={i} className="flex items-center gap-2">
                  <span
                    className={`px-3 py-1.5 rounded-full text-[12px] font-bold ${
                      i < item.stageIndex || item.state === 'approved'
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : i === item.stageIndex
                          ? 'bg-[#14e3c4] text-white'
                          : 'bg-[#202026] text-zinc-500'
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
            <div className="text-[13px] text-[#14e3c4] bg-[#14e3c4]/[0.07] border border-[#14e3c4]/20 rounded-2xl px-4 py-3 flex items-start gap-2.5">
              <GitBranch size={16} className="shrink-0 mt-0.5" />
              <span>
                Branch conditions fired on this item — {item.addedByBranch.join(' and ')} added to the chain before it
                can clear.
              </span>
            </div>
          )}

          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">History</div>
            <div className="flex flex-col gap-3">
              {item.history.map((h, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-lg bg-[#202026] border border-white/5 flex items-center justify-center text-zinc-500 shrink-0 mt-0.5">
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
                {rejecting ? 'Reason for rejection' : 'Note (optional)'}
              </div>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={rejecting ? 'Coding looks wrong — recheck the VAT' : 'Add context for the audit log'}
                className="w-full bg-[#0a0a0c] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#14e3c4] transition-colors"
              />
            </div>
          )}

          {item.locked && (
            <div className="text-[13px] text-zinc-400 bg-[#0a0a0c]/60 border border-white/5 rounded-2xl px-4 py-3 flex items-center gap-2.5">
              <Lock size={15} className="shrink-0" />
              Item details are locked. Approvals override every auto-publish path, including the AI's.
            </div>
          )}
        </div>

        {item.state === 'pending' && (
          <div className="p-4 bg-[#202026]/50 flex items-center gap-3 justify-end flex-wrap">
            {/* Screen 12's per-stage can-edit toggle: whether this approver may
                correct the coding, or only pass and reject, is the workflow
                author's call — so the button reflects the stage, not the role. */}
            {onEdit &&
              (currentStage?.canEdit ? (
                <button
                  onClick={onEdit}
                  title="Opens the AI workspace on this document — the item stays on its stage until you pass it"
                  className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors mr-auto"
                >
                  {/* Says where it goes. This closes the modal and moves to
                      chat, which a pencil would not lead anyone to expect. */}
                  <MessageSquare size={15} />
                  Correct in chat
                </button>
              ) : (
                <span className="mr-auto text-[12px] text-zinc-600 font-semibold">
                  This stage cannot edit — approve or reject only
                </span>
              ))}
            <button
              onClick={() => (rejecting ? setConfirming('reject') : setRejecting(true))}
              className={`px-5 py-2.5 rounded-full text-sm font-bold transition-colors ${
                rejecting ? 'text-white bg-red-500 hover:bg-red-600' : 'text-zinc-400 hover:text-white hover:bg-white/5'
              }`}
            >
              {rejecting ? 'Confirm rejection' : 'Reject'}
            </button>
            <button
              onClick={() => setConfirming('approve')}
              className="flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-all shadow-[0_0_15px_rgba(20,227,196,0.3)]"
            >
              <ShieldCheck size={16} />
              Pass this stage
            </button>
          </div>
        )}
      </div>

      {/* Every stage asks, because passing one is not something the person can
          take back — and the final stage locks the item and publishes it. */}
      {confirming === 'approve' && (
        <ConfirmStep
          title={`Pass ${item.stage.replace(/^Stage \d+ — /, '')} on ${item.supplier}?`}
          detail={`${currency(item.total)} · ${item.category} · ${item.clientName}. Your name goes on the approval.`}
          consequence={
            isFinalStage
              ? 'This is the last stage — the item locks, its figures can no longer be edited, and it publishes to the accounting software.'
              : `It moves on to the next approver and leaves your queue.`
          }
          confirmLabel="Yes, approve"
          onConfirm={() => { setConfirming(null); onApprove(note || undefined); }}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming === 'reject' && (
        <ConfirmStep
          tone="red"
          title={`Reject ${item.supplier}?`}
          detail={note ? `Recorded reason: “${note}”` : 'No reason given — whoever picks this up will not know what was wrong.'}
          consequence="The item stops here and is not published."
          confirmLabel="Yes, reject"
          onConfirm={() => { setConfirming(null); onReject(note || 'No reason given'); }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </Modal>
  );
}

/**
 * Why an item was rejected, and by whom. Kept as its own small window rather
 * than the full detail modal: when someone clicks "read the note" that is the
 * one thing they want, and the trail underneath gives it its context.
 */
function RejectionNote({ item, onClose }: { item: ApprovalItem; onClose: () => void }) {
  const rejection = item.history.find((h) => /reject/i.test(h.label)) ?? item.history[0];

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5 flex items-start gap-4">
          <div className="w-11 h-11 rounded-2xl bg-red-500/10 border border-red-400/25 flex items-center justify-center text-red-400 shrink-0">
            <MessageSquare size={18} />
          </div>
          <div className="min-w-0">
            <h3 className="font-sans font-bold text-lg text-white tracking-tight">Rejected — {item.supplier}</h3>
            <p className="text-[12px] text-zinc-500 mt-1">
              {currency(item.total)} · {item.category} · {item.clientName}
            </p>
          </div>
        </div>

        <div className="p-6 flex flex-col gap-5">
          <div className="p-4 rounded-2xl bg-[#0a0a0c]/60 border border-white/5 shadow-inner">
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Reason given</div>
            <p className="text-[14px] text-white leading-relaxed">
              {rejection?.note ?? 'No reason was recorded.'}
            </p>
            <p className="text-[12px] text-zinc-500 mt-2.5">
              {rejection?.actor} · {rejection?.at}
            </p>
          </div>

          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">Everything that happened</div>
            <div className="flex flex-col gap-3">
              {item.history.map((h, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-lg bg-[#202026] border border-white/5 flex items-center justify-center text-zinc-500 shrink-0 mt-0.5">
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

        <div className="p-4 bg-[#202026]/50 flex justify-end">
          <button
            onClick={onClose}
            className="px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function WorkflowEditor({ workflow, onSave, onClose }: { workflow: ApprovalWorkflow; onSave: (w: ApprovalWorkflow) => void; onClose: () => void }) {
  const { clients } = useAppContext();
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
      <div className="w-full max-w-2xl border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5 flex items-start justify-between gap-4">
          <div>
            <h3 className="font-sans font-bold text-xl text-white tracking-tight">
              {workflow.name ? 'Edit workflow' : 'New workflow'}
            </h3>
            <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
              No stage cap · branches allowed · practice-side approvers
            </p>
          </div>
          {!describing && (
            <button
              onClick={() => setDescribing(true)}
              className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-[#14e3c4] bg-[#14e3c4]/10 border border-[#14e3c4]/20 hover:bg-[#14e3c4]/20 transition-colors"
            >
              <Sparkles size={13} />
              Describe it instead
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
                <Sparkles size={12} className="text-[#14e3c4]" />
                Describe the policy
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim()) build();
                }}
                rows={3}
                placeholder="Anything over £500 needs a manager, and over £2,000 the Finance Director too. Auto-publish once approved."
                className="w-full bg-[#0a0a0c] border border-white/5 rounded-2xl px-4 py-3 text-[13.5px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#14e3c4] transition-colors resize-none"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              {WORKFLOW_EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => setPrompt(ex)}
                  className="px-3 py-1.5 rounded-full text-[11px] font-semibold text-zinc-400 bg-[#0a0a0c] border border-white/5 hover:text-white hover:border-white/20 transition-colors text-left max-w-full truncate"
                >
                  {ex}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={build}
                disabled={!prompt.trim()}
                className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-[0_0_15px_rgba(20,227,196,0.25)]"
              >
                <Sparkles size={15} />
                Build the workflow
              </button>
              {!isNew || draft.stages.length > 0 ? (
                <button
                  onClick={() => setDescribing(false)}
                  className="px-4 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
                >
                  Set it up by hand
                </button>
              ) : null}
              <span className="text-[11px] text-zinc-600 font-semibold ml-auto">⌘↵</span>
            </div>
          </div>
        )}

        {/* What the description was taken to mean, and what it did not say. */}
        {read && !describing && (
          <div className="px-6 pt-5">
            <div className="p-4 rounded-2xl bg-[#14e3c4]/[0.06] border border-[#14e3c4]/20 flex flex-col gap-2">
              <div className="text-[11px] font-bold text-[#14e3c4] uppercase tracking-widest">Filled in from your description</div>
              {read.understood.map((u) => (
                <div key={u} className="text-[12.5px] text-zinc-300 flex items-start gap-2">
                  <Check size={13} className="text-[#14e3c4] mt-0.5 shrink-0" strokeWidth={3} />
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
                Every field below is editable — change anything that is not what you meant.
              </p>
            </div>
          </div>
        )}

        <div className="p-6 flex flex-col gap-5 max-h-[55vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" value={draft.name} onChange={(v) => set('name', v)} />
            <Field label="Applies to" value={draft.appliesTo} onChange={(v) => set('appliesTo', v)} />
          </div>

          {/* Opt-in, one client at a time. A workflow with nobody ticked is
              inert by design, and says so rather than looking armed. */}
          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
              Clients this applies to
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
                        ? 'text-[#14e3c4] bg-[#14e3c4]/10 border-[#14e3c4]/30'
                        : 'text-zinc-400 bg-[#0a0a0c]/60 border-white/5 hover:text-white'
                    }`}
                  >
                    {on ? '✓ ' : ''}{c.name}
                  </button>
                );
              })}
            </div>
            {draft.clientIds.length === 0 && (
              <p className="text-[11.5px] text-amber-400 font-semibold mt-2">
                No client selected — nothing will pause for approval until one is.
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">Stages</span>
              <button
                onClick={() => set('stages', [...draft.stages, { name: 'New stage', approver: 'Manager', canEdit: false }])}
                className="text-[12px] font-bold text-[#14e3c4] hover:underline"
              >
                + Add stage
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {draft.stages.map((s, i) => (
                <div key={i} className="flex items-center gap-2 p-3 rounded-2xl bg-[#0a0a0c]/60 border border-white/5">
                  <input
                    value={s.name}
                    onChange={(e) => set('stages', draft.stages.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    className="flex-1 bg-transparent text-[13px] font-bold text-white focus:outline-none min-w-0"
                  />
                  <input
                    value={s.approver}
                    onChange={(e) => set('stages', draft.stages.map((x, j) => (j === i ? { ...x, approver: e.target.value } : x)))}
                    className="w-32 bg-[#16161a] border border-white/5 rounded-lg px-2 py-1 text-[12px] text-zinc-300 focus:outline-none focus:border-[#14e3c4]"
                  />
                  <input
                    type="number"
                    placeholder="threshold"
                    value={s.thresholdAbove ?? ''}
                    onChange={(e) => set('stages', draft.stages.map((x, j) => (j === i ? { ...x, thresholdAbove: e.target.value ? Number(e.target.value) : undefined } : x)))}
                    className="w-24 bg-[#16161a] border border-white/5 rounded-lg px-2 py-1 text-[12px] text-zinc-300 focus:outline-none focus:border-[#14e3c4]"
                  />
                  {/* Whether this stage leaves the practice. A client-side
                      stage is delivered by SMS + OTP, so it can never edit. */}
                  <button
                    onClick={() =>
                      set('stages', draft.stages.map((x, j) =>
                        j === i ? { ...x, clientSide: !x.clientSide, canEdit: x.clientSide ? x.canEdit : false } : x,
                      ))
                    }
                    title={s.clientSide ? 'Approved by the business, over SMS' : 'Approved inside the practice'}
                    className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-bold border transition-colors ${
                      s.clientSide
                        ? 'text-[#14e3c4] bg-[#14e3c4]/10 border-[#14e3c4]/25'
                        : 'text-zinc-500 border-white/5 hover:text-white hover:border-white/15'
                    }`}
                  >
                    {s.clientSide ? 'Client' : 'Practice'}
                  </button>
                  <button
                    onClick={() => set('stages', draft.stages.map((x, j) => (j === i ? { ...x, canEdit: !x.canEdit } : x)))}
                    disabled={s.clientSide}
                    title={s.clientSide ? 'A client-side approver never edits the coding' : 'Can this approver correct the coding?'}
                    className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-bold border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                      s.canEdit
                        ? 'text-[#14e3c4] bg-[#14e3c4]/10 border-[#14e3c4]/25'
                        : 'text-zinc-500 border-white/5 hover:text-white hover:border-white/15'
                    }`}
                  >
                    Can edit
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
              <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">Conditional branches</span>
              <button
                onClick={() => set('branches', [...draft.branches, { field: 'amount', operator: '>', value: '2000', addApprover: 'Finance Director', label: 'Amount over £2,000 adds the Finance Director' }])}
                className="text-[12px] font-bold text-[#14e3c4] hover:underline"
              >
                + Add branch
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {draft.branches.map((b, i) => (
                <div key={i} className="flex items-center gap-2 p-3 rounded-2xl bg-[#0a0a0c]/60 border border-white/5">
                  <input
                    value={b.label}
                    onChange={(e) => set('branches', draft.branches.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                    className="flex-1 bg-transparent text-[12px] text-[#14e3c4] focus:outline-none min-w-0"
                  />
                  <button
                    onClick={() => set('branches', draft.branches.filter((_, j) => j !== i))}
                    className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 transition-colors shrink-0"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {draft.branches.length === 0 && <p className="text-[12px] text-zinc-600">No branches — the chain is linear.</p>}
            </div>
          </div>

          <Toggle label="Allow self-approval" value={draft.selfApproval} onChange={(v) => set('selfApproval', v)} />
          <Toggle
            label="Auto-publish once approved"
            hint="Approval always wins over an auto-publish rule, never the other way round."
            value={draft.autoPublishOnApproval}
            onChange={(v) => set('autoPublishOnApproval', v)}
          />
        </div>

        <div className="p-4 bg-[#202026]/50 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-full text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 transition-colors">
            Cancel
          </button>
          <button onClick={() => onSave(draft)} className="px-6 py-2.5 rounded-full text-sm font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-all">
            Save workflow
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function blankWorkflow(): ApprovalWorkflow {
  return {
    id: `wf-${Date.now()}`,
    name: '',
    appliesTo: 'All cost items',
    // A new workflow governs nobody until a client is named — opt-in means
    // opt-in, so it cannot start by capturing the whole practice.
    clientIds: [],
    specificity: 1,
    stages: [{ name: 'Manager review', approver: 'R. Okafor', canEdit: true }],
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
        <button onClick={onClose} className="absolute -top-3 -right-3 z-10 p-2 bg-[#16161a] hover:bg-[#202026] text-zinc-400 hover:text-white rounded-full border border-white/10 transition-colors shadow-lg">
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
        className="w-full bg-[#0a0a0c] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#14e3c4] transition-colors"
      />
    </div>
  );
}

export function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="bg-[#0a0a0c]/60 border border-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 shadow-inner hover:border-white/10 transition-colors text-left"
    >
      <div>
        <div className="text-sm font-bold text-white">{label}</div>
        {hint && <div className="text-[12px] text-zinc-500 mt-0.5">{hint}</div>}
      </div>
      <span className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${value ? 'bg-[#14e3c4]' : 'bg-white/10'}`}>
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  );
}
