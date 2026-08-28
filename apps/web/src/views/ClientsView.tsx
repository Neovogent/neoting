import { useMemo, useState } from 'react';
import {
  Search, Plus, Sparkles, Send, ExternalLink, Activity, LayoutGrid, Rows3,
  Star, Columns3, Download, Check, LucideIcon,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Modal } from '../components/DynamicComponents/Modal';
import { useScrollActiveIntoView } from '../lib/useScrollActiveIntoView';
import { defineMessages, useIntl, type IntlShape, type MessageDescriptor } from 'react-intl';
import { useAppContext } from '../context/AppContext';
import { commonActions, commonLabels } from '../i18n/common';
import { ClientIntakeForm } from '../components/DynamicComponents/ClientIntakeForm';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { currency } from '../lib/resolver';
import { healthTone, type ClientStats } from '../lib/selectors';
import type { Client, Intent } from '../lib/types';
import { useQueryParam } from '../lib/router';
import { ChaseModal } from '../components/DynamicComponents/ChaseModal';
import { EXPORT_HINT } from '../lib/exportRules';

/**
 * The tuple is identity, not copy: it types `Tab` and it is what
 * `tab === 'Starred'` compares against. The words on the buttons are a separate
 * lookup, so translating a tab cannot break the filter.
 */
const TABS = ['All', 'My clients', 'Starred'] as const;
type Tab = (typeof TABS)[number];

/** Descriptors, not text — a hook cannot be called at module scope. */
const TAB_LABEL: Record<Tab, MessageDescriptor> = defineMessages({
  All: { id: 'analytics.clientsView.tabAll', defaultMessage: 'All' },
  'My clients': { id: 'analytics.clientsView.tabMyClients', defaultMessage: 'My clients' },
  Starred: { id: 'analytics.clientsView.tabStarred', defaultMessage: 'Starred' },
});

/**
 * Column names are identity as well: `columns.includes('Integration')` is what
 * the picker toggles, and `countColumn` uses the same string as the column key.
 * So the tuple stays English and the words on screen come from `COLUMN_LABEL`.
 */
const OPTIONAL_COLUMNS = [
  'Health', 'To review', 'Ready', 'Missing', 'Requested',
  'Overdue', 'Unmatched', 'Statement gaps', 'Rejected', 'Approvals', 'Item delay',
  'Next deadline',
] as const;
type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

/**
 * What each column is called in the picker, and — for the drillable counts —
 * in the table header too. One column is headed differently from the way the
 * picker names it (`Health` → Pipeline health); that header is a separate
 * message on `m`.
 */
const COLUMN_LABEL: Record<OptionalColumn, MessageDescriptor> = defineMessages({
  Health: { id: 'analytics.clientsView.columnHealth', defaultMessage: 'Health' },
  'To review': { id: 'analytics.clientsView.columnToReview', defaultMessage: 'To review' },
  Ready: { id: 'analytics.clientsView.columnReady', defaultMessage: 'Ready' },
  Missing: { id: 'analytics.clientsView.columnMissing', defaultMessage: 'Missing' },
  Requested: { id: 'analytics.clientsView.columnRequested', defaultMessage: 'Requested' },
  Overdue: { id: 'analytics.clientsView.columnOverdue', defaultMessage: 'Overdue' },
  Unmatched: { id: 'analytics.clientsView.columnUnmatched', defaultMessage: 'Unmatched' },
  'Statement gaps': { id: 'analytics.clientsView.columnStatementGaps', defaultMessage: 'Statement gaps' },
  Rejected: { id: 'analytics.clientsView.columnRejected', defaultMessage: 'Rejected' },
  Approvals: { id: 'analytics.clientsView.columnApprovals', defaultMessage: 'Approvals' },
  'Item delay': { id: 'analytics.clientsView.columnItemDelay', defaultMessage: 'Item delay' },
  'Next deadline': { id: 'analytics.clientsView.columnNextDeadline', defaultMessage: 'Next deadline' },
});

const DEFAULT_COLUMNS = ['Health', 'To review', 'Missing', 'Requested', 'Rejected', 'Next deadline'];

const m = defineMessages({
  heading: { id: 'analytics.clientsView.heading', defaultMessage: 'Clients' },
  countOfTotal: { id: 'analytics.clientsView.countOfTotal', defaultMessage: '{shown} of {total}' },
  searchPlaceholder: {
    id: 'analytics.clientsView.searchPlaceholder',
    defaultMessage: 'Search clients...',
  },
  viewCards: { id: 'analytics.clientsView.viewCards', defaultMessage: 'Cards' },
  viewTable: { id: 'analytics.clientsView.viewTable', defaultMessage: 'Table' },
  chooseColumns: { id: 'analytics.clientsView.chooseColumns', defaultMessage: 'Choose columns' },
  columnsPickerHeading: { id: 'analytics.clientsView.columnsPickerHeading', defaultMessage: 'Columns' },
  addClient: { id: 'analytics.clientsView.addClient', defaultMessage: 'Add Client' },
  emptyFiltered: { id: 'analytics.clientsView.emptyFiltered', defaultMessage: 'No clients match this filter.' },

  // The two halves of a drill: what the user is shown to have asked, and the
  // agent's one-line answer above the table it opens.
  drillPrompt: { id: 'analytics.clientsView.drillPrompt', defaultMessage: '{action} for {clients}' },
  drillReply: { id: 'analytics.clientsView.drillReply', defaultMessage: 'Here you go:' },
  drillInbox: { id: 'analytics.clientsView.drillInbox', defaultMessage: 'Show the inbox' },
  drillReady: { id: 'analytics.clientsView.drillReady', defaultMessage: 'Show ready items' },
  drillMissing: { id: 'analytics.clientsView.drillMissing', defaultMessage: 'Show missing paperwork' },
  drillRequested: { id: 'analytics.clientsView.drillRequested', defaultMessage: 'Show requested paperwork' },
  drillOverdue: { id: 'analytics.clientsView.drillOverdue', defaultMessage: 'Show overdue chases' },
  drillMatches: { id: 'analytics.clientsView.drillMatches', defaultMessage: 'Show bank matches' },
  drillStatementGaps: { id: 'analytics.clientsView.drillStatementGaps', defaultMessage: 'Show statement gaps' },
  drillRejected: { id: 'analytics.clientsView.drillRejected', defaultMessage: 'Show rejected items' },
  drillApprovals: { id: 'analytics.clientsView.drillApprovals', defaultMessage: 'Show the approval queue' },

  columnPipelineHealth: {
    id: 'analytics.clientsView.columnPipelineHealth',
    defaultMessage: 'Pipeline health',
  },
  awaitingRegistration: {
    id: 'analytics.clientsView.awaitingRegistration',
    defaultMessage: 'Awaiting client registration',
  },
  percent: { id: 'analytics.clientsView.percent', defaultMessage: '{value}%' },
  days: { id: 'analytics.clientsView.days', defaultMessage: '{days}d' },

  bulkAskAi: { id: 'analytics.clientsView.bulkAskAi', defaultMessage: 'Ask AI' },
  bulkChase: { id: 'analytics.clientsView.bulkChase', defaultMessage: 'Chase selected' },
  tableFooter: {
    id: 'analytics.clientsView.tableFooter',
    defaultMessage: '{count, plural, one {# client} other {# clients}} • select rows for bulk actions',
  },
  chaseGroupedNote: {
    id: 'analytics.clientsView.chaseGroupedNote',
    defaultMessage: 'Grouped per client — one email each.',
  },
});

/**
 * ONE board, both worlds.
 *
 * This used to fork: `LiveClientsView` rendered a reduced table whenever the
 * businesses slice was live, because `BusinessSummary` carried a name and three
 * counts and every other column would have been invented. The endpoint now
 * carries the sector, the deadline and all ten counts, and `AppContext` maps
 * those rows into the same `Client` shape the seeded cast uses — so the reduced
 * table has nothing left to protect and the fork is gone. A live practice gets
 * the real board: cards or table, the tabs, the column picker, health, every
 * count column, and the bulk bar.
 *
 * The S12 rule still holds and is now enforced one level down rather than by
 * withholding the whole screen — see `statsFor` in `AppContext`, which answers
 * live rows from the server's counts instead of folding arrays that are empty
 * when the API is on.
 */
export function ClientsView() {
  const {
    clients, statsFor, openClient, starredClientIds, toggleStarClient, startConversation,
  } = useAppContext();

  const [tab, setTab] = useState<Tab>('All');
  const tabStripRef = useScrollActiveIntoView<HTMLDivElement>(tab);
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const [query, setQuery] = useState('');
  // ?add=1 — the intake modal is a link, so it can be sent to a colleague.
  const [addParam, setAddParam] = useQueryParam('add');
  const adding = addParam === '1';
  const setAdding = (open: boolean) => setAddParam(open ? '1' : null);
  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const [chasing, setChasing] = useState<string[] | null>(null);
  const intl = useIntl();

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

  const drill = (ids: string[], intent: Intent, action: string) => {
    const names = clients.filter((c) => ids.includes(c.id)).map((c) => c.name);
    startConversation(ids, [
      { id: `${Date.now()}-u`, role: 'user', content: intl.formatMessage(m.drillPrompt, { action, clients: names.join(', ') }) },
      { id: `${Date.now()}-a`, role: 'assistant', content: intl.formatMessage(m.drillReply), intent, payload: { clientIds: ids, clientNames: names } },
    ]);
  };

  const tableColumns: Column<Client>[] = [
    {
      key: 'name',
      label: intl.formatMessage(commonLabels.client),
      sortValue: (c) => c.name,
      render: (c) => (
        <span className="flex items-center gap-3">
          <button
            onClick={(e) => { e.stopPropagation(); toggleStarClient(c.id); }}
            className={starredClientIds.includes(c.id) ? 'text-brand' : 'text-zinc-700 hover:text-zinc-400'}
          >
            <Star size={14} fill={starredClientIds.includes(c.id) ? 'currentColor' : 'none'} />
          </button>
          <span>
            <span className="block text-white font-semibold">{c.name}</span>
            <span className="block text-[11px] text-zinc-500 font-medium">
              {/* Invite-path records have no industry until the client registers. */}
              {c.awaitingRegistration ? intl.formatMessage(m.awaitingRegistration) : c.industry}
            </span>
          </span>
        </span>
      ),
    },
    ...(columns.includes('Health')
      ? [{
          key: 'health', label: intl.formatMessage(m.columnPipelineHealth), align: 'right' as const, sortValue: (c: Client) => statsFor(c.id).health,
          render: (c: Client) => {
            const h = statsFor(c.id).health;
            return <Pill tone={healthTone(h)}>{intl.formatMessage(m.percent, { value: h })}</Pill>;
          },
        }]
      : []),
    ...countColumn(intl, 'To review', columns, (c) => statsFor(c.id).toReview, (ids) => drill(ids, 'SHOW_INBOX', intl.formatMessage(m.drillInbox))),
    ...countColumn(intl, 'Ready', columns, (c) => statsFor(c.id).ready, (ids) => drill(ids, 'SHOW_INBOX', intl.formatMessage(m.drillReady))),
    ...countColumn(intl, 'Missing', columns, (c) => statsFor(c.id).missing, (ids) => drill(ids, 'SHOW_MISSING_TABLE', intl.formatMessage(m.drillMissing)), 'red'),
    ...countColumn(intl, 'Requested', columns, (c) => statsFor(c.id).requested, (ids) => drill(ids, 'SHOW_MISSING_TABLE', intl.formatMessage(m.drillRequested))),
    ...countColumn(intl, 'Overdue', columns, (c) => statsFor(c.id).overdue, (ids) => drill(ids, 'SHOW_MISSING_TABLE', intl.formatMessage(m.drillOverdue)), 'red'),
    ...countColumn(intl, 'Unmatched', columns, (c) => statsFor(c.id).unmatched, (ids) => drill(ids, 'SHOW_MATCHES', intl.formatMessage(m.drillMatches)), 'red'),
    ...countColumn(intl, 'Statement gaps', columns, (c) => statsFor(c.id).statementGaps, (ids) => drill(ids, 'SHOW_MISSING_TABLE', intl.formatMessage(m.drillStatementGaps)), 'red'),
    ...countColumn(intl, 'Rejected', columns, (c) => statsFor(c.id).rejected, (ids) => drill(ids, 'SHOW_REJECTED', intl.formatMessage(m.drillRejected)), 'red'),
    ...countColumn(intl, 'Approvals', columns, (c) => statsFor(c.id).approvals, (ids) => drill(ids, 'SHOW_APPROVALS', intl.formatMessage(m.drillApprovals))),
    ...(columns.includes('Item delay')
      ? [{ key: 'delay', label: intl.formatMessage(COLUMN_LABEL['Item delay']), align: 'right' as const, sortValue: (c: Client) => statsFor(c.id).itemDelay, render: (c: Client) => <span className="tabular-nums text-zinc-400">{intl.formatMessage(m.days, { days: statsFor(c.id).itemDelay })}</span> }]
      : []),
    ...(columns.includes('Next deadline')
      ? [{ key: 'deadline', label: intl.formatMessage(COLUMN_LABEL['Next deadline']), align: 'right' as const, sortValue: (c: Client) => c.deadline, render: (c: Client) => <span className="text-zinc-400">{c.deadline}</span> }]
      : []),
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-hidden">
      <header data-tour="clients-header" className="px-4 md:px-10 pt-4 md:pt-8 pb-4 md:pb-5 flex items-center justify-between gap-4 shrink-0 flex-wrap">
        <div className="flex items-baseline gap-4">
          <h1 className="font-sans text-2xl md:text-3xl font-semibold text-white tracking-tight">{intl.formatMessage(m.heading)}</h1>
          <span className="text-sm font-semibold text-zinc-500">
            {intl.formatMessage(m.countOfTotal, { shown: visible.length, total: clients.length })}
          </span>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative w-full sm:w-auto">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={intl.formatMessage(m.searchPlaceholder)}
              className="w-full sm:w-64 bg-card border border-white/5 rounded-full py-2.5 pl-11 pr-4 text-sm focus:outline-none focus:ring-1 focus:ring-brand transition-all placeholder:text-zinc-600 text-white font-medium shadow-inner"
            />
          </div>

          <div className="flex items-center bg-card border border-white/5 rounded-full p-1 shadow-inner">
            <ViewToggle active={view === 'cards'} onClick={() => setView('cards')} icon={LayoutGrid} label={intl.formatMessage(m.viewCards)} />
            <ViewToggle active={view === 'table'} onClick={() => setView('table')} icon={Rows3} label={intl.formatMessage(m.viewTable)} />
          </div>

          {view === 'table' && (
            <div className="relative">
              <button
                onClick={() => setColumnPickerOpen((o) => !o)}
                className="p-2.5 text-zinc-400 hover:text-white hover:bg-white/5 rounded-full border border-white/5 transition-colors bg-card"
                title={intl.formatMessage(m.chooseColumns)}
              >
                <Columns3 size={16} />
              </button>
              <AnimatePresence>
                {columnPickerOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -8, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.97 }}
                    className="absolute right-0 top-full mt-2 w-56 bg-card border border-white/10 rounded-2xl shadow-2xl z-50 p-2 max-h-80 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                  >
                    <div className="px-3 py-2 text-[11px] font-bold text-zinc-500 uppercase tracking-widest">{intl.formatMessage(m.columnsPickerHeading)}</div>
                    {OPTIONAL_COLUMNS.map((col) => (
                      <button
                        key={col}
                        onClick={() => setColumns((prev) => (prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]))}
                        className="w-full px-3 py-2 rounded-xl flex items-center justify-between gap-2 text-[13px] text-zinc-300 hover:bg-white/5 transition-colors text-left"
                      >
                        {intl.formatMessage(COLUMN_LABEL[col])}
                        {columns.includes(col) && <Check size={14} strokeWidth={3} className="text-brand" />}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          <button
            data-tour="clients-add"
            onClick={() => setAdding(true)}
            className="flex items-center gap-2 px-6 py-2.5 bg-brand text-white text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-glow-btn-soft"
          >
            <Plus size={16} strokeWidth={2.5} />
            {intl.formatMessage(m.addClient)}
          </button>
        </div>
      </header>

      <div ref={tabStripRef} className="px-4 md:px-10 pb-5 flex items-center gap-2 shrink-0 scroll-x [&>button]:shrink-0 [&>button]:whitespace-nowrap">
        {TABS.map((t) => (
          <button
            key={t}
            aria-current={tab === t ? 'page' : undefined}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-full text-[13px] font-bold transition-all border ${
              tab === t
                ? 'bg-brand text-white border-brand shadow-glow-pill'
                : 'bg-card text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
            }`}
          >
            {intl.formatMessage(TAB_LABEL[t])}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-10 pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {visible.length === 0 ? (
          <div className="border border-white/5 rounded-[32px] bg-card p-4 md:p-10 text-center text-zinc-500">
            {intl.formatMessage(m.emptyFiltered)}
          </div>
        ) : view === 'cards' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {visible.map((client, i) => (
              <ClientCard
                key={client.id}
                {...(i === 0 ? { tourKey: 'client-card' } : {})}
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
              { label: intl.formatMessage(m.bulkAskAi), icon: Sparkles, onClick: (sel) => askAI(sel.map((c) => c.id)) },
              { label: intl.formatMessage(commonActions.exportCsv), icon: Download, minSelected: 2, disabledHint: intl.formatMessage(EXPORT_HINT), onClick: (sel) => exportClients(sel, statsFor) },
              { label: intl.formatMessage(m.bulkChase), icon: Send, primary: true, onClick: (sel) => chase(sel.map((c) => c.id)) },
            ]}
            footer={intl.formatMessage(m.tableFooter, { count: visible.length })}
          />
        )}
      </div>

      <AnimatePresence>
        {chasing && (
          <ChaseModal
            clientIds={chasing}
            {...(chasing.length > 1 ? { note: intl.formatMessage(m.chaseGroupedNote) } : {})}
            onClose={() => setChasing(null)}
          />
        )}
        {adding && (
          <Modal onClose={() => setAdding(false)} width="max-w-xl" label={intl.formatMessage(m.addClient)}>
            {/* Same intake component the chat renders — one service, two entry points. */}
            <ClientIntakeForm />
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

const mCount = defineMessages({
  drillTitle: { id: 'analytics.countColumn.drillTitle', defaultMessage: 'Open {column} for {client}' },
});

/**
 * A drillable count cell — clicking it opens the matching view in the workspace.
 *
 * Takes `intl` rather than calling `useIntl`: it is a plain function called from
 * the middle of a column list, so it cannot hold a hook. `label` stays the
 * English identity — it is the column key and what `enabled.includes` tests —
 * and the words come from `COLUMN_LABEL`.
 */
function countColumn(
  intl: IntlShape,
  label: OptionalColumn,
  enabled: string[],
  value: (c: Client) => number,
  onDrill: (ids: string[]) => void,
  tone: 'neutral' | 'red' = 'neutral',
): Column<Client>[] {
  if (!enabled.includes(label)) return [];
  const text = intl.formatMessage(COLUMN_LABEL[label]);
  return [
    {
      key: label,
      label: text,
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
            title={n > 0 ? intl.formatMessage(mCount.drillTitle, { column: text.toLowerCase(), client: c.name }) : undefined}
          >
            {n}
          </button>
        );
      },
    },
  ];
}

function ViewToggle({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: LucideIcon; label: string }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`px-3.5 py-1.5 rounded-full flex items-center gap-2 text-[13px] font-bold transition-all ${
        active ? 'bg-brand text-white' : 'text-zinc-500 hover:text-white'
      }`}
    >
      <Icon size={15} />
      {label}
    </button>
  );
}

const mCard = defineMessages({
  star: { id: 'analytics.clientCard.star', defaultMessage: 'Star' },
  unstar: { id: 'analytics.clientCard.unstar', defaultMessage: 'Unstar' },
  pipelineHealth: { id: 'analytics.clientCard.pipelineHealth', defaultMessage: 'Pipeline Health' },
  healthPercent: { id: 'analytics.clientCard.healthPercent', defaultMessage: '{value}%' },
  statMissing: { id: 'analytics.clientCard.statMissing', defaultMessage: 'Missing' },
  statToReview: { id: 'analytics.clientCard.statToReview', defaultMessage: 'To Review' },
  // Two whole messages rather than one with an optional tail: word order around
  // an inserted clause is exactly what differs between languages.
  requested: { id: 'analytics.clientCard.requested', defaultMessage: '{count} already requested' },
  requestedWithOverdue: {
    id: 'analytics.clientCard.requestedWithOverdue',
    defaultMessage: '{count} already requested • {overdue} overdue',
  },
  next: { id: 'analytics.clientCard.next', defaultMessage: 'Next:' },
  openClient: { id: 'analytics.clientCard.openClient', defaultMessage: 'Open client' },
  askAi: { id: 'analytics.clientCard.askAi', defaultMessage: 'Ask AI about this client' },
  chaseMissing: { id: 'analytics.clientCard.chaseMissing', defaultMessage: 'Chase missing documents' },
});

function ClientCard({
  client, starred, onStar, onOpen, onAskAI, onChase, tourKey,
}: {
  client: Client;
  /** Set on the first card only, so the tour has one place to point. */
  tourKey?: string;
  starred: boolean;
  onStar: () => void;
  onOpen: () => void;
  onAskAI: () => void;
  onChase: () => void;
}) {
  const { statsFor } = useAppContext();
  const intl = useIntl();
  const s = statsFor(client.id);

  return (
    <div data-tour={tourKey} className="border border-white/5 rounded-[32px] bg-card p-6 flex flex-col justify-between shadow-2xl group hover:border-white/10 transition-all hover:-translate-y-1 relative overflow-hidden">
      <div className="flex justify-between items-start mb-6">
        <button
          onClick={onOpen}
          className="w-14 h-14 rounded-2xl bg-raised flex items-center justify-center font-sans text-2xl font-bold text-white border border-white/5 shadow-inner hover:border-white/20 transition-colors"
        >
          {client.name.charAt(0)}
        </button>
        <div className="flex gap-2 items-center">
          <button
            onClick={onStar}
            className={`w-8 h-8 rounded-full flex items-center justify-center border transition-colors ${
              starred ? 'bg-brand/10 text-brand border-brand/20' : 'text-zinc-600 border-white/5 hover:text-white'
            }`}
            title={intl.formatMessage(starred ? mCard.unstar : mCard.star)}
          >
            <Star size={14} fill={starred ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>

      <div className="flex-1">
        <button onClick={onOpen} className="text-left w-full">
          <h3 className="font-sans text-xl font-bold text-white leading-tight mb-1 truncate hover:text-brand transition-colors">
            {client.name}
          </h3>
        </button>
        <p className="text-[11px] text-zinc-500 font-bold uppercase tracking-widest mb-6">{client.industry}</p>

        <div className="mb-6">
          <div className="flex justify-between items-end mb-2">
            <span className="text-[11px] font-bold text-zinc-500 flex items-center gap-1.5 tracking-wide uppercase">
              <Activity size={12} className="text-brand" />
              {intl.formatMessage(mCard.pipelineHealth)}
            </span>
            <span className="text-xs font-bold text-white">{intl.formatMessage(mCard.healthPercent, { value: s.health })}</span>
          </div>
          <div className="h-2 w-full bg-raised rounded-full overflow-hidden shadow-inner">
            <motion.div
              layout
              className={`h-full rounded-full ${s.health > 80 ? 'bg-brand' : s.health > 50 ? 'bg-amber-400' : 'bg-red-500'}`}
              style={{ width: `${s.health}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="bg-raised p-4 rounded-2xl border border-white/5 text-center shadow-inner">
            <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">{intl.formatMessage(mCard.statMissing)}</div>
            <div className={`text-2xl font-sans font-bold ${s.missing > 20 ? 'text-red-400' : 'text-white'}`}>{s.missing}</div>
          </div>
          <div className="bg-raised p-4 rounded-2xl border border-white/5 text-center shadow-inner">
            <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">{intl.formatMessage(mCard.statToReview)}</div>
            <div className="text-2xl font-sans font-bold text-white">{s.toReview}</div>
          </div>
        </div>

        {s.requested > 0 && (
          <div className="text-[11px] font-bold text-zinc-500 mb-3 text-center uppercase tracking-wider">
            {intl.formatMessage(s.overdue > 0 ? mCard.requestedWithOverdue : mCard.requested, {
              count: s.requested,
              overdue: s.overdue,
            })}
          </div>
        )}

        <div className="text-[12px] font-semibold text-zinc-500 flex items-center justify-center gap-2 bg-ground/50 py-2 rounded-xl">
          <span className="w-2 h-2 rounded-full bg-brand animate-pulse" />
          {intl.formatMessage(mCard.next)} <span className="text-white">{client.deadline}</span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-6">
        <button onClick={onOpen} className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-2xl text-zinc-400 hover:bg-raised hover:text-white transition-colors" title={intl.formatMessage(mCard.openClient)}>
          <ExternalLink size={18} />
        </button>
        <button onClick={onAskAI} className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-2xl text-brand bg-brand/10 hover:bg-brand/20 transition-colors border border-brand/10" title={intl.formatMessage(mCard.askAi)}>
          <Sparkles size={18} />
        </button>
        <button onClick={onChase} className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-2xl text-zinc-400 hover:bg-raised hover:text-white transition-colors disabled:opacity-30" title={intl.formatMessage(mCard.chaseMissing)} disabled={s.missing === 0}>
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}

function exportClients(rows: Client[], statsFor: (id: string) => ClientStats) {
  const header = 'Client,Industry,Health,To review,Ready,Missing,Requested,Rejected,Approvals,Unverified,Next deadline\n';
  const body = rows
    .map((c) => {
      const s = statsFor(c.id);
      return `"${c.name}","${c.industry}",${s.health},${s.toReview},${s.ready},${s.missing},${s.requested},${s.rejected},${s.approvals},"${currency(s.unverified)}","${c.deadline}"`;
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

