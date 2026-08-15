import { useMemo, useState } from 'react';
import {
  Search, Plus, Sparkles, Send, ExternalLink, Activity, LayoutGrid, Rows3,
  Star, Columns3, Download, X, Check,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppContext } from '../context/AppContext';
import { ClientIntakeForm } from '../components/DynamicComponents/ClientIntakeForm';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { currency } from '../lib/resolver';
import { healthTone, type ClientStats } from '../lib/selectors';
import type { Client } from '../lib/types';
import { useQueryParam } from '../lib/router';
import { ChaseModal } from '../components/DynamicComponents/ChaseModal';
import { EXPORT_HINT } from '../lib/exportRules';

const TABS = ['All', 'My clients', 'Starred'] as const;
type Tab = (typeof TABS)[number];

const OPTIONAL_COLUMNS = [
  'Integration', 'Bank', 'Health', 'To review', 'Ready', 'Missing', 'Requested',
  'Overdue', 'Unmatched', 'Statement gaps', 'Rejected', 'Approvals', 'Item delay',
  'Auto-publish', 'Next deadline',
] as const;

const DEFAULT_COLUMNS = ['Integration', 'Health', 'To review', 'Missing', 'Requested', 'Rejected', 'Next deadline'];

export function ClientsView() {
  const {
    clients, statsFor, openClient, starredClientIds, toggleStarClient, startConversation,
  } = useAppContext();

  const [tab, setTab] = useState<Tab>('All');
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const [query, setQuery] = useState('');
  // ?add=1 — the intake modal is a link, so it can be sent to a colleague.
  const [addParam, setAddParam] = useQueryParam('add');
  const adding = addParam === '1';
  const setAdding = (open: boolean) => setAddParam(open ? '1' : null);
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const [chasing, setChasing] = useState<string[] | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clients.filter((c) => {
      if (tab === 'Starred' && !starredClientIds.includes(c.id)) return false;
      if (tab === 'My clients' && !['1', '2', '3'].includes(c.id)) return false;
      if (q && !`${c.name} ${c.industry}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [clients, tab, query, starredClientIds]);

  /** Opens the workspace on a conversation already scoped to these clients. */
  const askAI = (ids: string[]) => startConversation(ids);

  /**
   * Composes here rather than opening the chat. Pressing Chase on a client is
   * the decision already made — the agent has nothing left to add, and the
   * jump would cost the list you were working through.
   */
  const chase = (ids: string[]) => setChasing(ids);

  const drill = (ids: string[], intent: any, content: string) => {
    const names = clients.filter((c) => ids.includes(c.id)).map((c) => c.name);
    startConversation(ids, [
      { id: `${Date.now()}-u`, role: 'user', content: `${content} for ${names.join(', ')}` },
      { id: `${Date.now()}-a`, role: 'assistant', content: 'Here you go:', intent, payload: { clientIds: ids, clientNames: names } },
    ]);
  };

  const tableColumns: Column<Client>[] = [
    {
      key: 'name',
      label: 'Client',
      sortValue: (c) => c.name,
      render: (c) => (
        <span className="flex items-center gap-3">
          <button
            onClick={(e) => { e.stopPropagation(); toggleStarClient(c.id); }}
            className={starredClientIds.includes(c.id) ? 'text-[#14e3c4]' : 'text-zinc-700 hover:text-zinc-400'}
          >
            <Star size={14} fill={starredClientIds.includes(c.id) ? 'currentColor' : 'none'} />
          </button>
          <span>
            <span className="block text-white font-semibold">{c.name}</span>
            <span className="block text-[11px] text-zinc-500 font-medium">
              {/* Invite-path records have no industry until the client registers. */}
              {c.awaitingRegistration ? 'Awaiting client registration' : c.industry}
            </span>
          </span>
        </span>
      ),
    },
    ...(columns.includes('Integration')
      ? [{ key: 'integration', label: 'Ledger', sortValue: (c: Client) => String(c.xeroConnected), render: (c: Client) => (c.xeroConnected ? <Pill tone="blue">Xero</Pill> : <Pill tone="red">Not connected</Pill>) }]
      : []),
    ...(columns.includes('Bank')
      ? [{ key: 'bank', label: 'Bank', sortValue: (c: Client) => String(c.bankConnected), render: (c: Client) => (c.bankConnected ? <Pill tone="green">Live</Pill> : <Pill tone="amber">Statements</Pill>) }]
      : []),
    ...(columns.includes('Health')
      ? [{
          key: 'health', label: 'Pipeline health', align: 'right' as const, sortValue: (c: Client) => statsFor(c.id).health,
          render: (c: Client) => {
            const h = statsFor(c.id).health;
            return <Pill tone={healthTone(h)}>{h}%</Pill>;
          },
        }]
      : []),
    ...countColumn('To review', columns, (c) => statsFor(c.id).toReview, (ids) => drill(ids, 'SHOW_INBOX', 'Show the inbox')),
    ...countColumn('Ready', columns, (c) => statsFor(c.id).ready, (ids) => drill(ids, 'SHOW_INBOX', 'Show ready items')),
    ...countColumn('Missing', columns, (c) => statsFor(c.id).missing, (ids) => drill(ids, 'SHOW_MISSING_TABLE', 'Show missing paperwork'), 'red'),
    ...countColumn('Requested', columns, (c) => statsFor(c.id).requested, (ids) => drill(ids, 'SHOW_MISSING_TABLE', 'Show requested paperwork')),
    ...countColumn('Overdue', columns, (c) => statsFor(c.id).overdue, (ids) => drill(ids, 'SHOW_MISSING_TABLE', 'Show overdue chases'), 'red'),
    ...countColumn('Unmatched', columns, (c) => statsFor(c.id).unmatched, (ids) => drill(ids, 'SHOW_MATCHES', 'Show bank matches'), 'red'),
    ...countColumn('Statement gaps', columns, (c) => statsFor(c.id).statementGaps, (ids) => drill(ids, 'SHOW_MISSING_TABLE', 'Show statement gaps'), 'red'),
    ...countColumn('Rejected', columns, (c) => statsFor(c.id).rejected, (ids) => drill(ids, 'SHOW_REJECTED', 'Show rejected items'), 'red'),
    ...countColumn('Approvals', columns, (c) => statsFor(c.id).approvals, (ids) => drill(ids, 'SHOW_APPROVALS', 'Show the approval queue')),
    ...(columns.includes('Item delay')
      ? [{ key: 'delay', label: 'Item delay', align: 'right' as const, sortValue: (c: Client) => statsFor(c.id).itemDelay, render: (c: Client) => <span className="tabular-nums text-zinc-400">{statsFor(c.id).itemDelay}d</span> }]
      : []),
    ...(columns.includes('Auto-publish')
      ? [{ key: 'autopub', label: 'Auto-publish', align: 'right' as const, sortValue: (c: Client) => statsFor(c.id).autoPublishCoverage, render: (c: Client) => <span className="tabular-nums text-zinc-400">{statsFor(c.id).autoPublishCoverage}%</span> }]
      : []),
    ...(columns.includes('Next deadline')
      ? [{ key: 'deadline', label: 'Next deadline', align: 'right' as const, sortValue: (c: Client) => c.deadline, render: (c: Client) => <span className="text-zinc-400">{c.deadline}</span> }]
      : []),
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#0a0a0c] h-full overflow-hidden">
      <header className="px-10 pt-8 pb-5 flex items-center justify-between gap-4 shrink-0 flex-wrap">
        <div className="flex items-baseline gap-4">
          <h1 className="font-sans text-3xl font-semibold text-white tracking-tight">Clients</h1>
          <span className="text-sm font-semibold text-zinc-500">{visible.length} of {clients.length}</span>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search clients..."
              className="w-64 bg-[#16161a] border border-white/5 rounded-full py-2.5 pl-11 pr-4 text-sm focus:outline-none focus:ring-1 focus:ring-[#14e3c4] transition-all placeholder:text-zinc-600 text-white font-medium shadow-inner"
            />
          </div>

          <div className="flex items-center bg-[#16161a] border border-white/5 rounded-full p-1 shadow-inner">
            <ViewToggle active={view === 'cards'} onClick={() => setView('cards')} icon={LayoutGrid} label="Cards" />
            <ViewToggle active={view === 'table'} onClick={() => setView('table')} icon={Rows3} label="Table" />
          </div>

          {view === 'table' && (
            <div className="relative">
              <button
                onClick={() => setColumnPickerOpen((o) => !o)}
                className="p-2.5 text-zinc-400 hover:text-white hover:bg-white/5 rounded-full border border-white/5 transition-colors bg-[#16161a]"
                title="Choose columns"
              >
                <Columns3 size={16} />
              </button>
              <AnimatePresence>
                {columnPickerOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -8, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.97 }}
                    className="absolute right-0 top-full mt-2 w-56 bg-[#16161a] border border-white/10 rounded-2xl shadow-2xl z-50 p-2 max-h-80 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  >
                    <div className="px-3 py-2 text-[11px] font-bold text-zinc-500 uppercase tracking-widest">Columns</div>
                    {OPTIONAL_COLUMNS.map((col) => (
                      <button
                        key={col}
                        onClick={() => setColumns((prev) => (prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]))}
                        className="w-full px-3 py-2 rounded-xl flex items-center justify-between gap-2 text-[13px] text-zinc-300 hover:bg-white/5 transition-colors text-left"
                      >
                        {col}
                        {columns.includes(col) && <Check size={14} strokeWidth={3} className="text-[#14e3c4]" />}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-2 px-6 py-2.5 bg-[#14e3c4] text-white text-sm font-bold rounded-full hover:bg-[#0fcbaf] transition-all shadow-[0_0_15px_rgba(20,227,196,0.2)]"
          >
            <Plus size={16} strokeWidth={2.5} />
            Add Client
          </button>
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
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-10 pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {visible.length === 0 ? (
          <div className="border border-white/5 rounded-[32px] bg-[#16161a] p-10 text-center text-zinc-500">
            No clients match this filter.
          </div>
        ) : view === 'cards' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {visible.map((client) => (
              <ClientCard
                key={client.id}
                client={client}
                starred={starredClientIds.includes(client.id)}
                onStar={() => toggleStarClient(client.id)}
                onOpen={() => openClient(client.id)}
                onAskAI={() => askAI([client.id])}
                onChase={() => chase([client.id])}
              />
            ))}
          </div>
        ) : (
          <DataTable<Client>
            className="max-w-none"
            columns={tableColumns}
            rows={visible}
            rowId={(c) => c.id}
            selectable
            onRowClick={(c) => openClient(c.id)}
            bulkActions={[
              { label: 'Ask AI', icon: Sparkles, onClick: (sel) => askAI(sel.map((c) => c.id)) },
              { label: 'Export CSV', icon: Download, minSelected: 2, disabledHint: EXPORT_HINT, onClick: (sel) => exportClients(sel, statsFor) },
              { label: 'Chase selected', icon: Send, primary: true, onClick: (sel) => chase(sel.map((c) => c.id)) },
            ]}
            footer={`${visible.length} client${visible.length === 1 ? '' : 's'} • select rows for bulk actions`}
          />
        )}
      </div>

      <AnimatePresence>
        {chasing && (
          <ChaseModal
            clientIds={chasing}
            note={chasing.length > 1 ? 'Grouped per client — one SMS each.' : undefined}
            onClose={() => setChasing(null)}
          />
        )}
        {adding && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onClick={() => setAdding(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 24, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 320, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
              className="relative"
            >
              <button
                onClick={() => setAdding(false)}
                className="absolute -top-3 -right-3 z-10 p-2 bg-[#16161a] hover:bg-[#202026] text-zinc-400 hover:text-white rounded-full border border-white/10 transition-colors shadow-lg"
              >
                <X size={18} />
              </button>
              {/* Same intake component the chat renders — one service, two entry points. */}
              <ClientIntakeForm />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A drillable count cell — clicking it opens the matching view in the workspace. */
function countColumn(
  label: string,
  enabled: string[],
  value: (c: Client) => number,
  onDrill: (ids: string[]) => void,
  tone: 'neutral' | 'red' = 'neutral',
): Column<Client>[] {
  if (!enabled.includes(label)) return [];
  return [
    {
      key: label,
      label,
      align: 'right',
      sortValue: value,
      render: (c) => {
        const n = value(c);
        return (
          <button
            onClick={(e) => { e.stopPropagation(); if (n > 0) onDrill([c.id]); }}
            disabled={n === 0}
            className={`tabular-nums font-bold px-2 py-1 rounded-lg transition-colors ${
              n === 0
                ? 'text-zinc-700'
                : tone === 'red'
                  ? 'text-red-400 hover:bg-red-500/10'
                  : 'text-white hover:bg-white/5'
            }`}
            title={n > 0 ? `Open ${label.toLowerCase()} for ${c.name}` : undefined}
          >
            {n}
          </button>
        );
      },
    },
  ];
}

function ViewToggle({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: any; label: string }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`px-3.5 py-1.5 rounded-full flex items-center gap-2 text-[13px] font-bold transition-all ${
        active ? 'bg-[#14e3c4] text-white' : 'text-zinc-500 hover:text-white'
      }`}
    >
      <Icon size={15} />
      {label}
    </button>
  );
}

function ClientCard({
  client, starred, onStar, onOpen, onAskAI, onChase,
}: {
  client: Client;
  starred: boolean;
  onStar: () => void;
  onOpen: () => void;
  onAskAI: () => void;
  onChase: () => void;
}) {
  const { statsFor } = useAppContext();
  const s = statsFor(client.id);

  return (
    <div className="border border-white/5 rounded-[32px] bg-[#16161a] p-6 flex flex-col justify-between shadow-2xl group hover:border-white/10 transition-all hover:-translate-y-1 relative overflow-hidden">
      <div className="flex justify-between items-start mb-6">
        <button
          onClick={onOpen}
          className="w-14 h-14 rounded-2xl bg-[#202026] flex items-center justify-center font-sans text-2xl font-bold text-white border border-white/5 shadow-inner hover:border-white/20 transition-colors"
        >
          {client.name.charAt(0)}
        </button>
        <div className="flex gap-2 items-center">
          <button
            onClick={onStar}
            className={`w-8 h-8 rounded-full flex items-center justify-center border transition-colors ${
              starred ? 'bg-[#14e3c4]/10 text-[#14e3c4] border-[#14e3c4]/20' : 'text-zinc-600 border-white/5 hover:text-white'
            }`}
            title={starred ? 'Unstar' : 'Star'}
          >
            <Star size={14} fill={starred ? 'currentColor' : 'none'} />
          </button>
          {client.xeroConnected && (
            <div className="w-8 h-8 rounded-full bg-[#14e3c4]/10 text-[#14e3c4] flex items-center justify-center border border-[#14e3c4]/20" title="Xero connected">
              <span className="font-bold text-[11px]">X</span>
            </div>
          )}
          {client.bankConnected && (
            <div className="w-8 h-8 rounded-full bg-[#14e3c4]/10 text-[#14e3c4] flex items-center justify-center border border-[#14e3c4]/20" title="Bank feed live">
              <span className="font-bold text-[11px]">$</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1">
        <button onClick={onOpen} className="text-left w-full">
          <h3 className="font-sans text-xl font-bold text-white leading-tight mb-1 truncate hover:text-[#14e3c4] transition-colors">
            {client.name}
          </h3>
        </button>
        <p className="text-[11px] text-zinc-500 font-bold uppercase tracking-widest mb-6">{client.industry}</p>

        <div className="mb-6">
          <div className="flex justify-between items-end mb-2">
            <span className="text-[11px] font-bold text-zinc-500 flex items-center gap-1.5 tracking-wide uppercase">
              <Activity size={12} className="text-[#14e3c4]" />
              Pipeline Health
            </span>
            <span className="text-xs font-bold text-white">{s.health}%</span>
          </div>
          <div className="h-2 w-full bg-[#202026] rounded-full overflow-hidden shadow-inner">
            <motion.div
              layout
              className={`h-full rounded-full ${s.health > 80 ? 'bg-[#14e3c4]' : s.health > 50 ? 'bg-amber-400' : 'bg-red-500'}`}
              style={{ width: `${s.health}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="bg-[#202026] p-4 rounded-2xl border border-white/5 text-center shadow-inner">
            <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">Missing</div>
            <div className={`text-2xl font-sans font-bold ${s.missing > 20 ? 'text-red-400' : 'text-white'}`}>{s.missing}</div>
          </div>
          <div className="bg-[#202026] p-4 rounded-2xl border border-white/5 text-center shadow-inner">
            <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">To Review</div>
            <div className="text-2xl font-sans font-bold text-white">{s.toReview}</div>
          </div>
        </div>

        {s.requested > 0 && (
          <div className="text-[11px] font-bold text-zinc-500 mb-3 text-center uppercase tracking-wider">
            {s.requested} already requested{s.overdue > 0 ? ` • ${s.overdue} overdue` : ''}
          </div>
        )}

        <div className="text-[12px] font-semibold text-zinc-500 flex items-center justify-center gap-2 bg-[#0a0a0c]/50 py-2 rounded-xl">
          <span className="w-2 h-2 rounded-full bg-[#14e3c4] animate-pulse" />
          Next: <span className="text-white">{client.deadline}</span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-6">
        <button onClick={onOpen} className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-2xl text-zinc-400 hover:bg-[#202026] hover:text-white transition-colors" title="Open client">
          <ExternalLink size={18} />
        </button>
        <button onClick={onAskAI} className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-2xl text-[#14e3c4] bg-[#14e3c4]/10 hover:bg-[#14e3c4]/20 transition-colors border border-[#14e3c4]/10" title="Ask AI about this client">
          <Sparkles size={18} />
        </button>
        <button onClick={onChase} className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-2xl text-zinc-400 hover:bg-[#202026] hover:text-white transition-colors disabled:opacity-30" title="Chase missing documents" disabled={s.missing === 0}>
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}

function exportClients(rows: Client[], statsFor: (id: string) => ClientStats) {
  const header = 'Client,Industry,Ledger,Bank,Health,To review,Ready,Missing,Requested,Rejected,Approvals,Unverified,Next deadline\n';
  const body = rows
    .map((c) => {
      const s = statsFor(c.id);
      return `"${c.name}","${c.industry}","${c.xeroConnected ? 'Xero' : 'none'}","${c.bankConnected ? 'live' : 'statements'}",${s.health},${s.toReview},${s.ready},${s.missing},${s.requested},${s.rejected},${s.approvals},"${currency(s.unverified)}","${c.deadline}"`;
    })
    .join('\n');
  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'clients.csv';
  a.click();
  URL.revokeObjectURL(url);
}
