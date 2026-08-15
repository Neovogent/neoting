import { useMemo, useState } from 'react';
import {
  ArrowLeft, Sparkles, Send, Activity, Landmark, Link2, Star,
  RefreshCw, CheckCircle, Eye, Users, Settings as SettingsIcon, Download, Smartphone,
  Radio, History, ListChecks, Bot, Circle, Plus, PencilLine, X as XIcon, ShieldCheck, Clock, Check,
  LucideIcon,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppContext } from '../context/AppContext';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { DocumentPreview } from '../components/DynamicComponents/DocumentPreview';
import { Modal, WorkflowCard, WorkflowEditor, blankWorkflow } from './ApprovalsView';
import { RolePicker } from '../components/DynamicComponents/RolePicker';
import { ClientInbox } from './ClientInbox';
import { ChaseComposer } from '../components/DynamicComponents/ChaseComposer';
import { BankView } from './BankView';
import { ClientSupplierStatements } from './ClientSupplierStatements';
import { ClientExpenseClaims } from './ClientExpenseClaims';
import { currency } from '../lib/resolver';
import { healthTone } from '../lib/selectors';
import { fromSlug, slug, useQueryParam, useSegment } from '../lib/router';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { channelLabel } from '../lib/channels';
import type { ApprovalWorkflow, BusinessMemberRole, Client, ClientDetailChange, Colleague, Document, Intent, MissingItem, SetupTask, WorkflowTask } from '../lib/types';

/**
 * Wireframe screen 7 — the client is the single home of everything
 * client-scoped, so this tab set is the whole surface. Order matches the
 * wireframe exactly: the daily pipeline work first, configuration last.
 */
const TABS = [
  'Overview', 'Costs', 'Sales', 'Bank', 'Supplier Statements', 'Expense Claims',
  'Approvals', 'Documents', 'Chases', 'Tasks', 'Integrations', 'Users', 'Settings', 'AI',
] as const;
type Tab = (typeof TABS)[number];

/**
 * What the Status column actually says. Four of the five states are a fixed
 * word, but `review` has always shown its note instead — so "Missing VAT" is
 * not a status, it is a review note. Rejected, Processing and a failed-publish
 * Ready now show theirs too, trimmed to fit a cell with the full text on hover.
 */
function statusLabel(d: Document): string {
  const note = d.statusNote?.split('—')[0]?.trim();
  if (d.status === 'review') return d.statusNote ?? 'To review';
  if (d.status === 'ready') return d.publishFailed ? 'Ready — publish failed' : 'Ready';
  if (d.status === 'rejected') return note ? `Rejected — ${note.toLowerCase()}` : 'Rejected';
  if (d.status === 'processing') return note || 'Processing';
  return 'Published';
}

/**
 * `title?: string` means absent or a string — never present-and-undefined — so
 * a document with no note has to hand the Pill no prop at all.
 */
function noteTitle(note: string | undefined): { title?: string } {
  return note === undefined ? {} : { title: note };
}

/** How each intake channel is named on the Overview's channel mix. */
const CHANNEL_LABEL: Record<Document['source'], string> = {
  email: 'Email',
  whatsapp: 'WhatsApp',
  'sms-link': 'SMS chase links',
  web: 'Web upload',
  portal: 'Client portal',
  chat: 'Chat upload',
  csv: 'CSV import',
};

export function ClientDetailView() {
  const {
    clients, openClientId, openClient, statsFor, documents, missing,
    approvals, chases, startConversation, retryDocument,
    starredClientIds, toggleStarClient,
    onboardingLinks, sendOnboardingLink, resendOnboardingLink,
    accounts, reauthAccount,
    tasks, setTaskStatus, auditLog, settings, conversations, selectConversation, setActiveTab,
    approvalWorkflows, saveWorkflow, deleteWorkflow,
    businessAccounts, inviteBusinessUser, openRegistrationLink, colleagues, addTask,
    advanceApproval, rejectApproval,
    clientSideApprovals, approvalRequests, sendApprovalRequest, resendApprovalRequest, openApprovalLink,
    chasePolicy, clientDetailChanges, proposeClientDetailChanges,
  } = useAppContext();

  // /clients/:id/:tab — the tab is in the address, so every one is linkable
  // and Back steps between them.
  const [tabSlug, setTabSlug] = useSegment(2);
  const tab: Tab = fromSlug(tabSlug, TABS) ?? 'Overview';
  const setTab = (next: Tab) => setTabSlug(next === 'Overview' ? null : slug(next));

  // ?doc=<id> — a preview is a layer over wherever you already were, so it
  // gets a link without the path having to know about it.
  const [previewId, setPreviewId] = useQueryParam('doc');
  const preview = previewId ? documents.find((d) => d.id === previewId) ?? null : null;
  const setPreview = (doc: Document | null) => setPreviewId(doc ? doc.id : null);
  const [editingWorkflow, setEditingWorkflow] = useState<ApprovalWorkflow | null>(null);
  const [inviting, setInviting] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [chasing, setChasing] = useState<string[] | null>(null);
  const confirm = useConfirm();
  const client = clients.find((c) => c.id === openClientId);
  if (!client) return null;

  const s = statsFor(client.id);
  const docs = documents.filter((d) => d.clientId === client.id);
  const miss = missing.filter((m) => m.clientId === client.id);
  const clientApprovals = approvals.filter((a) => a.clientName === client.name);
  /** Live workflows this client's items are actually running through. */
  const clientWorkflows = approvalWorkflows.filter(
    (w) => w.active && clientApprovals.some((a) => a.workflowId === w.id),
  );
  const chase = chases.find((c) => c.clientId === client.id);
  const setupLink = onboardingLinks.find((l) => l.clientId === client.id);
  // What the client still owes. `profile` only appears on invite-path records,
  // where the client registers the company rather than the practice keying it
  // in; the other two the practice cannot do at all.
  const pendingTasks: SetupTask[] = [
    ...(client.awaitingRegistration ? (['profile'] as SetupTask[]) : []),
    ...(client.xeroConnected ? [] : (['ledger'] as SetupTask[])),
    ...(client.bankConnected ? [] : (['bank'] as SetupTask[])),
  ];

  const clientAccounts = accounts.filter((a) => a.clientId === client.id);
  const clientTasks = tasks.filter((t) => t.clientId === client.id);
  const pendingChanges = clientDetailChanges.filter((c) => c.clientId === client.id && c.status === 'pending');
  const clientSideItems = clientSideApprovals(client.id);
  const approvalRequest = approvalRequests.find((r) => r.clientId === client.id);
  /**
   * Hours still to wait before the link can be sent again. Resending while the
   * first one is live is a second text saying the same thing, which is how a
   * chase turns into nagging — so the wait is a policy, not a habit.
   */
  const resendIn = approvalRequest
    ? Math.max(0, Math.ceil(chasePolicy.resendAfterHours - (Date.now() - approvalRequest.sentAtMs) / 3_600_000))
    : 0;
  const businessAccount = businessAccounts.find((a) => a.clientId === client.id);
  const businessMembers = businessAccount?.members ?? [];
  const clientConversations = conversations.filter(
    (c) => c.attachedClientIds.includes(client.id) && c.messages.length > 0,
  );

  /**
   * Wireframe screen 7, "Channel mix (how docs arrive)" — a real share of this
   * client's own documents, not the practice-wide figure the Analytics view
   * shows. Sorted heaviest first so the dominant channel reads immediately.
   */
  const channelMix = useMemo(() => {
    const counts = new Map<Document['source'], number>();
    docs.forEach((d) => counts.set(d.source, (counts.get(d.source) ?? 0) + 1));
    const total = docs.length;
    return [...counts.entries()]
      .map(([source, count]) => ({
        source,
        count,
        pct: total === 0 ? 0 : Math.round((count / total) * 100),
      }))
      .sort((a, b) => b.count - a.count);
  }, [docs]);

  /**
   * Wireframe's "Recent activity" feed. Built from things that actually
   * happened rather than a seeded list: entries this user approved through a
   * Review gate, plus the chase timeline. Newest first.
   */
  const activity = useMemo(() => {
    const fromAudit = auditLog
      .filter((e) => e.scope.toLowerCase().includes(client.name.toLowerCase()))
      .map((e) => ({ id: e.id, at: e.at, label: e.action, detail: e.scope, actor: e.actor }));
    const fromChase = (chase?.events ?? []).map((e, i) => ({
      id: `chase-ev-${i}`,
      at: e.at,
      label: e.label,
      detail: e.detail,
      actor: 'Chase engine',
    }));
    return [...fromAudit, ...fromChase].slice(0, 8);
  }, [auditLog, chase, client.name]);

  const scoped = (intent: Intent, content: string, response: string) =>
    startConversation([client.id], [
      { id: `${Date.now()}-u`, role: 'user', content },
      { id: `${Date.now()}-a`, role: 'assistant', content: response, intent, payload: { clientIds: [client.id], clientNames: [client.name] } },
    ]);

  /**
   * Chases a specific set of items, in a composer on this page.
   *
   * Deliberately not the chat: asking the agent to chase and doing it yourself
   * are two ways of working, and someone who has already picked the rows has
   * made the decision the chat would be there to help with. Being thrown into
   * a conversation at that point loses their place on the page.
   */
  const chaseItems = (items: MissingItem[]) => {
    const outstanding = items.filter((m) => !m.chased);
    const target = outstanding.length ? outstanding : items;
    setChasing(target.map((m) => m.id));
  };

  /** The header button and the Missing tile — everything outstanding. */
  const chaseClient = () => setChasing(miss.filter((m) => !m.chased).map((m) => m.id));

  const docColumns: Column<Document>[] = [
    { key: 'supplier', label: 'Supplier', sortValue: (d) => d.supplier, render: (d) => <span className="text-white font-semibold">{d.supplier}</span> },
    { key: 'date', label: 'Date', sortValue: (d) => d.date },
    { key: 'category', label: 'Category', sortValue: (d) => d.category },
    { key: 'source', label: 'Channel', sortValue: (d) => d.source, render: (d) => <Pill>{d.source}</Pill> },
    { key: 'total', label: 'Total', align: 'right', sortValue: (d) => d.total, render: (d) => <span className="text-white font-bold tabular-nums">{currency(d.total)}</span> },
    {
      key: 'status', label: 'Status',
      // Sorted by the label on screen, not the raw status — "Missing VAT" and
      // "Suspected duplicate" both being `review` made the column look
      // unsorted to anyone reading it.
      sortValue: (d) => statusLabel(d),
      render: (d) => {
        const label = statusLabel(d);
        if (d.status === 'ready') {
          // Green Ready vs yellow Ready: a previous publish having failed is
          // the whole difference, and it was invisible in this table.
          return d.publishFailed
            ? <Pill tone="amber" {...noteTitle(d.statusNote)}>{label}</Pill>
            : <Pill tone="green">Ready</Pill>;
        }
        if (d.status === 'review') return <Pill tone="amber">{label}</Pill>;
        // Rejected and Processing carry their reason too — a bare "Rejected"
        // hides the one thing that says what to do about it.
        if (d.status === 'rejected') return <Pill tone="red" {...noteTitle(d.statusNote)}>{label}</Pill>;
        if (d.status === 'published') return <Pill tone="blue">Published</Pill>;
        return <Pill {...noteTitle(d.statusNote)}>{label}</Pill>;
      },
    },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#0a0a0c] h-full overflow-hidden">
      <header className="px-10 pt-8 pb-5 shrink-0">
        <button
          onClick={() => openClient(null)}
          className="flex items-center gap-2 text-[13px] font-bold text-zinc-500 hover:text-white transition-colors mb-5"
        >
          <ArrowLeft size={15} />
          All clients
        </button>

        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="flex items-center gap-5 min-w-0">
            <div className="w-16 h-16 rounded-3xl bg-[#202026] flex items-center justify-center font-sans text-3xl font-bold text-white border border-white/5 shadow-inner shrink-0 overflow-hidden">
              {client.logoDataUrl ? (
                <img src={client.logoDataUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                client.name.charAt(0)
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <h1 className="font-sans text-3xl font-semibold text-white tracking-tight truncate">{client.name}</h1>
                <button
                  onClick={() => toggleStarClient(client.id)}
                  className={starredClientIds.includes(client.id) ? 'text-[#14e3c4]' : 'text-zinc-700 hover:text-zinc-400'}
                >
                  <Star size={18} fill={starredClientIds.includes(client.id) ? 'currentColor' : 'none'} />
                </button>
              </div>
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                <Pill>{client.industry}</Pill>
                {client.companyType && <Pill>{client.companyType}</Pill>}
                {client.awaitingRegistration && <Pill tone="amber">Awaiting client registration</Pill>}
                <Pill tone={healthTone(s.health)}>Pipeline health {s.health}%</Pill>
                {client.xeroConnected ? <Pill tone="blue">Xero</Pill> : <Pill tone="red">No ledger</Pill>}
                {client.bankConnected ? <Pill tone="green">Bank feed live</Pill> : <Pill tone="amber">Statement fallback</Pill>}
                {setupLink && setupLink.completed.length < setupLink.tasks.length && (
                  <Pill tone="amber">Setup link sent</Pill>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => startConversation([client.id])}
              className="flex items-center gap-2 px-5 py-2.5 bg-[#14e3c4]/10 text-[#14e3c4] border border-[#14e3c4]/20 text-sm font-bold rounded-full hover:bg-[#14e3c4]/20 transition-all"
            >
              <Sparkles size={16} />
              Ask AI
            </button>
            <button
              disabled={s.missing === 0}
              onClick={chaseClient}
              className="flex items-center gap-2 px-6 py-2.5 bg-[#14e3c4] text-white text-sm font-bold rounded-full hover:bg-[#0fcbaf] transition-all shadow-[0_0_15px_rgba(20,227,196,0.2)] disabled:opacity-40"
            >
              <Send size={16} />
              Chase {s.missing > 0 ? `(${s.missing})` : ''}
            </button>
          </div>
        </div>
      </header>

      <div className="px-10 pb-5 flex items-center gap-2 shrink-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-full text-[13px] font-bold transition-all border whitespace-nowrap ${
              tab === t
                ? 'bg-[#14e3c4] text-white border-[#14e3c4] shadow-[0_0_12px_rgba(20,227,196,0.25)]'
                : 'bg-[#16161a] text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-10 pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {tab === 'Overview' && (
            <div className="flex flex-col gap-6">
              {/* Wireframe's pipeline snapshot — the same seven figures, in the
                  same order, each one drilling to the tab that can act on it. */}
              <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-4">
                <Tile label="In processing" value={s.processing} hint="ETA per item" onClick={() => setTab('Costs')} />
                <Tile label="To review" value={s.toReview} onClick={() => setTab('Costs')} />
                <Tile label="Ready" value={s.ready} onClick={() => setTab('Costs')} />
                <Tile label="Rejected / failed" value={s.rejected} tone="red" onClick={() => setTab('Costs')} />
                <Tile
                  label="Missing docs"
                  value={s.missing}
                  tone="red"
                  onClick={() => setTab('Chases')}
                  {...(s.missing > 0 ? { action: { label: 'Chase', onClick: () => chaseClient() } } : {})}
                />
                <Tile label="Unmatched bank txns" value={s.unmatched} tone="red" onClick={() => setTab('Bank')} />
                <Tile label="Awaiting approval" value={s.approvals} onClick={() => setTab('Approvals')} />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
                <Panel title="Channel mix" icon={Radio}>
                  <p className="text-[12px] text-zinc-500 mb-4 leading-relaxed">
                    How this client's documents arrive. Email lands at{' '}
                    <span className="text-zinc-300 font-semibold">{settings.docEmail}</span>.
                  </p>
                  {channelMix.length === 0 ? (
                    <p className="text-[13px] text-zinc-500">No documents in yet.</p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {channelMix.map((c) => (
                        <div key={c.source}>
                          <div className="flex justify-between items-baseline gap-3 mb-1.5">
                            <span className="text-[13px] text-zinc-300 font-semibold">{CHANNEL_LABEL[c.source]}</span>
                            <span className="text-[13px] text-white font-bold tabular-nums">{c.pct}%</span>
                          </div>
                          <div className="h-1.5 w-full bg-[#202026] rounded-full overflow-hidden shadow-inner">
                            <div className="h-full rounded-full bg-[#14e3c4]" style={{ width: `${c.pct}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Panel>

                {/* Wireframe puts integration health on Overview, not buried on
                    the Integrations tab — a dead token stops the pipeline. */}
                <Panel title="Integration health" icon={Landmark}>
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-[#0a0a0c]/60 border border-white/5">
                      <div className="min-w-0">
                        <div className="text-[13px] font-bold text-white">Accounting software</div>
                        <div className="text-[12px] text-zinc-500">
                          {client.xeroConnected ? 'Xero token valid — re-auth in 284d' : 'No ledger connected'}
                        </div>
                      </div>
                      {client.xeroConnected ? <Pill tone="green">Live</Pill> : <Pill tone="red">Off</Pill>}
                    </div>

                    {clientAccounts.length === 0 ? (
                      <div className="p-3.5 rounded-2xl bg-[#0a0a0c]/60 border border-white/5">
                        <div className="text-[13px] font-bold text-white">Bank feed</div>
                        <div className="text-[12px] text-zinc-500">No account on file.</div>
                      </div>
                    ) : (
                      clientAccounts.map((a) => (
                        <div key={a.id} className="flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-[#0a0a0c]/60 border border-white/5">
                          <div className="min-w-0">
                            <div className="text-[13px] font-bold text-white truncate">
                              {a.bankName} ••{a.last4}
                            </div>
                            <div className="text-[12px] text-zinc-500">
                              {a.status === 'live'
                                ? `Re-auth in ${a.reauthDays}d · synced ${a.lastSync}`
                                : a.status === 'error'
                                ? 'Credential error — feed has stalled'
                                : 'Disconnected — statement upload only'}
                            </div>
                          </div>
                          {/* Open banking consent expires every 90 days; this is
                              the one integration action the practice can take. */}
                          {a.status === 'live' && a.reauthDays > 14 ? (
                            <Pill tone="green">Live</Pill>
                          ) : (
                            <button
                              onClick={() => reauthAccount(a.id)}
                              className="shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors"
                            >
                              <RefreshCw size={13} strokeWidth={2.5} />
                              Re-auth now
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </Panel>

                <Panel title="Recent activity" icon={History}>
                  {activity.length === 0 ? (
                    <p className="text-[13px] text-zinc-500 leading-relaxed">
                      Nothing yet. Approvals, chases and publishes for this client appear here as they happen.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {activity.map((e) => (
                        <div key={e.id} className="flex gap-3">
                          <div className="w-1.5 h-1.5 rounded-full bg-[#14e3c4] mt-2 shrink-0" />
                          <div className="min-w-0">
                            <div className="text-[13px] text-white font-semibold leading-snug">{e.label}</div>
                            <div className="text-[12px] text-zinc-500 leading-snug">{e.detail}</div>
                            <div className="text-[11px] text-zinc-600 font-semibold uppercase tracking-wider mt-0.5">
                              {e.actor} · {e.at}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Panel>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Panel title="Pipeline health" icon={Activity}>
                  <div className="flex items-end justify-between mb-3">
                    <span className="text-4xl font-bold text-white tracking-tight tabular-nums">{s.health}%</span>
                    <span className="text-[12px] text-zinc-500 font-semibold">document pipeline only</span>
                  </div>
                  <div className="h-2 w-full bg-[#202026] rounded-full overflow-hidden shadow-inner mb-5">
                    <div
                      className={`h-full rounded-full ${s.health > 80 ? 'bg-[#14e3c4]' : s.health > 50 ? 'bg-amber-400' : 'bg-red-500'}`}
                      style={{ width: `${s.health}%` }}
                    />
                  </div>
                  <div className="flex flex-col gap-2.5 text-[13px]">
                    <Row label="Unverified spend" value={currency(s.unverified)} />
                    <Row label="Item delay" value={`${s.itemDelay} days`} />
                    <Row label="Suppliers on auto-publish" value={`${s.autoPublishCoverage}%`} />
                    <Row label="Duplicates flagged" value={String(s.duplicates)} />
                    <Row label="Overdue chases" value={String(s.overdue)} />
                    <Row label="Unexplained transactions" value={String(s.unmatched)} />
                    <Row label="Statement gaps" value={String(s.statementGaps)} />
                    <Row label="Rejected / failed" value={String(s.rejected)} />
                  </div>
                </Panel>

                <Panel title="Client contact" icon={Users}>
                  <div className="flex flex-col gap-2.5 text-[13px]">
                    <Row label="Primary contact" value={client.contactName ?? '—'} />
                    <Row label="Mobile" value={client.mobile ?? '—'} />
                    <Row label="VAT number" value={client.vatNumber ?? '—'} />
                    <Row label="Next deadline" value={client.deadline} />
                    <Row label="Chase policy" value={chase?.policy ?? 'Standard (3/7 days)'} />
                    <Row label="Last upload" value={chase?.lastUpload ?? '—'} />
                  </div>
                  <p className="text-[12px] text-zinc-500 mt-5 leading-relaxed">
                    Chasing is SMS-only to this number. The client needs no app — the secure link opens in any phone browser.
                  </p>
                </Panel>
              </div>
            </div>
          )}

          {/* Wireframe screen 8. Both inboxes are the same component over
              opposite sides of the ledger. */}
          {(tab === 'Costs' || tab === 'Sales') && (
            <ClientInbox client={client} kind={tab === 'Costs' ? 'cost' : 'sales'} onPreview={setPreview} />
          )}

          {/* Wireframe: "[AI] tab = same chat as screen 3, pre-scoped to this
              client." The chat is the full workspace, so this tab is the way
              in and the record of what has already been asked. */}
          {tab === 'AI' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Panel title="Ask about this client" icon={Bot}>
                <p className="text-[13px] text-zinc-500 leading-relaxed mb-5">
                  Opens the workspace on a conversation already scoped to {client.name} — every answer is drawn from
                  this client's pipeline only. Analysis stays within document operations; it does not prepare
                  financial statements.
                </p>
                <div className="flex flex-col gap-2 mb-5">
                  {([
                    { q: `What is still missing for ${client.name}?`, intent: 'SHOW_MISSING' },
                    { q: `Show the bank matches for ${client.name}`, intent: 'SHOW_MATCHES' },
                    { q: `Which items are waiting on approval?`, intent: 'SHOW_APPROVALS' },
                  ] satisfies { q: string; intent: Intent }[]).map((p) => (
                    <button
                      key={p.q}
                      onClick={() => scoped(p.intent, p.q, 'Here you go:')}
                      className="text-left px-4 py-3 rounded-2xl bg-[#0a0a0c]/60 border border-white/5 text-[13px] text-zinc-300 hover:text-white hover:border-white/15 transition-colors"
                    >
                      {p.q}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => startConversation([client.id])}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors shadow-[0_0_15px_rgba(20,227,196,0.25)]"
                >
                  <Sparkles size={15} />
                  New conversation
                </button>
              </Panel>

              <Panel title="Conversations about this client" icon={History}>
                {clientConversations.length === 0 ? (
                  <p className="text-[13px] text-zinc-500 leading-relaxed">
                    None yet. Anything you ask with {client.name} attached is kept here.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {clientConversations.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => {
                          selectConversation(c.id);
                          setActiveTab('AI Workspace');
                          openClient(null);
                        }}
                        className="text-left p-4 rounded-2xl bg-[#0a0a0c]/60 border border-white/5 hover:border-white/15 transition-colors"
                      >
                        <div className="text-[13px] font-bold text-white truncate">{c.title}</div>
                        <div className="text-[12px] text-zinc-500 mt-0.5">
                          {c.messages.length} message{c.messages.length === 1 ? '' : 's'}
                          {c.attachedClientIds.length > 1 ? ` · ${c.attachedClientIds.length} clients attached` : ''}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </Panel>
            </div>
          )}

          {/* Wireframe screen 10, Statements sub-tab: uploaded statements plus
              gap detection, where a gap is chaseable in one step. */}
          {/* Supplier statements — the supplier's own list of what they
              invoiced, reconciled against what we hold. Bank statements are a
              different thing and live on the Bank tab. */}
          {tab === 'Supplier Statements' && <ClientSupplierStatements client={client} />}

          {tab === 'Expense Claims' && <ClientExpenseClaims client={client} onPreview={setPreview} />}

          {/* The whole bank surface, pinned to this client. There is no
              practice-wide Bank any more — bank data is always one client's,
              so matching, cash coding, match rules, statement upload and gap
              detection all live here. */}
          {tab === 'Bank' && <BankView clientId={client.id} />}

          {tab === 'Chases' && (
            <DataTable<MissingItem>
              className="max-w-none"
              columns={[
                { key: 'supplier', label: 'Supplier', sortValue: (m) => m.supplier, render: (m) => <span className="text-white font-semibold">{m.supplier}</span> },
                { key: 'date', label: 'Date', sortValue: (m) => m.date },
                { key: 'detectedBy', label: 'Detected by', sortValue: (m) => m.detectedBy, render: (m) => <Pill>{m.detectedBy}</Pill> },
                { key: 'chased', label: 'Status', sortValue: (m) => String(m.chased), render: (m) => (m.chased ? <Pill tone="blue">Requested</Pill> : <Pill tone="red">Not chased</Pill>) },
                { key: 'amount', label: 'Amount', align: 'right', sortValue: (m) => m.amount, render: (m) => <span className="text-white font-bold tabular-nums">{m.amount ? currency(m.amount) : '—'}</span> },
                {
                  // The verb on the row, so one item can be chased without
                  // ticking it first. Already-requested items say so and offer
                  // the nudge instead, since asking twice is a different act.
                  key: 'actions', label: '', align: 'right',
                  render: (m) => (
                    <button
                      onClick={(e) => { e.stopPropagation(); chaseItems([m]); }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold text-[#14e3c4] bg-[#14e3c4]/10 border border-[#14e3c4]/25 hover:bg-[#14e3c4]/20 transition-colors whitespace-nowrap"
                    >
                      <Send size={12} strokeWidth={2.5} />
                      {m.chased ? 'Chase again' : 'Chase'}
                    </button>
                  ),
                },
              ]}
              rows={miss}
              rowId={(m) => m.id}
              selectable
              actionsOnTop
              emptyMessage="Nothing outstanding for this client."
              bulkActions={[
                {
                  label: 'Chase selected', icon: Send, primary: true,
                  onClick: (sel) => chaseItems(sel),
                },
              ]}
              footer={`${s.missing} not chased • ${s.requested} requested • ${s.overdue} overdue`}
            />
          )}

          {tab === 'Tasks' && (
            <Panel title="Document-workflow tasks" icon={ListChecks}>
              <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
                <p className="text-[13px] text-zinc-500 leading-relaxed max-w-xl">
                  The recurring checklist for {client.name}. Steps marked AI-prefilled can be answered from real
                  pipeline state rather than from memory.
                </p>
                <button
                  onClick={() => setAddingTask(true)}
                  className="shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors shadow-[0_0_15px_rgba(20,227,196,0.25)]"
                >
                  <Plus size={15} strokeWidth={2.5} />
                  Add task
                </button>
              </div>
              {clientTasks.length === 0 ? (
                <p className="text-[13px] text-zinc-500">No tasks for this client.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {clientTasks.map((t) => {
                    const blocker = t.dependsOn ? clientTasks.find((x) => x.id === t.dependsOn) : undefined;
                    const blocked = !!blocker && blocker.status === 'open';
                    const open = t.status === 'open';
                    return (
                      <div key={t.id} className="flex items-center gap-3 p-4 rounded-2xl bg-[#0a0a0c]/60 border border-white/5">
                        <button
                          onClick={() => setTaskStatus(t.id, open ? 'complete' : 'open')}
                          disabled={blocked && open}
                          title={blocked && open ? `Waiting on: ${blocker?.title}` : open ? 'Mark complete' : 'Reopen'}
                          className={`shrink-0 transition-colors ${
                            !open ? 'text-[#14e3c4]' : blocked ? 'text-zinc-700 cursor-not-allowed' : 'text-zinc-600 hover:text-white'
                          }`}
                        >
                          {open ? <Circle size={18} /> : <CheckCircle size={18} />}
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className={`text-[13px] font-bold ${open ? 'text-white' : 'text-zinc-500 line-through'}`}>
                            {t.title}
                          </div>
                          <div className="text-[12px] text-zinc-500">
                            {t.assignee} · due {t.due}
                            {blocked && open ? ` · waiting on "${blocker?.title}"` : ''}
                          </div>
                        </div>
                        {t.aiPrefilled && open && <Pill tone="blue">AI-prefilled</Pill>}
                        {t.status === 'complete' && <Pill tone="green">Complete</Pill>}
                        {t.status === 'complete-with-issues' && <Pill tone="amber">With issues</Pill>}
                        {t.status === 'not-applicable' && <Pill>N/A</Pill>}
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
          )}

          {tab === 'Approvals' && (
            <div className="flex flex-col gap-6">
              {/* Items on a client-side stage. Nobody in the practice can clear
                  these — the only move is getting the SMS link to the approver
                  and, if they go quiet, chasing it. */}
              {clientSideItems.length > 0 && (
                <div className="border border-[#14e3c4]/20 rounded-[28px] bg-[#14e3c4]/[0.05] p-5 flex items-center justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-[14px] font-bold text-white">
                      {clientSideItems.length} item{clientSideItems.length === 1 ? '' : 's'} waiting on {client.name}
                    </div>
                    <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">
                      {clientSideItems.map((a) => `${a.supplier} ${currency(a.total)}`).join(' · ')}
                      {approvalRequest
                        ? ` — link sent ${approvalRequest.sentAt} to ${approvalRequest.recipientMobile}${approvalRequest.verified ? ', opened' : ', not opened yet'}`
                        : ' — no link sent yet'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {approvalRequest && (
                      <button
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Text ${approvalRequest.recipientName} again?`,
                            detail: `A fresh link replaces the one sent ${approvalRequest.sentAt}. Their previous link stops working.`,
                            confirmLabel: 'Yes, resend it',
                          });
                          if (ok) resendApprovalRequest(approvalRequest.id);
                        }}
                        disabled={resendIn > 0}
                        title={
                          resendIn > 0
                            ? `The link sent ${approvalRequest.sentAt} is still live. Resend unlocks in ${resendIn}h — change the wait under Settings → Chasing.`
                            : 'Send a fresh link'
                        }
                        className="px-4 py-2 rounded-full text-[12px] font-bold text-zinc-400 border border-white/10 hover:text-white hover:border-white/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {resendIn > 0 ? `Resend in ${resendIn}h` : 'Resend'}
                      </button>
                    )}
                    {/* Two acts, two buttons. Sending texts the approver;
                        opening steps into their view to see what they see.
                        Bundling them meant you could not do one without the
                        other. */}
                    {!approvalRequest && (
                      <button
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Text ${client.contactName ?? 'the approver'} for approval?`,
                            detail: `${clientSideItems.length} item${clientSideItems.length === 1 ? '' : 's'} · ${currency(clientSideItems.reduce((n, a) => n + a.total, 0))} to ${client.mobile}.`,
                            consequence: 'One link covers the whole batch and expires with the chase policy.',
                            confirmLabel: 'Yes, send it',
                          });
                          if (ok) sendApprovalRequest(client.id);
                        }}
                        disabled={!client.mobile}
                        title={client.mobile ? undefined : 'No mobile on file for this client'}
                        className="flex items-center gap-2 px-5 py-2 rounded-full text-[12px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <Send size={13} strokeWidth={2.5} />
                        Send the request
                      </button>
                    )}
                    <button
                      onClick={() => openApprovalLink(approvalRequest?.id ?? `appr-req-${client.id}-0`)}
                      disabled={!approvalRequest}
                      title={approvalRequest ? 'See exactly what the approver sees' : 'Send the request first'}
                      className="flex items-center gap-2 px-5 py-2 rounded-full text-[12px] font-bold text-[#14e3c4] bg-[#14e3c4]/10 border border-[#14e3c4]/25 hover:bg-[#14e3c4]/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <Smartphone size={13} strokeWidth={2.5} />
                      Open the link
                    </button>
                  </div>
                </div>
              )}

              <DataTable
                className="max-w-none"
                title="Pending items"
                subtitle="Approving here is the same queue an approver sees under Approvals"
                columns={[
                  { key: 'supplier', label: 'Supplier', sortValue: (a) => a.supplier, render: (a) => <span className="text-white font-semibold">{a.supplier}</span> },
                  { key: 'stage', label: 'Stage', sortValue: (a) => a.stage },
                  { key: 'approver', label: 'Approver', sortValue: (a) => a.approver },
                  {
                    key: 'side', label: 'Signed off by',
                    render: (a) =>
                      approvalWorkflows.find((w) => w.id === a.workflowId)?.stages[a.stageIndex]?.clientSide
                        ? <Pill tone="amber">Client — by SMS</Pill>
                        : <Pill tone="blue">Practice</Pill>,
                  },
                  { key: 'waitingDays', label: 'Waiting', align: 'right', sortValue: (a) => a.waitingDays, render: (a) => (a.waitingDays >= 5 ? <Pill tone="red">{a.waitingDays}d</Pill> : <Pill>{a.waitingDays}d</Pill>) },
                  { key: 'total', label: 'Total', align: 'right', sortValue: (a) => a.total, render: (a) => <span className="text-white font-bold tabular-nums">{currency(a.total)}</span> },
                  {
                    // Every action the row allows, on the row. Edit appears
                    // only where the stage permits it, and neither Approve nor
                    // Reject is offered on a stage that has left the practice.
                    key: 'actions', label: '', align: 'right',
                    render: (a) => {
                      const stage = approvalWorkflows.find((w) => w.id === a.workflowId)?.stages[a.stageIndex];
                      if (a.state !== 'pending') {
                        return a.state === 'approved' ? <Pill tone="green">Approved</Pill> : <Pill tone="red">Rejected</Pill>;
                      }
                      if (stage?.clientSide) return <Pill tone="amber">With the client</Pill>;
                      return (
                        <span className="flex items-center justify-end gap-1.5">
                          {stage?.canEdit && a.documentId && (
                            <ApprovalAction
                              icon={PencilLine}
                              title="Correct the coding before approving"
                              onClick={() => {
                                const doc = documents.find((d) => d.id === a.documentId);
                                if (doc) setPreview(doc);
                              }}
                            />
                          )}
                          <ApprovalAction
                            icon={XIcon}
                            title="Reject this item"
                            tone="red"
                            onClick={async () => {
                              const ok = await confirm({
                                tone: 'red',
                                title: `Reject ${a.supplier}?`,
                                detail: `${currency(a.total)} · ${a.category}. It stops here and is not published.`,
                                consequence: 'No reason is recorded from this button — open the row to add one.',
                                confirmLabel: 'Yes, reject',
                              });
                              if (ok) rejectApproval(a.id, 'Rejected from the client approvals tab');
                            }}
                          />
                          <ApprovalAction
                            icon={CheckCircle}
                            title={`Approve — passes ${a.stage}`}
                            tone="brand"
                            onClick={async () => {
                              const ok = await confirm({
                                title: `Pass ${a.stage.replace(/^Stage \d+ — /, '')} on ${a.supplier}?`,
                                detail: `${currency(a.total)} · ${a.category}. Your name goes on the approval.`,
                                consequence: 'At the last stage this locks the item and publishes it.',
                                confirmLabel: 'Yes, approve',
                              });
                              if (ok) advanceApproval(a.id);
                            }}
                          />
                        </span>
                      );
                    },
                  },
                ]}
                rows={clientApprovals}
                rowId={(a) => a.id}
                selectable
                emptyMessage={
                  clientWorkflows.length === 0
                    ? 'No workflow applies to this client, so nothing pauses for approval — Ready items publish directly.'
                    : 'Nothing awaiting approval.'
                }
                bulkActions={[
                  {
                    label: 'Approve selected', icon: CheckCircle, primary: true,
                    // Acted on here rather than in chat — the rows are already
                    // picked, so there is nothing left to ask the agent.
                    onClick: async (sel) => {
                      const mine = sel.filter(
                        (a) => a.state === 'pending' && !approvalWorkflows.find((w) => w.id === a.workflowId)?.stages[a.stageIndex]?.clientSide,
                      );
                      if (mine.length === 0) {
                        await confirm({
                          tone: 'red',
                          title: 'Nothing here is yours to approve',
                          detail: 'These are either already decided or sitting with the client.',
                          confirmLabel: 'Close',
                        });
                        return;
                      }
                      const ok = await confirm({
                        title: `Pass ${mine.length} item${mine.length === 1 ? '' : 's'}?`,
                        detail: mine.map((a) => `${a.supplier} ${currency(a.total)}`).slice(0, 4).join(' · '),
                        consequence: 'Anything on its last stage locks and publishes to the accounting software.',
                        confirmLabel: 'Yes, approve',
                      });
                      if (ok) mine.forEach((a) => advanceApproval(a.id));
                    },
                  },
                ]}
              />

              <div>
                <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
                  <div>
                    <h3 className="font-sans font-bold text-lg text-white tracking-tight">Workflows</h3>
                    <p className="text-[12px] text-zinc-500 mt-0.5">
                      Approvals are opt-in. With no active workflow this client has no approval step at all — items
                      go Ready → publish with nothing pausing.
                    </p>
                  </div>
                  <button
                    onClick={() => setEditingWorkflow(blankWorkflow())}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors shadow-[0_0_15px_rgba(20,227,196,0.25)]"
                  >
                    <Plus size={15} strokeWidth={2.5} />
                    New workflow
                  </button>
                </div>
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                  {approvalWorkflows.map((w) => (
                    <WorkflowCard
                      key={w.id}
                      workflow={w}
                      usage={clientApprovals.filter((a) => a.workflowId === w.id).length}
                      onEdit={() => setEditingWorkflow(w)}
                      onToggle={() => saveWorkflow({ ...w, active: !w.active })}
                      onDelete={async () => {
                        const ok = await confirm({
                          tone: 'red',
                          title: `Delete the "${w.name}" workflow?`,
                          detail: `${w.stages.length} stage${w.stages.length === 1 ? '' : 's'}, applying to ${w.appliesTo}.`,
                          consequence: 'Items on it stop pausing for approval and publish straight through.',
                          confirmLabel: 'Yes, delete it',
                        });
                        if (ok) deleteWorkflow(w.id);
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'Documents' && (
            <DataTable<Document>
              className="max-w-none"
              columns={docColumns}
              rows={docs}
              rowId={(d) => d.id}
              selectable
              onRowClick={(d) => setPreview(d)}
              emptyMessage="No documents yet."
              bulkActions={[
                { label: 'Preview', icon: Eye, onClick: (sel) => sel[0] && setPreview(sel[0]) },
                { label: 'Download', icon: Download, primary: true, onClick: (sel) => downloadDocuments(sel, client.name) },
                {
                  label: 'Retry failed', icon: RefreshCw,
                  onClick: async (sel) => {
                    const failed = sel.filter((d) => d.status === 'rejected');
                    if (failed.length === 0) return;
                    const ok = await confirm({
                      title: `Retry ${failed.length} failed item${failed.length === 1 ? '' : 's'}?`,
                      detail: 'Anything that failed to extract is read again; anything that failed to publish goes back to Ready to be pushed again. Whatever was already read off a document is kept.',
                      confirmLabel: 'Yes, retry',
                    });
                    if (ok) failed.forEach((d) => retryDocument(d.id));
                  },
                },
              ]}
              footer={`${docs.length} total • ${s.published} published • ${s.rejected} rejected — click a row to preview`}
            />
          )}

          {tab === 'Users' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Panel title="Business users" icon={Users}>
                <p className="text-[13px] text-zinc-500 leading-relaxed mb-5">
                  People at {client.name} who can send paperwork. You propose them and set what they may do — the
                  business approves before anyone is contacted, because who works there is their call, not yours.
                </p>

                <div className="flex flex-col gap-2">
                  {businessMembers.length === 0 && (
                    <p className="text-[13px] text-zinc-500 py-2">
                      Nobody yet. Invite whoever handles the paperwork.
                    </p>
                  )}
                  {businessMembers.map((m) => (
                    <div key={m.id} className="p-4 rounded-2xl bg-[#0a0a0c]/60 border border-white/5 flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-[#202026] border border-white/5 flex items-center justify-center overflow-hidden font-bold text-white shrink-0">
                        {m.avatarDataUrl
                          ? <img src={m.avatarDataUrl} alt="" className="w-full h-full object-cover" />
                          : (m.name.trim().charAt(0).toUpperCase() || '?')}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold text-white truncate">{m.name || 'Unnamed'}</div>
                        <div className="text-[12px] text-zinc-500 truncate">
                          {m.status === 'pending-client-approval'
                            ? `Proposed ${m.invitedAt ?? ''} · nothing sent to them yet`
                            : m.status === 'declined'
                            ? `Declined by the business${m.declinedReason ? ` — ${m.declinedReason}` : ''}`
                            : m.status === 'invited'
                            ? `Approved by ${m.approvedBy ?? 'the business'} · invite ${channelLabel('user-invite')} to ${m.email || 'their email'}`
                            : m.email || m.mobile || 'No contact on file'}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                        <Pill tone={m.role === 'Owner' ? 'blue' : 'neutral'}>{m.role}</Pill>
                        {m.status === 'pending-client-approval'
                          ? <Pill tone="amber">Waiting client approval</Pill>
                          : m.status === 'declined'
                          ? <Pill tone="red">Declined by the client</Pill>
                          : m.status === 'invited'
                          ? <Pill tone="amber">Awaiting registration</Pill>
                          : <Pill tone="green">Registered</Pill>}
                        {/* Demo affordance: open the link as that person. */}
                        {m.status === 'invited' && businessAccount && (
                          <button
                            onClick={() => openRegistrationLink(businessAccount.id, m.id)}
                            className="px-3 py-1.5 rounded-full text-[11px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors"
                          >
                            Open link
                          </button>
                        )}
                      </div>
                    </div>
                  ))}

                  <button
                    onClick={() => setInviting(true)}
                    className="flex items-center justify-center gap-2 p-3.5 rounded-2xl border border-dashed border-white/10 text-[13px] font-bold text-zinc-400 hover:text-white hover:border-white/25 transition-colors"
                  >
                    <Plus size={15} />
                    Add user
                  </button>
                </div>
              </Panel>

              <Panel title="Contacts" icon={Users}>
                <div className="flex flex-col gap-3">
                  <ContactRow name={client.contactName ?? 'Primary contact'} detail={client.mobile ?? 'No mobile on file'} role="Primary — receives chases" />
                  <ContactRow name="Accounts inbox" detail={`Forwards to ${settings.docEmail}`} role="Document owner on email intake" />
                </div>
                <p className="text-[12px] text-zinc-500 mt-5 leading-relaxed">
                  A contact is a verified phone number and nothing more — it receives chases and uploads through OTP
                  links without ever being provisioned as a user. A business user, above, can sign in to the portal.
                </p>
              </Panel>
            </div>
          )}

          {tab === 'Integrations' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Panel title="Connections" icon={Link2}>
                <div className="flex flex-col gap-3">
                  <ConnectionRow
                    name="Accounting software"
                    detail="Chart of accounts, tax rates and tracking categories sync both ways"
                    connected={client.xeroConnected}
                    requested={setupLink?.tasks.includes('ledger') ?? false}
                  />
                  <ConnectionRow
                    name="Bank feed (open banking)"
                    detail={client.bankConnected ? 'Re-auth due in 62 days' : 'Statement upload is the fallback until connected'}
                    connected={client.bankConnected}
                    requested={setupLink?.tasks.includes('bank') ?? false}
                  />
                </div>
                <p className="text-[12px] text-zinc-500 mt-5 leading-relaxed">
                  Only the client can switch these on — both need their own login at the provider, which the practice
                  never holds. Ask for them with a setup link.
                </p>
              </Panel>

              <Panel title="Client setup link" icon={Smartphone}>
                {setupLink ? (
                  <>
                    <div className="flex flex-col gap-2.5 text-[13px]">
                      <Row label="Sent to" value={`${setupLink.recipientName} · ${setupLink.recipientMobile}`} />
                      <Row label="Sent" value={setupLink.sentAt} />
                      <Row label="Expires" value={`${setupLink.expiresInHours}h from sending`} />
                      <Row label="Resent" value={setupLink.resendCount === 0 ? 'Not resent' : `${setupLink.resendCount}×`} />
                    </div>
                    <div className="flex flex-col gap-2 mt-4">
                      {setupLink.tasks.map((t) => (
                        <div key={t} className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-[#0a0a0c]/60 border border-white/5">
                          <span className="text-[13px] font-semibold text-white">
                            {t === 'profile' ? 'Company details' : t === 'ledger' ? 'Accounting software' : 'Bank feed'}
                          </span>
                          {setupLink.completed.includes(t) ? (
                            <Pill tone="green">{t === 'profile' ? 'Registered by client' : 'Connected by client'}</Pill>
                          ) : (
                            <Pill tone="amber">Waiting on client</Pill>
                          )}
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Text ${setupLink.recipientName} again?`,
                          detail: `A fresh setup link replaces the one sent ${setupLink.sentAt}. Their previous link stops working.`,
                          confirmLabel: 'Yes, resend it',
                        });
                        if (ok) resendOnboardingLink(setupLink.id);
                      }}
                      className="mt-4 flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors"
                    >
                      <Send size={15} />
                      Resend link
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-[13px] text-zinc-500 leading-relaxed">
                      {pendingTasks.length === 0
                        ? 'Everything the client had to connect is connected.'
                        : 'No setup link has been sent. One SMS covers everything still outstanding.'}
                    </p>
                    {pendingTasks.length > 0 && (
                      <button
                        onClick={() => sendOnboardingLink(client, pendingTasks)}
                        disabled={!client.mobile}
                        className="mt-4 flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <Send size={15} />
                        Send setup link
                      </button>
                    )}
                    {pendingTasks.length > 0 && !client.mobile && (
                      <p className="text-[12px] text-amber-400 font-semibold mt-3">
                        Add a mobile number on the Settings tab first.
                      </p>
                    )}
                  </>
                )}
              </Panel>

              <Panel title="Integration health" icon={Landmark}>
                <div className="flex flex-col gap-2.5 text-[13px]">
                  <Row label="Ledger token" value={client.xeroConnected ? 'Valid — 284 days' : 'Not connected'} />
                  <Row label="Bank re-auth" value={client.bankConnected ? '62 days' : '—'} />
                  <Row label="Publish failures" value={String(s.rejected)} />
                </div>
              </Panel>
            </div>
          )}

          {tab === 'Settings' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ClientDetailsPanel
                client={client}
                pending={pendingChanges}
                onPropose={proposeClientDetailChanges}
              />
            </div>
          )}
        </motion.div>
      </div>

      <AnimatePresence>
        {chasing && (
          <Modal onClose={() => setChasing(null)}>
            <div className="w-full flex flex-col items-center gap-3">
              <div className="w-full max-w-xl flex items-center justify-between gap-4 px-5 py-3 rounded-[20px] border border-white/5 bg-[#16161a] shadow-2xl">
                <p className="text-[12px] text-zinc-500">
                  Nothing sends until you read the review and approve it.
                </p>
                <button
                  onClick={() => setChasing(null)}
                  className="shrink-0 px-4 py-1.5 rounded-full text-[12px] font-bold text-zinc-400 hover:text-white transition-colors"
                >
                  Done
                </button>
              </div>
              <ChaseComposer clientIds={[client.id]} missingItemIds={chasing} />
            </div>
          </Modal>
        )}
        {addingTask && (
          <AddTaskForm
            client={client}
            colleagues={colleagues}
            existing={clientTasks}
            onAdd={(task) => { addTask(task); setAddingTask(false); }}
            onClose={() => setAddingTask(false)}
          />
        )}
        {inviting && (
          <InviteBusinessUser
            clientName={client.name}
            onSend={(invite) => { inviteBusinessUser(client.id, invite); setInviting(false); }}
            onClose={() => setInviting(false)}
          />
        )}
        {editingWorkflow && (
          <WorkflowEditor
            workflow={editingWorkflow}
            onSave={(w) => { saveWorkflow(w); setEditingWorkflow(null); }}
            onClose={() => setEditingWorkflow(null)}
          />
        )}
        {preview && (
          <Modal onClose={() => setPreview(null)}>
            <div className="w-full flex flex-col items-center gap-3">
              {/* Toolbar sits above the card so Download is reachable without
                  scrolling past a long extraction list. */}
              {/* pr-12 keeps the Download button clear of the modal's close button. */}
              <div className="w-full max-w-3xl flex items-center justify-between gap-4 pl-5 pr-12 py-3 rounded-[20px] border border-white/5 bg-[#16161a] shadow-2xl">
                <p className="text-[12px] text-zinc-500 truncate">
                  Extracted data and line items · the original stays immutable
                </p>
                <button
                  onClick={() => downloadDocuments([preview], client.name)}
                  className="shrink-0 flex items-center gap-2 px-5 py-2 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors shadow-[0_0_15px_rgba(20,227,196,0.25)]"
                >
                  <Download size={15} strokeWidth={2.5} />
                  Download
                </button>
              </div>
              {/* Kept live from state so a correction made here shows immediately. */}
              <DocumentPreview document={documents.find((d) => d.id === preview.id) ?? preview} />
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * CSV of the selected documents — one row per document, with its extracted
 * fields and line items flattened so the file is useful on its own.
 */
function downloadDocuments(rows: Document[], clientName: string) {
  if (rows.length === 0) return;

  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const header = 'Supplier,Date,Category,Status,Channel,Uploader,Currency,Total,Line items,Extracted fields\n';
  const body = rows
    .map((d) =>
      [
        esc(d.supplier), esc(d.date), esc(d.category), esc(d.status), esc(d.source), esc(d.uploader), esc(d.currency), d.total,
        esc(d.lineItems.map((l) => `${l.description} x${l.quantity} = ${l.total}`).join(' | ')),
        esc(d.fields.map((f) => `${f.label}: ${f.value}`).join(' | ')),
      ].join(','),
    )
    .join('\n');

  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // A single row always has rows[0]; a supplier that slugs to nothing already
  // falls back to "document", so the same fallback covers the lookup.
  a.download =
    rows.length === 1
      ? `${slug(clientName) || 'client'}-${slug(rows[0]?.supplier ?? '') || 'document'}.csv`
      : `${slug(clientName) || 'client'}-documents.csv`;
  a.click();
  URL.revokeObjectURL(url);
}


/**
 * One figure from the wireframe's pipeline snapshot. The whole tile drills to
 * the tab that can act on the number; `action` adds the one case where the
 * wireframe puts a verb on the line itself ("Missing docs: 14 → chase").
 */
function Tile({
  label,
  value,
  tone = 'plain',
  hint,
  onClick,
  action,
}: {
  label: string;
  value: number;
  tone?: 'plain' | 'red';
  hint?: string;
  onClick?: () => void;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="bg-[#16161a] border border-white/5 rounded-[24px] shadow-2xl flex flex-col hover:border-white/15 transition-colors">
      <button onClick={onClick} className="p-5 pb-3 text-left">
        <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest leading-tight">{label}</div>
        <div className={`mt-2 text-3xl font-bold tracking-tight tabular-nums ${tone === 'red' && value > 0 ? 'text-red-400' : 'text-white'}`}>
          {value}
        </div>
        {hint && <div className="text-[11px] text-zinc-600 font-semibold mt-1">{hint}</div>}
      </button>
      {action && (
        <button
          onClick={action.onClick}
          className="mx-3 mb-3 mt-auto px-3 py-1.5 rounded-full text-[12px] font-bold text-[#14e3c4] bg-[#14e3c4]/10 border border-[#14e3c4]/20 hover:bg-[#14e3c4]/20 transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/**
 * The client's own record. Editing it here is a proposal, not a write: a legal
 * name, a primary contact and the mobile that every chase goes to are the
 * business's facts, and a wrong mobile means the next chase reaches a stranger.
 * So the accountant fills the form and the business confirms.
 */
function ClientDetailsPanel({ client, pending, onPropose }: {
  client: Client;
  pending: ClientDetailChange[];
  onPropose: (
    clientId: string,
    changes: { field: ClientDetailChange['field']; label: string; to: string }[],
  ) => number;
}) {
  const FIELDS: { field: ClientDetailChange['field']; label: string; hint?: string }[] = [
    { field: 'name', label: 'Legal name' },
    { field: 'industry', label: 'Industry' },
    { field: 'contactName', label: 'Primary contact' },
    { field: 'mobile', label: 'Mobile', hint: 'Every chase, approval and sign-in code goes here' },
    { field: 'vatNumber', label: 'VAT number' },
    { field: 'deadline', label: 'Next deadline' },
  ];

  const current = () =>
    Object.fromEntries(FIELDS.map((f) => [f.field, String(client[f.field] ?? '')])) as Record<string, string>;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>(current);
  const [sent, setSent] = useState(0);

  /**
   * The draft is seeded from `current()`, which writes an entry for every
   * FIELDS key, and editing only overwrites them — so a FIELDS lookup is always
   * set, and the empty fallback reads the same as a field the client left blank.
   */
  const drafted = (field: ClientDetailChange['field']) => draft[field] ?? '';

  const changed = FIELDS.filter((f) => drafted(f.field).trim() !== String(client[f.field] ?? '').trim());

  return (
    <Panel title="Client details" icon={SettingsIcon}>
      {/* What is already with the client, so a second edit is not proposed
          blindly on top of the first. */}
      {pending.length > 0 && (
        <div className="mb-5 p-4 rounded-2xl border border-amber-400/25 bg-amber-400/[0.07] flex items-start gap-3">
          <Clock size={15} className="text-amber-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-[13px] font-bold text-amber-400">
              {pending.length} change{pending.length === 1 ? '' : 's'} waiting on {client.name}
            </div>
            <div className="text-[12px] text-zinc-400 mt-1 leading-relaxed">
              {pending.map((c) => `${c.label}: ${c.from} → ${c.to}`).join(' · ')}
            </div>
          </div>
        </div>
      )}

      {sent > 0 && !editing && (
        <div className="mb-5 p-4 rounded-2xl border border-[#14e3c4]/25 bg-[#14e3c4]/[0.07] flex items-start gap-3">
          <Check size={15} className="text-[#14e3c4] mt-0.5 shrink-0" strokeWidth={3} />
          <div className="min-w-0">
            <div className="text-[13px] font-bold text-white">
              Sent to {client.name} for approval
            </div>
            <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">
              {sent} change{sent === 1 ? '' : 's'} are waiting for them to confirm. Nothing on the record has changed
              yet — it updates the moment they approve.
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {FIELDS.map((f) => (
          <div key={f.field}>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
              {f.label}
              {f.hint && <span className="ml-2 normal-case tracking-normal text-zinc-600">— {f.hint}</span>}
            </div>
            {editing ? (
              <input
                value={draft[f.field]}
                onChange={(e) => setDraft({ ...draft, [f.field]: e.target.value })}
                className="w-full bg-[#0a0a0c] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#14e3c4] transition-colors"
              />
            ) : (
              <div className="w-full bg-[#0a0a0c]/60 border border-white/5 rounded-xl px-4 py-2.5 text-sm text-zinc-300">
                {String(client[f.field] ?? '') || '—'}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 mt-5 flex-wrap">
        {editing ? (
          <>
            <button
              onClick={() => {
                const n = onPropose(
                  client.id,
                  changed.map((f) => ({ field: f.field, label: f.label, to: drafted(f.field) })),
                );
                setSent(n);
                setEditing(false);
              }}
              disabled={changed.length === 0}
              className="px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-[0_0_15px_rgba(20,227,196,0.25)]"
            >
              Send {changed.length || ''} change{changed.length === 1 ? '' : 's'} for approval
            </button>
            <button
              onClick={() => { setDraft(current()); setEditing(false); }}
              className="px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <span className="text-[12px] text-zinc-500 font-semibold">
              {changed.length === 0 ? 'Nothing changed yet' : `Changing: ${changed.map((f) => f.label).join(', ')}`}
            </span>
          </>
        ) : (
          <button
            onClick={() => { setDraft(current()); setSent(0); setEditing(true); }}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
          >
            <PencilLine size={15} />
            Edit details
          </button>
        )}
      </div>

      <p className="text-[12px] text-zinc-500 leading-relaxed mt-4">
        These are the business's own facts, so {client.name} confirms any change before it takes effect. It appears in
        their portal alongside anything else waiting on them.
      </p>
    </Panel>
  );
}

/**
 * A one-off task on a client, alongside the recurring checklist. Everything a
 * task needs to be actionable is asked for: what it is, who owns it, when it is
 * due, and whether something has to happen first — a task with no owner is a
 * note, and a note does not get done.
 */
function AddTaskForm({ client, colleagues, existing, onAdd, onClose }: {
  client: Client;
  colleagues: Colleague[];
  existing: WorkflowTask[];
  onAdd: (task: WorkflowTask) => void;
  onClose: () => void;
}) {
  const eligible = colleagues.filter((c) => c.active);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState(eligible[0]?.name ?? 'You');
  const [due, setDue] = useState(client.deadline !== '—' ? client.deadline : '');
  const [dependsOn, setDependsOn] = useState('');

  const problem = !title.trim()
    ? 'Say what needs doing.'
    : !assignee
    ? 'Give it an owner.'
    : !due.trim()
    ? 'Give it a due date — an undated task never becomes urgent.'
    : '';

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">Add a task</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            On {client.name}
          </p>
        </div>

        <div className="p-6 flex flex-col gap-5">
          <Field label="What needs doing" value={title} onChange={setTitle} placeholder="Chase the missing Brakes invoice" />

          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Assign to</div>
            <div className="flex flex-wrap gap-2">
              {eligible.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setAssignee(c.name)}
                  className={`px-4 py-2.5 rounded-xl border text-[13px] font-bold transition-colors ${
                    assignee === c.name
                      ? 'bg-[#14e3c4]/10 border-[#14e3c4]/40 text-[#14e3c4]'
                      : 'bg-[#0a0a0c] border-white/5 text-zinc-400 hover:text-white'
                  }`}
                >
                  {c.name}
                  <span className="block text-[10px] font-semibold text-zinc-600 mt-0.5">{c.role}</span>
                </button>
              ))}
            </div>
            {eligible.length === 0 && (
              <p className="text-[13px] text-amber-400 font-semibold mt-2">
                No active colleagues to assign to — add one under Team first.
              </p>
            )}
          </div>

          <Field label="Due" value={due} onChange={setDue} placeholder="12 Aug 2026" />

          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
              Blocked by <span className="text-zinc-600 normal-case tracking-normal font-semibold">(optional)</span>
            </div>
            <select
              value={dependsOn}
              onChange={(e) => setDependsOn(e.target.value)}
              className="w-full bg-[#0a0a0c] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#14e3c4] transition-colors appearance-none"
            >
              <option value="" className="bg-[#16161a]">Nothing — it can start now</option>
              {existing.map((t) => (
                <option key={t.id} value={t.id} className="bg-[#16161a]">{t.title}</option>
              ))}
            </select>
            <p className="text-[12px] text-zinc-500 mt-2 leading-relaxed">
              A blocked task cannot be ticked until the one before it is done.
            </p>
          </div>

          {problem && <p className="text-[13px] text-amber-400 font-semibold">{problem}</p>}
        </div>

        <div className="p-4 bg-[#202026]/50 flex items-center gap-3 justify-end">
          <button onClick={onClose} className="px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            onClick={() =>
              onAdd({
                id: `task-${client.id}-${Date.now()}`,
                clientId: client.id,
                clientName: client.name,
                title: title.trim(),
                assignee,
                due: due.trim(),
                status: 'open',
                // Only the generated checklist steps can be answered from
                // pipeline state; a hand-written one is nobody's guess.
                aiPrefilled: false,
                dependsOn: dependsOn || undefined,
              })
            }
            disabled={!!problem}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-[0_0_15px_rgba(20,227,196,0.25)]"
          >
            <Plus size={15} strokeWidth={2.5} />
            Add the task
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Inviting someone at the business, from the practice side. Deliberately three
 * things only: what they may do, who they are, and where the link goes. Their
 * email and photo are theirs to add on the link — the practice guessing them
 * is how a record ends up subtly wrong and nobody notices.
 */
function InviteBusinessUser({ clientName, onSend, onClose }: {
  clientName: string;
  onSend: (invite: { name: string; email: string; mobile: string; role: BusinessMemberRole; canUpload: boolean; canSeeTotals: boolean }) => void;
  onClose: () => void;
}) {
  const [role, setRole] = useState<BusinessMemberRole>('Staff');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  // Defaults follow the role, and stay overridable.
  const [canUpload, setCanUpload] = useState(true);
  const [canSeeTotals, setCanSeeTotals] = useState(false);

  // The two permissions follow the role as a starting point, and stay
  // overridable. A custom role gets the conservative pair.
  const pickRole = (r: BusinessMemberRole) => {
    setRole(r);
    setCanUpload(true);
    setCanSeeTotals(r === 'Owner' || r === 'Manager');
  };

  const problem = !name.trim()
    ? 'Add their name.'
    : !email.trim()
    ? `Add an email — their invite goes ${channelLabel('user-invite')}.`
    : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    ? 'That email does not look right.'
    : !mobile.trim()
    ? 'A mobile is required — chases and approvals reach them by SMS.'
    : '';

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">Add a user at {clientName}</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            They finish their own details from the link
          </p>
        </div>

        <div className="p-6 flex flex-col gap-5">
          <RolePicker
            value={role}
            onChange={pickRole}
            hint={
              role === 'Owner'
                ? 'Full access to the portal, its settings and the figures.'
                : role === 'Manager'
                ? 'Sends documents and sees what is outstanding.'
                : role === 'Staff'
                ? 'Sends documents only — the day-to-day receipt handler.'
                : 'A role of your own. Set what they can do below.'
            }
          />

          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" value={name} onChange={setName} placeholder="Tom Whyte" />
            <Field label="Email" value={email} onChange={setEmail} placeholder="tom@americanburger.co.uk" />
          </div>
          <Field label="Mobile" value={mobile} onChange={setMobile} placeholder="+44 7700 900123" />
          <p className="text-[12px] text-zinc-500 leading-relaxed -mt-2">
            Both are needed and they do different jobs. Their invite and anything routine go {channelLabel('user-invite')};
            chases, reminders and approvals go {channelLabel('chase')}, because those have to reach someone who has
            installed nothing.
          </p>

          <div className="flex flex-col gap-2">
            <PermissionToggle
              label="Can send documents"
              hint="Upload and photograph paperwork for the business."
              value={canUpload}
              onChange={setCanUpload}
            />
            <PermissionToggle
              label="Can see totals"
              hint="Amounts and what is outstanding. Usually off for staff photographing receipts."
              value={canSeeTotals}
              onChange={setCanSeeTotals}
            />
          </div>

          {/* The practice does not get to decide who works at the business. */}
          <div className="flex items-start gap-3 p-4 rounded-2xl border border-[#14e3c4]/20 bg-[#14e3c4]/[0.06] shadow-inner">
            <ShieldCheck size={16} className="text-[#14e3c4] mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="text-[13px] font-bold text-white">{clientName} approves this first</div>
              <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
                Nothing is sent to {name.trim() || 'them'} until someone at the business agrees. It appears in their
                portal to approve, and shows here as waiting on them. If they approve, the invite goes
                {' '}{channelLabel('user-invite')} and the person adds their own photo and details.
              </p>
            </div>
          </div>

          {problem && <p className="text-[13px] text-amber-400 font-semibold">{problem}</p>}
        </div>

        <div className="p-4 bg-[#202026]/50 flex items-center gap-3 justify-end">
          <button onClick={onClose} className="px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onSend({ name, email, mobile, role, canUpload, canSeeTotals })}
            disabled={!!problem}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-[0_0_15px_rgba(20,227,196,0.25)]"
          >
            <Send size={15} />
            Ask {clientName} to approve
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** One row-level approval verb, in this site's icon-button language. */
function ApprovalAction({ icon: Icon, title, onClick, tone = 'plain' }: {
  icon: typeof CheckCircle;
  title: string;
  onClick: () => void;
  tone?: 'plain' | 'red' | 'brand';
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
      aria-label={title}
      className={`p-2 rounded-lg border transition-colors ${
        tone === 'brand'
          ? 'text-[#14e3c4] border-[#14e3c4]/25 bg-[#14e3c4]/10 hover:bg-[#14e3c4]/20'
          : tone === 'red'
          ? 'text-red-400 border-red-400/20 bg-red-400/10 hover:bg-red-400/20'
          : 'text-zinc-400 border-white/5 hover:text-white hover:border-white/20 hover:bg-white/5'
      }`}
    >
      <Icon size={14} />
    </button>
  );
}

function PermissionToggle({ label, hint, value, onChange }: {
  label: string; hint: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="bg-[#0a0a0c]/60 border border-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 shadow-inner hover:border-white/10 transition-colors text-left"
    >
      <div>
        <div className="text-sm font-bold text-white">{label}</div>
        <div className="text-[12px] text-zinc-500 mt-0.5">{hint}</div>
      </div>
      <div className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${value ? 'bg-[#14e3c4]' : 'bg-white/10'}`}>
        <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-6' : 'left-1'}`} />
      </div>
    </button>
  );
}

function Field({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
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

function Panel({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
      <div className="p-6 pb-4 flex items-center gap-3 border-b border-white/5">
        <div className="w-9 h-9 rounded-xl bg-[#202026] border border-white/5 flex items-center justify-center text-zinc-400 shadow-inner">
          <Icon size={16} />
        </div>
        <h3 className="font-sans font-bold text-lg text-white tracking-tight">{title}</h3>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center gap-4">
      <span className="text-zinc-500 font-medium">{label}</span>
      <span className="text-white font-bold text-right">{value}</span>
    </div>
  );
}

function ContactRow({ name, detail, role }: { name: string; detail: string; role: string }) {
  return (
    <div className="p-4 border border-white/5 rounded-2xl bg-[#0a0a0c]/60 shadow-inner">
      <div className="text-sm font-bold text-white">{name}</div>
      <div className="text-[12px] text-zinc-400 mt-0.5">{detail}</div>
      <div className="text-[11px] text-zinc-600 font-semibold uppercase tracking-wider mt-2">{role}</div>
    </div>
  );
}

/**
 * Status only — there is deliberately no Connect button here. The practice
 * cannot make either connection; it can only ask the client to.
 */
function ConnectionRow({ name, detail, connected, requested }: { name: string; detail: string; connected: boolean; requested: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 p-4 border border-white/5 rounded-2xl bg-[#0a0a0c]/60 shadow-inner">
      <div className="min-w-0">
        <div className="text-sm font-bold text-white">{name}</div>
        <div className="text-[12px] text-zinc-500">{detail}</div>
      </div>
      {connected ? (
        <Pill tone="green">Connected</Pill>
      ) : requested ? (
        <Pill tone="amber">Waiting on client</Pill>
      ) : (
        <Pill tone="red">Not connected</Pill>
      )}
    </div>
  );
}
