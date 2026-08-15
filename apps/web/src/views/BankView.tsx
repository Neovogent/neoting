import { useMemo, useRef, useState } from 'react';
import {
  Landmark, Search, Link2, Unlink, Send, UploadCloud, SlidersHorizontal,
  AlertTriangle, RefreshCw, X, Check, FileText, Wand2, Download, Eye, Plus,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppContext } from '../context/AppContext';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { SubTabs } from '../components/DynamicComponents/SubTabs';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { fromSlug, slug, useQueryParam, useSegment } from '../lib/router';
import { StatementModal, downloadBank } from '../components/DynamicComponents/StatementModal';
import { ChaseModal } from '../components/DynamicComponents/ChaseModal';
import { currency } from '../lib/resolver';
import { assessTransaction, txnLabel, type Candidate, type MatchVerdict } from '../lib/matching';
import { DocumentPreview } from '../components/DynamicComponents/DocumentPreview';
import type { BankAccount, BankTransaction, Document, Match, Statement, StatementGap } from '../lib/types';
import { EXPORT_HINT } from '../lib/exportRules';

const TABS = ['Transactions', 'Matches', 'Statements', 'Accounts'] as const;
type Tab = (typeof TABS)[number];

const CASH_CODE_CATEGORIES = ['Office Supplies', 'Cost of Sales Food', 'Software', 'Travel', 'Utilities', 'Marketing', '—'];

/**
 * The bank surface. There is no practice-wide Bank any more — bank data is
 * always one client's, so this renders inside a client's Bank tab with
 * `clientId` pinned. Everything the standalone view could do is still here:
 * matching, cash coding, match rules, statement upload and gap detection.
 */
export function BankView({ clientId }: { clientId?: string } = {}) {
  const {
    clients, transactions, matches, documents, accounts, statements, statementGaps,
    matchSettings, setMatchSettings, matchTransaction, unmatchTransaction, cashCode,
    uploadStatement, reauthAccount, logAudit, statsFor,
  } = useAppContext();

  /**
   * Embedded in a client the sub-tab is the fourth path segment, so it is
   * linkable; standalone there is no client in the address to hang it off, so
   * it stays local state.
   */
  const [tabSlug, setTabSlug] = useSegment(3);
  const [localTab, setLocalTab] = useState<Tab>('Transactions');
  const tab: Tab = clientId ? fromSlug(tabSlug, TABS) ?? 'Transactions' : localTab;
  const setTab = (next: Tab) => (clientId ? setTabSlug(slug(next)) : setLocalTab(next));
  // Pinned when embedded in a client, so no filter can widen the scope.
  const clientFilter = clientId ?? 'all';
  const scopedToClient = clientId !== undefined;
  const [evidenceFilter, setEvidenceFilter] = useState<'all' | 'needs-you' | 'unmatched' | 'matched' | 'credits'>('all');
  const [query, setQuery] = useState('');
  const [matchFor, setMatchFor] = useState<BankTransaction | null>(null);
  const [previewDoc, setPreviewDoc] = useState<Document | null>(null);
  const [cashFor, setCashFor] = useState<BankTransaction | null>(null);
  // Accountant-defined cash-code categories — added once, offered for every transaction after.
  const [customCategories, setCustomCategories] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const [chasing, setChasing] = useState<string[] | null>(null);
  const confirm = useConfirm();
  // ?statement=<id> — linkable like every other overlay.
  const [viewingStatement, setViewingStatement] = useQueryParam('statement');
  const openStatement = statements.find((st) => st.id === viewingStatement) ?? null;
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * The matcher's own read on a transaction. Memoised per render pass because
   * the table asks for it in both the Evidence and the action column.
   */
  const verdicts = useMemo(() => {
    const map = new Map<string, MatchVerdict>();
    for (const t of transactions) {
      if (t.matchedDocId) continue;
      map.set(t.id, assessTransaction(t, documents, matchSettings));
    }
    return map;
  }, [transactions, documents, matchSettings]);

  const verdictFor = (t: BankTransaction): MatchVerdict =>
    verdicts.get(t.id) ?? { kind: 'none', candidates: [], reason: '' };

  const scopedTxns = useMemo(() => {
    const q = query.trim().toLowerCase();
    return transactions.filter((t) => {
      if (clientFilter !== 'all' && t.clientId !== clientFilter) return false;
      if (evidenceFilter === 'needs-you' && (t.matchedDocId || verdicts.get(t.id)?.kind !== 'confused')) return false;
      if (evidenceFilter === 'unmatched' && t.matchedDocId) return false;
      if (evidenceFilter === 'matched' && !t.matchedDocId) return false;
      if (evidenceFilter === 'credits' && !t.isCredit) return false;
      if (q && !`${t.description} ${t.clientName} ${t.amount}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [transactions, clientFilter, evidenceFilter, query, verdicts]);

  const scopedMatches = matches.filter(
    (m) => clientFilter === 'all' || clients.find((c) => c.id === clientFilter)?.name === m.clientName,
  );
  const scopedStatements = statements.filter((s) => clientFilter === 'all' || s.clientId === clientFilter);
  const scopedGaps = statementGaps.filter((g) => clientFilter === 'all' || g.clientId === clientFilter);
  const scopedAccounts = accounts.filter((a) => clientFilter === 'all' || a.clientId === clientFilter);

  const unmatchedCount = scopedTxns.filter((t) => !t.matchedDocId).length;
  const unexplained = scopedTxns.filter((t) => !t.matchedDocId).reduce((n, t) => n + Math.abs(t.amount), 0);

  // Counted across the client scope rather than the current filter, so the tab
  // does not read "Needs you (0)" while it is the tab you are looking at.
  const needsYouCount = useMemo(
    () =>
      transactions.filter(
        (t) =>
          (clientFilter === 'all' || t.clientId === clientFilter) &&
          !t.matchedDocId &&
          verdicts.get(t.id)?.kind === 'confused',
      ).length,
    [transactions, clientFilter, verdicts],
  );

  /** Composed here — the transaction is already chosen. */
  const chase = (ids: string[]) => setChasing(ids);

  const txnColumns: Column<BankTransaction>[] = [
    {
      key: 'description', label: 'Description', sortValue: (t) => t.description,
      render: (t) => (
        <span>
          <span className="block text-white font-semibold">{t.description}</span>
          <span className="block text-[11px] text-zinc-500 font-medium">
            {accounts.find((a) => a.id === t.accountId)?.bankName ?? 'Account'} ••{accounts.find((a) => a.id === t.accountId)?.last4 ?? '----'}
          </span>
        </span>
      ),
    },
    { key: 'clientName', label: 'Client', sortValue: (t) => t.clientName },
    { key: 'date', label: 'Date', sortValue: (t) => t.date },
    {
      key: 'evidence', label: 'Evidence', sortValue: (t) => (t.matchedDocId ? 1 : 0),
      render: (t) => {
        if (t.matchedDocId) {
          const m = matches.find((x) => x.transactionId === t.id);
          return <Pill tone="green">{m?.auto ? 'Matched by AI' : 'Matched'}</Pill>;
        }
        const v = verdictFor(t);
        if (v.kind === 'confused') {
          return <Pill tone="amber">Needs you — {v.candidates.length} candidate{v.candidates.length === 1 ? '' : 's'}</Pill>;
        }
        return t.isCredit ? <Pill tone="blue">Credit — no document</Pill> : <Pill tone="red">No document</Pill>;
      },
    },
    {
      key: 'amount', label: 'Amount', align: 'right', sortValue: (t) => t.amount,
      render: (t) => <span className={`font-bold tabular-nums ${t.amount < 0 ? 'text-emerald-400' : 'text-white'}`}>{currency(t.amount)}</span>,
    },
    {
      key: 'actions', label: '', align: 'right',
      render: (t) => {
        if (t.matchedDocId) {
          return (
            <button
              onClick={async (e) => {
                e.stopPropagation();
                const m = matches.find((x) => x.transactionId === t.id);
                if (!m) return;
                const ok = await confirm({
                  tone: 'red',
                  title: 'Break this match?',
                  detail: `${m.documentLabel} and ${m.transactionLabel}.`,
                  consequence: 'The transaction goes back to having no evidence, which makes it a missing item again.',
                  confirmLabel: 'Yes, unmatch',
                });
                if (!ok) return;
                unmatchTransaction(m.id);
                logAudit({ action: 'Unmatched document from transaction', scope: txnLabel(t), reviewOpened: true });
              }}
              className="px-3 py-1.5 rounded-full text-[12px] font-bold text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5 transition-colors"
            >
              Unmatch
            </button>
          );
        }

        // Match is offered only where the matcher is genuinely torn. With no
        // candidate at all there is nothing to choose between, so the only
        // honest routes are cash coding or chasing the client.
        const v = verdictFor(t);
        return (
          <span className="flex items-center gap-2 justify-end">
            {v.kind === 'confused' && (
              <button
                onClick={(e) => { e.stopPropagation(); setMatchFor(t); }}
                className="px-3 py-1.5 rounded-full text-[12px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors"
              >
                Match
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); setCashFor(t); }}
              className="px-3 py-1.5 rounded-full text-[12px] font-bold text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5 transition-colors"
            >
              Cash code
            </button>
          </span>
        );
      },
    },
  ];

  return (
    <div className={scopedToClient
      ? 'flex flex-col min-w-0'
      : 'flex-1 flex flex-col min-w-0 bg-[#0a0a0c] h-full overflow-hidden'}>
      <header className={scopedToClient ? 'pb-5 shrink-0' : 'px-10 pt-8 pb-5 shrink-0'}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          {/* The client page already names the client, so the embedded copy
              leads with the number that decides whether you act. */}
          {scopedToClient ? (
            <p className="text-[12px] text-zinc-500 font-semibold uppercase tracking-wider self-center">
              {unmatchedCount} unexplained · {currency(unexplained)} without evidence
            </p>
          ) : (
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-[#202026] flex items-center justify-center text-white border border-white/5 shadow-inner">
                <Landmark size={22} />
              </div>
              <div>
                <h1 className="font-sans text-3xl font-semibold text-white tracking-tight">Bank</h1>
                <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                  {unmatchedCount} unexplained · {currency(unexplained)} without evidence
                </p>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => setSettingsOpen(true)}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-zinc-300 bg-[#16161a] border border-white/10 rounded-full hover:bg-white/5 transition-all shadow-lg"
            >
              <SlidersHorizontal size={16} />
              Match rules
            </button>
            <button
              onClick={() => { setUploadFor(clientFilter === 'all' ? clients[0]?.id ?? null : clientFilter); fileRef.current?.click(); }}
              className="flex items-center gap-2 px-6 py-2.5 text-sm font-bold text-white bg-[#14e3c4] rounded-full hover:bg-[#0fcbaf] transition-all shadow-[0_0_15px_rgba(20,227,196,0.2)]"
            >
              <UploadCloud size={16} />
              Upload statement
            </button>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept=".pdf,.tiff,.csv,.xlsx"
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Resolve the target client at handling time so the upload can
                // never silently do nothing.
                const targetId = uploadFor ?? (clientFilter === 'all' ? clients[0]?.id : clientFilter);
                if (f && targetId) {
                  uploadStatement(f.name, targetId);
                  logAudit({
                    action: 'Uploaded bank statement',
                    scope: `${f.name} — ${clients.find((c) => c.id === targetId)?.name}`,
                    reviewOpened: true,
                  });
                  setTab('Statements');
                }
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </header>

      {/* Inside a client these sit directly under the client tab rail, so they
          take the recessed segmented treatment to keep the two levels apart.
          Standalone, the page has no rail above them and pills read fine. */}
      <div className={`${scopedToClient ? '' : 'px-10'} pb-5 shrink-0`}>
        {scopedToClient ? (
          <SubTabs
            tabs={TABS.map((t) => ({
              key: t,
              label: t,
              // A count only exists on Matches, and SubTab asks for the key to
              // be absent rather than present and undefined.
              ...(t === 'Matches' ? { count: scopedMatches.length } : {}),
              alert: t === 'Statements' && scopedGaps.length > 0,
              badge:
                t === 'Statements' && scopedGaps.length > 0 ? (
                  <span className="text-[11px] font-bold text-amber-400">
                    {scopedGaps.length} gap{scopedGaps.length === 1 ? '' : 's'}
                  </span>
                ) : undefined,
            }))}
            active={tab}
            onChange={(k) => setTab(k as Tab)}
          />
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
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
                {t === 'Matches' && scopedMatches.length > 0 && <span className="ml-2 opacity-60">{scopedMatches.length}</span>}
                {t === 'Statements' && scopedGaps.length > 0 && (
                  <span className="ml-2 text-amber-400">
                    {scopedGaps.length} gap{scopedGaps.length === 1 ? '' : 's'}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={scopedToClient
        ? ''
        : 'flex-1 overflow-y-auto px-10 pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'}>
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {tab === 'Transactions' && (
            <>
              <div className="flex items-center gap-3 mb-5 flex-wrap">
                <div className="relative">
                  <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search transactions..."
                    className="w-64 bg-[#16161a] border border-white/5 rounded-full py-2.5 pl-11 pr-4 text-sm focus:outline-none focus:border-[#14e3c4] placeholder:text-zinc-600 text-white font-medium shadow-inner"
                  />
                </div>
                {(['all', 'needs-you', 'unmatched', 'matched', 'credits'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setEvidenceFilter(f)}
                    className={`px-4 py-2 rounded-full text-[13px] font-bold transition-all border ${
                      f === 'needs-you' ? '' : 'capitalize'
                    } ${
                      evidenceFilter === f
                        ? 'bg-[#14e3c4] text-white border-[#14e3c4]'
                        : 'bg-[#16161a] text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
                    }`}
                  >
                    {f === 'credits' ? 'Credit notes' : f === 'needs-you' ? `Needs you (${needsYouCount})` : f}
                  </button>
                ))}
              </div>

              <DataTable<BankTransaction>
                className="max-w-none"
                columns={txnColumns}
                rows={scopedTxns}
                rowId={(t) => t.id}
                selectable
                emptyMessage="No transactions — connect a feed or upload a statement."
                bulkActions={[
                  {
                    label: 'Chase for evidence',
                    icon: Send,
                    primary: true,
                    onClick: (sel) => chase([...new Set(sel.filter((t) => !t.matchedDocId).map((t) => t.clientId))]),
                  },
                  { label: 'Export CSV', icon: Download, minSelected: 2, disabledHint: EXPORT_HINT, onClick: (sel) => exportTxns(sel) },
                ]}
                footer={`${scopedTxns.length} transactions • ${unmatchedCount} without evidence`}
              />
            </>
          )}

          {/* A responsive grid rather than a table: a match is a pair of
              facing labels, which reads badly in columns that have to scroll
              sideways once this sits inside a client tab. One up on a phone,
              two on a laptop, three on a wide screen. */}
          {tab === 'Matches' && (
            scopedMatches.length === 0 ? (
              <div className="border border-white/5 rounded-[32px] bg-[#16161a] p-10 text-center text-zinc-500 text-[13px] shadow-2xl">
                No matches yet. Match a transaction from the Transactions tab.
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">
                {scopedMatches.map((m: Match) => (
                  <div
                    key={m.id}
                    className="border border-white/5 rounded-[24px] bg-[#16161a] shadow-2xl overflow-hidden flex flex-col"
                  >
                    <div className="p-5 flex items-center justify-between gap-3 flex-wrap border-b border-white/5">
                      <span className="inline-flex items-center gap-2">
                        {m.kind === 'exact' ? <Pill tone="green">Exact</Pill>
                          : m.kind === 'credit-note' ? <Pill tone="blue">Credit note</Pill>
                          : m.kind === 'partial' ? <Pill tone="blue">Batch payment</Pill>
                          : <Pill tone="amber">Probable</Pill>}
                        {/* Who made the call — the matcher, or a person. */}
                        <Pill>{m.auto ? 'AI' : 'You'}</Pill>
                      </span>
                      <span className="inline-flex items-center gap-2 shrink-0">
                        <span className="w-14 h-1.5 rounded-full bg-white/5 overflow-hidden">
                          <span
                            className={`block h-full rounded-full ${m.kind === 'probable' ? 'bg-amber-400' : 'bg-[#14e3c4]'}`}
                            style={{ width: `${Math.round(m.confidence * 100)}%` }}
                          />
                        </span>
                        <span className="tabular-nums text-zinc-400 text-[12px] font-bold">
                          {Math.round(m.confidence * 100)}%
                        </span>
                      </span>
                    </div>

                    <div className="p-5 flex flex-col gap-3 flex-1">
                      <div>
                        <div className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest mb-1">Document</div>
                        <div className="text-[13px] text-white font-semibold leading-snug">{m.documentLabel}</div>
                      </div>
                      <div>
                        <div className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest mb-1">Transaction</div>
                        <div className="text-[13px] text-zinc-400 leading-snug">{m.transactionLabel}</div>
                      </div>
                      {m.reason && <p className="text-[12px] text-zinc-500 leading-relaxed">{m.reason}</p>}
                    </div>

                    <div className="p-4 bg-[#202026]/50 flex items-center justify-between gap-3">
                      <span className="text-[13px] font-bold text-white tabular-nums">{currency(Math.abs(m.amount))}</span>
                      <button
                        onClick={async () => {
                          const ok = await confirm({
                            tone: 'red',
                            title: 'Break this match?',
                            detail: `${m.documentLabel} and ${m.transactionLabel}.`,
                            consequence: 'The transaction goes back to having no evidence, which makes it a missing item again.',
                            confirmLabel: 'Yes, unmatch',
                          });
                          if (!ok) return;
                          unmatchTransaction(m.id);
                          logAudit({ action: 'Unmatched document from transaction', scope: m.documentLabel, reviewOpened: true });
                        }}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-bold text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5 transition-colors"
                      >
                        <Unlink size={12} />
                        Unmatch
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}

          {tab === 'Statements' && (
            <div className="flex flex-col gap-6">
              {scopedGaps.length > 0 && (
                <div className="border border-amber-500/20 rounded-[32px] bg-amber-500/[0.06] overflow-hidden">
                  <div className="p-6 pb-4 flex items-center gap-3 border-b border-amber-500/15">
                    <AlertTriangle size={18} className="text-amber-400" />
                    <div>
                      <h3 className="font-sans font-bold text-lg text-white tracking-tight">
                        {scopedGaps.length} statement gap{scopedGaps.length === 1 ? '' : 's'}
                      </h3>
                      <p className="text-[12px] text-amber-200/70 font-semibold">
                        Detected from opening/closing balances and date continuity
                      </p>
                    </div>
                  </div>
                  <div className="divide-y divide-amber-500/10">
                    {scopedGaps.map((g: StatementGap) => (
                      <div key={g.id} className="px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
                        <div>
                          <div className="text-sm font-bold text-white">
                            {g.clientName} — {g.periodStart} to {g.periodEnd}
                          </div>
                          <div className="text-[12px] text-amber-200/70 mt-0.5">{g.reason}</div>
                        </div>
                        <button
                          onClick={() => chase([g.clientId])}
                          className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors shrink-0"
                        >
                          <Send size={14} />
                          Request statement
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <DataTable
                className="max-w-none"
                title="Statements"
                subtitle="PDF / TIFF up to 50MB, 300 pages · CSV and XLSX also accepted"
                columns={[
                  { key: 'fileName', label: 'File', render: (s) => <span className="text-white font-semibold">{s.fileName}</span> },
                  { key: 'clientName', label: 'Client', sortValue: (s) => s.clientName },
                  { key: 'period', label: 'Period', sortValue: (s) => s.period },
                  { key: 'rows', label: 'Rows', align: 'right', sortValue: (s) => s.rows, render: (s) => <span className="tabular-nums text-zinc-400">{s.rows || '—'}</span> },
                  {
                    key: 'balances', label: 'Opening → Closing', align: 'right',
                    render: (s: Statement) => s.status === 'extracted'
                      ? <span className="tabular-nums text-zinc-400">{currency(s.openingBalance)} → <span className="text-white font-bold">{currency(s.closingBalance)}</span></span>
                      : <span className="text-zinc-600">—</span>,
                  },
                  {
                    key: 'status', label: 'Status', sortValue: (s) => s.status,
                    render: (s: Statement) =>
                      s.status === 'extracted' ? <Pill tone="green">Extracted</Pill>
                        : s.status === 'processing' ? <Pill>Extracting…</Pill>
                        : <Pill tone="red">{s.note ?? 'Failed'}</Pill>,
                  },
                  {
                    // Every upload can be opened and taken away — a statement
                    // nobody can look at is just a filename in a list.
                    key: 'actions', label: '', align: 'right',
                    render: (s: Statement) => (
                      <span className="flex items-center justify-end gap-1.5">
                        <StatementButton icon={Eye} title="See what was read off this statement" onClick={() => setViewingStatement(s.id)} />
                        <StatementButton icon={Download} title="Download the extracted data as CSV" onClick={() => downloadBank(s)} />
                      </span>
                    ),
                  },
                ]}
                rows={scopedStatements}
                rowId={(s) => s.id}
                emptyMessage="No statements uploaded."
              />
            </div>
          )}

          {tab === 'Accounts' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {scopedAccounts.map((a: BankAccount) => (
                <div key={a.id} className="border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
                  <div className="p-6 flex items-start justify-between gap-4 border-b border-white/5">
                    <div>
                      <h3 className="font-sans font-bold text-xl text-white tracking-tight">{a.bankName}</h3>
                      <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                        {a.clientName} · {a.sortCode} · ••{a.last4}
                      </p>
                    </div>
                    {a.status === 'live' ? <Pill tone="green">Feed live</Pill>
                      : a.status === 'error' ? <Pill tone="red">Credential error</Pill>
                      : <Pill tone="amber">Statements only</Pill>}
                  </div>
                  <div className="p-6 flex flex-col gap-2.5 text-[13px]">
                    <Row label="Balance" value={currency(a.balance)} />
                    <Row label="Last sync" value={a.lastSync} />
                    <Row label="Source" value={a.source === 'feed' ? 'Plaid open-banking feed' : 'Statement upload fallback'} />
                    {a.status !== 'disconnected' && (
                      <div className="mt-2">
                        <div className="flex justify-between items-center text-[12px] mb-1.5">
                          <span className="text-zinc-500 font-medium">Consent expires in</span>
                          <span className={`font-bold ${a.reauthDays < 14 ? 'text-red-400' : 'text-white'}`}>{a.reauthDays} days</span>
                        </div>
                        <div className="h-1.5 w-full bg-[#202026] rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${a.reauthDays < 14 ? 'bg-red-500' : 'bg-[#14e3c4]'}`}
                            style={{ width: `${Math.min(100, (a.reauthDays / 90) * 100)}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="p-4 bg-[#202026]/50 flex items-center gap-3 flex-wrap">
                    <button
                      onClick={() => { reauthAccount(a.id); logAudit({ action: 'Re-authorised bank connection', scope: `${a.bankName} ••${a.last4}`, reviewOpened: true }); }}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors"
                    >
                      <RefreshCw size={15} />
                      {a.status === 'disconnected' ? 'Connect feed' : 'Re-authorise'}
                    </button>
                    <button
                      onClick={() => { setUploadFor(a.clientId); fileRef.current?.click(); }}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5 transition-colors"
                    >
                      <FileText size={15} />
                      Upload statement
                    </button>
                    <span className="ml-auto text-[12px] text-zinc-600 font-semibold">
                      {statsFor(a.clientId).unmatched} unexplained
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      </div>

      {/* Match picker */}
      <AnimatePresence>
        {matchFor && (
          <Modal onClose={() => setMatchFor(null)}>
            <MatchPicker
              txn={matchFor}
              verdict={verdictFor(matchFor)}
              onPreview={(d) => setPreviewDoc(d)}
              onMatch={(c) => {
                matchTransaction(matchFor.id, c.document.id, c.kind, c.confidence, c.reason);
                logAudit({ action: 'Matched document to transaction', scope: `${c.document.supplier} ↔ ${matchFor.description}`, reviewOpened: true });
                setMatchFor(null);
              }}
              onCashCode={() => { setCashFor(matchFor); setMatchFor(null); }}
              onChase={() => { chase([matchFor.clientId]); setMatchFor(null); }}
            />
          </Modal>
        )}
      </AnimatePresence>

      {/* Candidate preview — stacks above the picker so closing it returns you
          to the same shortlist rather than losing your place. */}
      <AnimatePresence>
        {chasing && (
          <ChaseModal
            clientIds={chasing}
            note="The bank shows spend with no document — this asks for it."
            onClose={() => setChasing(null)}
          />
        )}
        {openStatement && (
          <StatementModal
            statement={{ kind: 'bank', data: openStatement }}
            onClose={() => setViewingStatement(null)}
          />
        )}
        {previewDoc && (
          <Modal onClose={() => setPreviewDoc(null)}>
            <DocumentPreview document={documents.find((d) => d.id === previewDoc.id) ?? previewDoc} />
          </Modal>
        )}
      </AnimatePresence>

      {/* Cash coding */}
      <AnimatePresence>
        {cashFor && (
          <Modal onClose={() => setCashFor(null)}>
            <CashCodePanel
              txn={cashFor}
              customCategories={customCategories}
              onAddCategory={(name) => setCustomCategories((prev) => [...prev, name])}
              onConfirm={(category) => {
                cashCode(cashFor.id, category);
                logAudit({ action: 'Cash coded transaction', scope: `${cashFor.description} → ${category}`, reviewOpened: true });
                setCashFor(null);
              }}
            />
          </Modal>
        )}
      </AnimatePresence>

      {/* Match settings */}
      <AnimatePresence>
        {settingsOpen && (
          <Modal onClose={() => setSettingsOpen(false)}>
            <div className="w-full max-w-md border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
              <div className="p-6 border-b border-white/5">
                <h3 className="font-sans font-bold text-xl text-white tracking-tight">Match rules</h3>
                <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                  Configurable — Dext's windows are fixed
                </p>
              </div>
              <div className="p-6 flex flex-col gap-5">
                <NumberField label="Days after document date" value={matchSettings.documentWindow} onChange={(v) => setMatchSettings({ ...matchSettings, documentWindow: v })} />
                <NumberField label="Days around due date" value={matchSettings.dueWindow} onChange={(v) => setMatchSettings({ ...matchSettings, dueWindow: v })} />
                <NumberField label="Lookback (months)" value={matchSettings.lookbackMonths} onChange={(v) => setMatchSettings({ ...matchSettings, lookbackMonths: v })} />
                <button
                  onClick={() => setMatchSettings({ ...matchSettings, allowProbable: !matchSettings.allowProbable })}
                  className="flex items-center justify-between gap-4 p-4 rounded-2xl border border-white/5 bg-[#0a0a0c]/60 hover:border-white/15 transition-colors text-left"
                >
                  <div>
                    <div className="text-sm font-bold text-white">Suggest probable matches</div>
                    <div className="text-[12px] text-zinc-500 mt-0.5">Always shown as visually distinct from exact matches.</div>
                  </div>
                  <span className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${matchSettings.allowProbable ? 'bg-[#14e3c4]' : 'bg-white/10'}`}>
                    <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${matchSettings.allowProbable ? 'left-6' : 'left-1'}`} />
                  </span>
                </button>
              </div>
              <div className="p-4 bg-[#202026]/50 flex justify-end">
                <button onClick={() => setSettingsOpen(false)} className="px-6 py-2.5 text-sm font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] rounded-full transition-all">
                  Done
                </button>
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Only ever opened for a transaction the matcher could not call. It leads with
 * why it is stuck, then lists the documents it was torn between — each one
 * previewable, because choosing between two near-identical invoices means
 * actually looking at them.
 */
function MatchPicker({ txn, verdict, onMatch, onPreview, onCashCode, onChase }: {
  txn: BankTransaction;
  verdict: MatchVerdict;
  onMatch: (c: Candidate) => void;
  onPreview: (d: Document) => void;
  onCashCode: () => void;
  onChase: () => void;
}) {
  const { candidates } = verdict;

  return (
    <div className="w-full max-w-2xl border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
      <div className="p-6 border-b border-white/5 flex items-center gap-4">
        <div className="w-12 h-12 rounded-2xl bg-[#202026] flex items-center justify-center text-white border border-white/5 shadow-inner shrink-0">
          <Link2 size={20} />
        </div>
        <div className="min-w-0">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">{txn.description}</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            {txn.clientName} · {txn.date} · {currency(txn.amount)}
          </p>
        </div>
      </div>

      <div className="p-6">
        <div className="flex items-start gap-3 p-4 rounded-2xl border border-amber-500/20 bg-amber-500/5 mb-5">
          <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-[13px] font-bold text-amber-400">Why you are being asked</div>
            <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">{verdict.reason}</p>
          </div>
        </div>

        <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-4">
          {candidates.length ? `${candidates.length} candidate document${candidates.length === 1 ? '' : 's'}` : 'No candidates'}
        </div>

        {candidates.length === 0 ? (
          <p className="text-sm text-zinc-400 leading-relaxed">
            Nothing in this client's documents explains this transaction inside the current match window. Cash code it to
            create the cost item yourself, or chase the client for the paperwork.
          </p>
        ) : (
          <div className="flex flex-col gap-3 max-h-80 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {candidates.map((c) => {
              const probable = c.kind === 'probable';
              return (
                <div
                  key={c.document.id}
                  className={`p-4 rounded-2xl border transition-all ${
                    probable
                      ? 'border-dashed border-amber-500/30 bg-amber-500/[0.04]'
                      : 'border-white/5 bg-[#0a0a0c]/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <span className="text-sm font-bold text-white truncate">{c.document.supplier}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      {probable ? <Pill tone="amber">Probable</Pill>
                        : c.kind === 'credit-note' ? <Pill tone="blue">Credit note</Pill>
                        : c.kind === 'partial' ? <Pill tone="blue">Batch</Pill>
                        : <Pill tone="green">Exact</Pill>}
                      <span className="text-[12px] font-bold text-zinc-400 tabular-nums">{Math.round(c.confidence * 100)}%</span>
                    </span>
                  </div>
                  <div className="text-[13px] text-zinc-400">
                    {currency(c.document.total)} · {c.document.date} · {c.document.category}
                  </div>
                  <div className="text-[12px] text-zinc-500 mt-1.5 leading-relaxed">{c.reason}</div>

                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => onMatch(c)}
                      className="px-4 py-2 rounded-full text-[12px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors"
                    >
                      This is the one
                    </button>
                    <button
                      onClick={() => onPreview(c.document)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
                    >
                      <Eye size={13} />
                      Preview
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="p-4 bg-[#202026]/50 flex items-center gap-3 flex-wrap justify-end">
        <button onClick={onChase} className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5 transition-colors">
          <Send size={15} />
          Chase for it
        </button>
        <button onClick={onCashCode} className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors">
          <Wand2 size={15} />
          Cash code instead
        </button>
      </div>
    </div>
  );
}

function CashCodePanel({ txn, customCategories, onAddCategory, onConfirm }: {
  txn: BankTransaction;
  customCategories: string[];
  onAddCategory: (name: string) => void;
  onConfirm: (category: string) => void;
}) {
  // Presets first, the accountant's own categories after, "Decide later" always last.
  const categories = [...CASH_CODE_CATEGORIES.filter((c) => c !== '—'), ...customCategories, '—'];
  // '—' is appended unconditionally above, so the list is never empty and the
  // fallback is exactly what the first entry would be if it were.
  const [category, setCategory] = useState(categories[0] ?? '—');
  const [draft, setDraft] = useState('');

  const addCustom = () => {
    const name = draft.trim();
    if (!name) return;
    const existing = categories.find((c) => c.toLowerCase() === name.toLowerCase());
    setCategory(existing ?? name);
    if (!existing) onAddCategory(name);
    setDraft('');
  };

  return (
    <div className="w-full max-w-md border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
      <div className="p-6 border-b border-white/5">
        <h3 className="font-sans font-bold text-xl text-white tracking-tight">Cash code</h3>
        <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
          {txn.description} · {currency(txn.amount)}
        </p>
      </div>
      <div className="p-6 flex flex-col gap-4">
        <p className="text-[13px] text-zinc-400 leading-relaxed">
          This creates a cost item from the transaction. It enters the pipeline like any other document — appearing in
          the inbox, counting toward this client's figures, and closing the missing-evidence flag.
        </p>
        <div>
          <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2.5">Category</div>
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`px-3.5 py-2 rounded-full text-[13px] font-bold border transition-all ${
                  category === c
                    ? 'bg-[#14e3c4] text-white border-[#14e3c4]'
                    : 'bg-[#0a0a0c] text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
                }`}
              >
                {c === '—' ? 'Decide later' : c}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-3">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addCustom(); }}
              placeholder="Add your own category…"
              maxLength={40}
              className="flex-1 bg-[#0a0a0c] border border-white/5 rounded-full py-2 px-4 text-[13px] font-semibold text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-[#14e3c4]"
            />
            <button
              onClick={addCustom}
              disabled={!draft.trim()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-bold text-white bg-white/10 hover:bg-white/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus size={14} strokeWidth={3} />
              Add
            </button>
          </div>
        </div>
      </div>
      <div className="p-4 bg-[#202026]/50 flex justify-end">
        <button
          onClick={() => onConfirm(category)}
          className="flex items-center gap-2 px-6 py-2.5 text-sm font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] rounded-full transition-all"
        >
          <Check size={16} strokeWidth={3} />
          Create cost item
        </button>
      </div>
    </div>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
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

/** A view/download verb on a statement row. */
function StatementButton({ icon: Icon, title, onClick }: { icon: typeof Eye; title: string; onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
      aria-label={title}
      className="p-2 rounded-lg border border-white/5 text-zinc-400 hover:text-white hover:border-white/20 hover:bg-white/5 transition-colors"
    >
      <Icon size={14} />
    </button>
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

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
        className="w-full bg-[#0a0a0c] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#14e3c4] transition-colors"
      />
    </div>
  );
}

function exportTxns(rows: BankTransaction[]) {
  const header = 'Client,Description,Date,Amount,Evidence,Type\n';
  const body = rows
    .map((t) => `"${t.clientName}","${t.description}","${t.date}",${t.amount},"${t.matchedDocId ? 'matched' : 'none'}","${t.isCredit ? 'credit' : 'payment'}"`)
    .join('\n');
  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bank-transactions.csv';
  a.click();
  URL.revokeObjectURL(url);
}
