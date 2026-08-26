import { useMemo, useRef, useState } from 'react';
import {
  Landmark, Search, Link2, Unlink, Send, UploadCloud, SlidersHorizontal,
  AlertTriangle, RefreshCw, Check, FileText, Wand2, Download, Eye, Plus,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Modal } from '../components/DynamicComponents/Modal';
import { defineMessages, useIntl } from 'react-intl';
import { commonActions, commonLabels } from '../i18n/common';
import { useAppContext } from '../context/AppContext';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { SubTabs } from '../components/DynamicComponents/SubTabs';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { fromSlug, slug, useQueryParam, useSegment } from '../lib/router';
import { StatementModal, downloadBank } from '../components/DynamicComponents/StatementModal';
import { ChaseModal } from '../components/DynamicComponents/ChaseModal';
import { currency } from '../lib/resolver';
import { assessTransaction, isMatched, txnLabel, type Candidate, type MatchVerdict } from '../lib/matching';
import { DocumentPreview } from '../components/DynamicComponents/DocumentPreview';
import type { BankAccount, BankTransaction, Document, Match, Statement, StatementGap } from '../lib/types';
import { EXPORT_HINT } from '../lib/exportRules';
import { DataSourceBadge } from '../components/DataSourceBadge';

const TABS = ['Transactions', 'Matches', 'Statements', 'Accounts'] as const;
type Tab = (typeof TABS)[number];

const CASH_CODE_CATEGORIES = ['Office Supplies', 'Cost of Sales Food', 'Software', 'Travel', 'Utilities', 'Marketing', '—'];

/**
 * Tab labels sit beside the tab values rather than inside them: `TABS` is also
 * the routing vocabulary — `slug()`/`fromSlug()` read it off the URL — so the
 * visible label has to be a second lookup keyed by the same value. Descriptors
 * at module scope, formatted at the call site, because a hook cannot run here.
 */
const TAB_LABELS = defineMessages({
  Transactions: { id: 'bank.tabLabel.transactions', defaultMessage: 'Transactions' },
  Matches: { id: 'bank.tabLabel.matches', defaultMessage: 'Matches' },
  Statements: { id: 'bank.tabLabel.statements', defaultMessage: 'Statements' },
  Accounts: { id: 'bank.tabLabel.accounts', defaultMessage: 'Accounts' },
});

/**
 * Evidence-filter labels, same arrangement. Three defaults are lower case on
 * purpose: the pill renders the filter value itself under a CSS `capitalize`,
 * so 'all' is what the DOM has always held and this extraction does not change
 * a character of it.
 */
const EVIDENCE_FILTER_LABELS = defineMessages({
  all: { id: 'bank.evidenceFilter.all', defaultMessage: 'all', description: 'Rendered through CSS capitalisation, hence lower case.' },
  'needs-you': { id: 'bank.evidenceFilter.needsYou', defaultMessage: 'Needs you ({count})' },
  unmatched: { id: 'bank.evidenceFilter.unmatched', defaultMessage: 'unmatched', description: 'Rendered through CSS capitalisation, hence lower case.' },
  matched: { id: 'bank.evidenceFilter.matched', defaultMessage: 'matched', description: 'Rendered through CSS capitalisation, hence lower case.' },
  credits: { id: 'bank.evidenceFilter.credits', defaultMessage: 'Credit notes' },
});

const m = defineMessages({
  heading: { id: 'bank.bankView.heading', defaultMessage: 'Bank' },
  bankLoading: { id: 'bank.bankView.loading', defaultMessage: 'Loading the bank feed…' },
  bankError: { id: 'bank.bankView.loadError', defaultMessage: 'Could not load the bank feed — {error}' },
  matchesLiveNote: {
    id: 'bank.bankView.matchesLiveNote',
    defaultMessage:
      'Confirmed matches live on the transaction rows in this build — confirm a suggested match and the row flips to Matched, through Review → Approve.',
  },
  unexplainedSummary: {
    id: 'bank.bankView.unexplainedSummary',
    defaultMessage: '{count} unexplained · {amount} without evidence',
  },
  matchRulesAction: { id: 'bank.bankView.matchRulesAction', defaultMessage: 'Match rules' },
  uploadStatementAction: { id: 'bank.bankView.uploadStatementAction', defaultMessage: 'Upload statement' },
  uploadAudit: { id: 'bank.bankView.uploadAudit', defaultMessage: 'Uploaded bank statement' },
  uploadAuditScope: { id: 'bank.bankView.uploadAuditScope', defaultMessage: '{file} — {client}' },
  gapBadge: { id: 'bank.bankView.gapBadge', defaultMessage: '{count, plural, one {# gap} other {# gaps}}' },
  searchPlaceholder: { id: 'bank.bankView.searchPlaceholder', defaultMessage: 'Search transactions...' },
  columnDescription: { id: 'bank.bankView.columnDescription', defaultMessage: 'Description' },
  columnClient: { id: 'bank.bankView.columnClient', defaultMessage: 'Client' },
  columnEvidence: { id: 'bank.bankView.columnEvidence', defaultMessage: 'Evidence' },
  accountFallback: { id: 'bank.bankView.accountFallback', defaultMessage: 'Account' },
  matchedByAi: { id: 'bank.bankView.matchedByAi', defaultMessage: 'Matched by AI' },
  matchedByHand: { id: 'bank.bankView.matchedByHand', defaultMessage: 'Matched' },
  needsYouPill: {
    id: 'bank.bankView.needsYouPill',
    defaultMessage: 'Needs you — {count, plural, one {# candidate} other {# candidates}}',
  },
  creditNoDocument: { id: 'bank.bankView.creditNoDocument', defaultMessage: 'Credit — no document' },
  noDocument: { id: 'bank.bankView.noDocument', defaultMessage: 'No document' },
  unmatchConfirmTitle: { id: 'bank.bankView.unmatchConfirmTitle', defaultMessage: 'Break this match?' },
  unmatchConfirmDetail: { id: 'bank.bankView.unmatchConfirmDetail', defaultMessage: '{document} and {transaction}.' },
  unmatchConfirmConsequence: {
    id: 'bank.bankView.unmatchConfirmConsequence',
    defaultMessage: 'The transaction goes back to having no evidence, which makes it a missing item again.',
  },
  unmatchConfirmLabel: { id: 'bank.bankView.unmatchConfirmLabel', defaultMessage: 'Yes, unmatch' },
  unmatchAudit: { id: 'bank.bankView.unmatchAudit', defaultMessage: 'Unmatched document from transaction' },
  unmatchAction: { id: 'bank.bankView.unmatchAction', defaultMessage: 'Unmatch' },
  matchAction: { id: 'bank.bankView.matchAction', defaultMessage: 'Match' },
  cashCodeAction: { id: 'bank.bankView.cashCodeAction', defaultMessage: 'Cash code' },
  transactionsEmpty: {
    id: 'bank.bankView.transactionsEmpty',
    defaultMessage: 'No transactions — connect a feed or upload a statement.',
  },
  chaseBulkAction: { id: 'bank.bankView.chaseBulkAction', defaultMessage: 'Chase for evidence' },
  transactionsFooter: {
    id: 'bank.bankView.transactionsFooter',
    defaultMessage: '{count} transactions • {unmatched} without evidence',
  },
  matchesEmpty: {
    id: 'bank.bankView.matchesEmpty',
    defaultMessage: 'No matches yet. Match a transaction from the Transactions tab.',
  },
  matchKindExact: { id: 'bank.bankView.matchKindExact', defaultMessage: 'Exact' },
  matchKindCreditNote: { id: 'bank.bankView.matchKindCreditNote', defaultMessage: 'Credit note' },
  matchKindPartial: { id: 'bank.bankView.matchKindPartial', defaultMessage: 'Batch payment' },
  matchKindProbable: { id: 'bank.bankView.matchKindProbable', defaultMessage: 'Probable' },
  decidedByAi: { id: 'bank.bankView.decidedByAi', defaultMessage: 'AI' },
  decidedByYou: { id: 'bank.bankView.decidedByYou', defaultMessage: 'You' },
  confidence: { id: 'bank.bankView.confidence', defaultMessage: '{percent}%' },
  documentSection: { id: 'bank.bankView.documentSection', defaultMessage: 'Document' },
  transactionSection: { id: 'bank.bankView.transactionSection', defaultMessage: 'Transaction' },
  matchAudit: { id: 'bank.bankView.matchAudit', defaultMessage: 'Matched document to transaction' },
  cashCodeAudit: { id: 'bank.bankView.cashCodeAudit', defaultMessage: 'Cash coded transaction' },
  gapsHeading: {
    id: 'bank.bankView.gapsHeading',
    defaultMessage: '{count, plural, one {# statement gap} other {# statement gaps}}',
  },
  gapsSubheading: {
    id: 'bank.bankView.gapsSubheading',
    defaultMessage: 'Detected from opening/closing balances and date continuity',
  },
  gapRow: { id: 'bank.bankView.gapRow', defaultMessage: '{client} — {start} to {end}' },
  requestStatementAction: { id: 'bank.bankView.requestStatementAction', defaultMessage: 'Request statement' },
  statementsTitle: { id: 'bank.bankView.statementsTitle', defaultMessage: 'Statements' },
  statementsSubtitle: {
    id: 'bank.bankView.statementsSubtitle',
    defaultMessage: 'PDF / TIFF up to 50MB, 300 pages · CSV and XLSX also accepted',
  },
  columnFile: { id: 'bank.bankView.columnFile', defaultMessage: 'File' },
  columnPeriod: { id: 'bank.bankView.columnPeriod', defaultMessage: 'Period' },
  columnRows: { id: 'bank.bankView.columnRows', defaultMessage: 'Rows' },
  columnBalances: { id: 'bank.bankView.columnBalances', defaultMessage: 'Opening → Closing' },
  statusExtracted: { id: 'bank.bankView.statusExtracted', defaultMessage: 'Extracted' },
  statusProcessing: { id: 'bank.bankView.statusProcessing', defaultMessage: 'Extracting…' },
  statusFailed: { id: 'bank.bankView.statusFailed', defaultMessage: 'Failed' },
  viewStatementAction: {
    id: 'bank.bankView.viewStatementAction',
    defaultMessage: 'See what was read off this statement',
  },
  downloadStatementAction: {
    id: 'bank.bankView.downloadStatementAction',
    defaultMessage: 'Download the extracted data as CSV',
  },
  statementsEmpty: { id: 'bank.bankView.statementsEmpty', defaultMessage: 'No statements uploaded.' },
  accountFeedLive: { id: 'bank.bankView.accountFeedLive', defaultMessage: 'Feed live' },
  accountCredentialError: { id: 'bank.bankView.accountCredentialError', defaultMessage: 'Credential error' },
  accountStatementsOnly: { id: 'bank.bankView.accountStatementsOnly', defaultMessage: 'Statements only' },
  rowBalance: { id: 'bank.bankView.rowBalance', defaultMessage: 'Balance' },
  rowLastSync: { id: 'bank.bankView.rowLastSync', defaultMessage: 'Last sync' },
  rowSource: { id: 'bank.bankView.rowSource', defaultMessage: 'Source' },
  sourceFeed: { id: 'bank.bankView.sourceFeed', defaultMessage: 'Plaid open-banking feed' },
  sourceUpload: { id: 'bank.bankView.sourceUpload', defaultMessage: 'Statement upload fallback' },
  consentExpires: { id: 'bank.bankView.consentExpires', defaultMessage: 'Consent expires in' },
  // Not a plural: the screen says "1 days" today and this is an extraction,
  // not a rewrite. Flagged in the report instead.
  consentDays: { id: 'bank.bankView.consentDays', defaultMessage: '{count} days' },
  connectFeedAction: { id: 'bank.bankView.connectFeedAction', defaultMessage: 'Connect feed' },
  reauthAction: { id: 'bank.bankView.reauthAction', defaultMessage: 'Re-authorise' },
  reauthAudit: { id: 'bank.bankView.reauthAudit', defaultMessage: 'Re-authorised bank connection' },
  accountUnexplained: { id: 'bank.bankView.accountUnexplained', defaultMessage: '{count} unexplained' },
  chaseNote: {
    id: 'bank.bankView.chaseNote',
    defaultMessage: 'The bank shows spend with no document — this asks for it.',
  },
  settingsHeading: { id: 'bank.bankView.settingsHeading', defaultMessage: 'Match rules' },
  settingsSubheading: {
    id: 'bank.bankView.settingsSubheading',
    defaultMessage: "Configurable — Dext's windows are fixed",
  },
  settingsDocumentWindow: { id: 'bank.bankView.settingsDocumentWindow', defaultMessage: 'Days after document date' },
  settingsDueWindow: { id: 'bank.bankView.settingsDueWindow', defaultMessage: 'Days around due date' },
  settingsLookback: { id: 'bank.bankView.settingsLookback', defaultMessage: 'Lookback (months)' },
  settingsProbableTitle: { id: 'bank.bankView.settingsProbableTitle', defaultMessage: 'Suggest probable matches' },
  settingsProbableDetail: {
    id: 'bank.bankView.settingsProbableDetail',
    defaultMessage: 'Always shown as visually distinct from exact matches.',
  },
  settingsDone: { id: 'bank.bankView.settingsDone', defaultMessage: 'Done' },
});

const mPicker = defineMessages({
  whyAsked: { id: 'bank.matchPicker.whyAsked', defaultMessage: 'Why you are being asked' },
  candidateCount: {
    id: 'bank.matchPicker.candidateCount',
    defaultMessage: '{count, plural, one {# candidate document} other {# candidate documents}}',
  },
  noCandidates: { id: 'bank.matchPicker.noCandidates', defaultMessage: 'No candidates' },
  noCandidatesBody: {
    id: 'bank.matchPicker.noCandidatesBody',
    defaultMessage:
      "Nothing in this client's documents explains this transaction inside the current match window. Cash code it to create the cost item yourself, or chase the client for the paperwork.",
  },
  kindProbable: { id: 'bank.matchPicker.kindProbable', defaultMessage: 'Probable' },
  kindCreditNote: { id: 'bank.matchPicker.kindCreditNote', defaultMessage: 'Credit note' },
  kindPartial: { id: 'bank.matchPicker.kindPartial', defaultMessage: 'Batch' },
  kindExact: { id: 'bank.matchPicker.kindExact', defaultMessage: 'Exact' },
  confidence: { id: 'bank.matchPicker.confidence', defaultMessage: '{percent}%' },
  chooseAction: { id: 'bank.matchPicker.chooseAction', defaultMessage: 'This is the one' },
  previewAction: { id: 'bank.matchPicker.previewAction', defaultMessage: 'Preview' },
  chaseAction: { id: 'bank.matchPicker.chaseAction', defaultMessage: 'Chase for it' },
  cashCodeAction: { id: 'bank.matchPicker.cashCodeAction', defaultMessage: 'Cash code instead' },
});

const mCash = defineMessages({
  heading: { id: 'bank.cashCodePanel.heading', defaultMessage: 'Cash code' },
  body: {
    id: 'bank.cashCodePanel.body',
    defaultMessage:
      "This creates a cost item from the transaction. It enters the pipeline like any other document — appearing in the inbox, counting toward this client's figures, and closing the missing-evidence flag.",
  },
  decideLater: { id: 'bank.cashCodePanel.decideLater', defaultMessage: 'Decide later' },
  addCategoryPlaceholder: { id: 'bank.cashCodePanel.addCategoryPlaceholder', defaultMessage: 'Add your own category…' },
  addAction: { id: 'bank.cashCodePanel.addAction', defaultMessage: 'Add' },
  confirmAction: { id: 'bank.cashCodePanel.confirmAction', defaultMessage: 'Create cost item' },
});

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
    uploadStatement, reauthAccount, logAudit, statsFor, isSameClient, slices,
  } = useAppContext();
  const intl = useIntl();

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
  /**
   * Whether the rows on screen are the server's (METH S11/S14). The synthetic
   * writers below (cash coding, the chase composer, the seed match cards)
   * stay off live rows — a write the next poll reverts is worse than absent.
   */
  const bankSlice = slices.bankTransactions;
  const liveBank = bankSlice.source === 'api';
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
      // `isMatched`, not `matchedDocId`, everywhere the question is "does this
      // line already have its evidence". A server-confirmed row carries
      // `matchState` and no document id — the contract has no field for one —
      // so keying on the id alone would show every persisted match as
      // unmatched the moment the screen ran on real data (METH Stage 11).
      if (isMatched(t)) continue;
      map.set(t.id, assessTransaction(intl, t, documents, matchSettings));
    }
    return map;
  }, [intl, transactions, documents, matchSettings]);

  const verdictFor = (t: BankTransaction): MatchVerdict =>
    verdicts.get(t.id) ?? { kind: 'none', candidates: [], reason: '' };

  const scopedTxns = useMemo(() => {
    const q = query.trim().toLowerCase();
    return transactions.filter((t) => {
      // Tolerant of both id worlds: server rows carry opaque business ids,
      // the embedding client detail still keys by seed id (METH S14 bridge).
      if (clientFilter !== 'all' && !isSameClient(t.clientId, clientFilter)) return false;
      if (evidenceFilter === 'needs-you' && (isMatched(t) || verdicts.get(t.id)?.kind !== 'confused')) return false;
      if (evidenceFilter === 'unmatched' && isMatched(t)) return false;
      if (evidenceFilter === 'matched' && !isMatched(t)) return false;
      if (evidenceFilter === 'credits' && !t.isCredit) return false;
      if (q && !`${t.description} ${t.clientName} ${t.amount}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [transactions, clientFilter, evidenceFilter, query, verdicts, isSameClient]);

  const scopedMatches = matches.filter(
    (match) => clientFilter === 'all' || clients.find((c) => c.id === clientFilter)?.name === match.clientName,
  );
  const scopedStatements = statements.filter((s) => clientFilter === 'all' || s.clientId === clientFilter);
  const scopedGaps = statementGaps.filter((g) => clientFilter === 'all' || g.clientId === clientFilter);
  const scopedAccounts = accounts.filter((a) => clientFilter === 'all' || a.clientId === clientFilter);

  // The number the whole screen is about, and the one that has to agree with
  // chase detection: the server's unmatched set is `match_state != CONFIRMED`,
  // which is exactly what `isMatched` negates.
  const unmatchedCount = scopedTxns.filter((t) => !isMatched(t)).length;
  const unexplained = scopedTxns.filter((t) => !isMatched(t)).reduce((n, t) => n + Math.abs(t.amount), 0);

  // Counted across the client scope rather than the current filter, so the tab
  // does not read "Needs you (0)" while it is the tab you are looking at.
  const needsYouCount = useMemo(
    () =>
      transactions.filter(
        (t) =>
          (clientFilter === 'all' || isSameClient(t.clientId, clientFilter)) &&
          !isMatched(t) &&
          verdicts.get(t.id)?.kind === 'confused',
      ).length,
    [transactions, clientFilter, verdicts, isSameClient],
  );

  /** Composed here — the transaction is already chosen. */
  const chase = (ids: string[]) => setChasing(ids);

  const txnColumns: Column<BankTransaction>[] = [
    {
      key: 'description', label: intl.formatMessage(m.columnDescription), sortValue: (t) => t.description,
      render: (t) => (
        <span>
          <span className="block text-white font-semibold">{t.description}</span>
          <span className="block text-[11px] text-zinc-500 font-medium">
            {accounts.find((a) => a.id === t.accountId)?.bankName ?? intl.formatMessage(m.accountFallback)} ••{accounts.find((a) => a.id === t.accountId)?.last4 ?? '----'}
          </span>
        </span>
      ),
    },
    { key: 'clientName', label: intl.formatMessage(m.columnClient), sortValue: (t) => t.clientName },
    { key: 'date', label: intl.formatMessage(commonLabels.date), sortValue: (t) => t.date },
    {
      key: 'evidence', label: intl.formatMessage(m.columnEvidence), sortValue: (t) => (isMatched(t) ? 1 : 0),
      render: (t) => {
        if (isMatched(t)) {
          const match = matches.find((x) => x.transactionId === t.id);
          return <Pill tone="green">{intl.formatMessage(match?.auto ? m.matchedByAi : m.matchedByHand)}</Pill>;
        }
        const v = verdictFor(t);
        if (v.kind === 'confused') {
          return <Pill tone="amber">{intl.formatMessage(m.needsYouPill, { count: v.candidates.length })}</Pill>;
        }
        return t.isCredit
          ? <Pill tone="blue">{intl.formatMessage(m.creditNoDocument)}</Pill>
          : <Pill tone="red">{intl.formatMessage(m.noDocument)}</Pill>;
      },
    },
    {
      key: 'amount', label: intl.formatMessage(commonLabels.amount), align: 'right', sortValue: (t) => t.amount,
      render: (t) => <span className={`font-bold tabular-nums ${t.amount < 0 ? 'text-emerald-400' : 'text-white'}`}>{currency(t.amount)}</span>,
    },
    {
      key: 'actions', label: '', align: 'right',
      render: (t) => {
        if (isMatched(t)) {
          const match = matches.find((x) => x.transactionId === t.id);
          // Unmatch is offered ONLY for a locally-matched row.
          //
          // `matchState !== undefined` means the row came from the server, and
          // breaking a confirmed match has no approved path yet — there is no
          // `bank.unmatch` kind in the contract's `ProposalKind` enum, so the
          // button could only ever undo the match in this browser while the
          // database went on saying CONFIRMED. Offering nothing is honest;
          // offering a button that silently does nothing is not, and that is
          // what the old `if (!match) return` inside the handler would have
          // become the moment the screen ran on real data.
          if (!match || t.matchState !== undefined) return null;
          return (
            <button
              onClick={async (e) => {
                e.stopPropagation();
                const ok = await confirm({
                  tone: 'red',
                  title: intl.formatMessage(m.unmatchConfirmTitle),
                  detail: intl.formatMessage(m.unmatchConfirmDetail, {
                    document: match.documentLabel,
                    transaction: match.transactionLabel,
                  }),
                  consequence: intl.formatMessage(m.unmatchConfirmConsequence),
                  confirmLabel: intl.formatMessage(m.unmatchConfirmLabel),
                });
                if (!ok) return;
                unmatchTransaction(match.id);
                logAudit({ action: intl.formatMessage(m.unmatchAudit), scope: txnLabel(t), reviewOpened: true });
              }}
              className="px-3 py-1.5 rounded-full text-[12px] font-bold text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5 transition-colors"
            >
              {intl.formatMessage(m.unmatchAction)}
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
                className="px-3 py-1.5 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
              >
                {intl.formatMessage(m.matchAction)}
              </button>
            )}
            {/* Cash coding writes a local document nothing persists — off
                live rows until it has an endpoint (METH S14 sweep). */}
            {!liveBank && (
              <button
                onClick={(e) => { e.stopPropagation(); setCashFor(t); }}
                className="px-3 py-1.5 rounded-full text-[12px] font-bold text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5 transition-colors"
              >
                {intl.formatMessage(m.cashCodeAction)}
              </button>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <div className={scopedToClient
      ? 'flex flex-col min-w-0'
      : 'flex-1 flex flex-col min-w-0 bg-ground h-full overflow-hidden'}>
      <header className={scopedToClient ? 'pb-5 shrink-0' : 'px-4 md:px-10 pt-4 md:pt-8 pb-4 md:pb-5 shrink-0'}>
        {/* Loading and failure are said out loud (METH S14 sweep): seed rows
            render underneath either way — the standing fallback — but never
            silently impersonating the feed. */}
        {bankSlice.loading && (
          <div className="mb-4 flex items-center gap-3 px-5 py-3 rounded-2xl border bg-white/[0.03] border-white/10 text-zinc-400 text-[13px] font-semibold">
            <RefreshCw size={15} className="animate-spin" />
            <span>{intl.formatMessage(m.bankLoading)}</span>
          </div>
        )}
        {bankSlice.error && (
          <div className="mb-4 flex items-center gap-3 px-5 py-3 rounded-2xl border bg-red-500/10 border-red-500/20 text-red-300 text-[13px] font-semibold">
            <AlertTriangle size={15} className="shrink-0" />
            <span className="min-w-0">{intl.formatMessage(m.bankError, { error: bankSlice.error })}</span>
            <DataSourceBadge slice="bankTransactions" status={bankSlice} />
          </div>
        )}
        <div data-tour="bank-header" className="flex items-start justify-between gap-4 flex-wrap">
          {/* The client page already names the client, so the embedded copy
              leads with the number that decides whether you act. */}
          {scopedToClient ? (
            <p className="text-[12px] text-zinc-500 font-semibold uppercase tracking-wider self-center">
              {intl.formatMessage(m.unexplainedSummary, { count: unmatchedCount, amount: currency(unexplained) })}
            </p>
          ) : (
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white border border-white/5 shadow-inner">
                <Landmark size={22} />
              </div>
              <div>
                <h1 className="font-sans text-2xl md:text-3xl font-semibold text-white tracking-tight">
                  {intl.formatMessage(m.heading)}
                </h1>
                <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                  {intl.formatMessage(m.unexplainedSummary, { count: unmatchedCount, amount: currency(unexplained) })}
                </p>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => setSettingsOpen(true)}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-zinc-300 bg-card border border-white/10 rounded-full hover:bg-white/5 transition-all shadow-lg"
            >
              <SlidersHorizontal size={16} />
              {intl.formatMessage(m.matchRulesAction)}
            </button>
            <button
              onClick={() => { setUploadFor(clientFilter === 'all' ? clients[0]?.id ?? null : clientFilter); fileRef.current?.click(); }}
              className="flex items-center gap-2 px-6 py-2.5 text-sm font-bold text-white bg-brand rounded-full hover:bg-brand-hover transition-all shadow-glow-btn-soft"
            >
              <UploadCloud size={16} />
              {intl.formatMessage(m.uploadStatementAction)}
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
                    action: intl.formatMessage(m.uploadAudit),
                    scope: intl.formatMessage(m.uploadAuditScope, {
                      file: f.name,
                      client: clients.find((c) => c.id === targetId)?.name,
                    }),
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
      <div className={`${scopedToClient ? '' : 'px-4 md:px-10'} pb-5 shrink-0`}>
        {scopedToClient ? (
          <SubTabs
            tabs={TABS.map((t) => ({
              key: t,
              label: intl.formatMessage(TAB_LABELS[t]),
              // A count only exists on Matches, and SubTab asks for the key to
              // be absent rather than present and undefined.
              ...(t === 'Matches' ? { count: scopedMatches.length } : {}),
              alert: t === 'Statements' && scopedGaps.length > 0,
              badge:
                t === 'Statements' && scopedGaps.length > 0 ? (
                  <span className="text-[11px] font-bold text-amber-400">
                    {intl.formatMessage(m.gapBadge, { count: scopedGaps.length })}
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
                    ? 'bg-brand text-white border-brand shadow-glow-pill'
                    : 'bg-card text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
                }`}
              >
                {intl.formatMessage(TAB_LABELS[t])}
                {t === 'Matches' && scopedMatches.length > 0 && <span className="ml-2 opacity-60">{scopedMatches.length}</span>}
                {t === 'Statements' && scopedGaps.length > 0 && (
                  <span className="ml-2 text-amber-400">
                    {intl.formatMessage(m.gapBadge, { count: scopedGaps.length })}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={scopedToClient
        ? ''
        : 'flex-1 overflow-y-auto px-4 md:px-10 pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'}>
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {tab === 'Transactions' && (
            <>
              <div className="flex items-center gap-3 mb-5 flex-wrap">
                <div className="relative w-full sm:w-auto">
                  <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={intl.formatMessage(m.searchPlaceholder)}
                    className="w-full sm:w-64 bg-card border border-white/5 rounded-full py-2.5 pl-11 pr-4 text-sm focus:outline-none focus:border-brand placeholder:text-zinc-600 text-white font-medium shadow-inner"
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
                        ? 'bg-brand text-white border-brand'
                        : 'bg-card text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
                    }`}
                  >
                    {intl.formatMessage(EVIDENCE_FILTER_LABELS[f], { count: needsYouCount })}
                  </button>
                ))}
              </div>

              <DataTable<BankTransaction>
                className="max-w-none"
                columns={txnColumns}
                rows={scopedTxns}
                rowId={(t) => t.id}
                selectable
                emptyMessage={intl.formatMessage(m.transactionsEmpty)}
                bulkActions={[
                  // The synthetic composer's chase never reaches the live
                  // board — live chasing is the workspace's chase.send
                  // proposal (METH S14 sweep).
                  ...(liveBank
                    ? []
                    : [
                        {
                          label: intl.formatMessage(m.chaseBulkAction),
                          icon: Send,
                          primary: true,
                          onClick: (sel: BankTransaction[]) =>
                            chase([...new Set(sel.filter((t) => !isMatched(t)).map((t) => t.clientId))]),
                        },
                      ]),
                  { label: intl.formatMessage(commonActions.exportCsv), icon: Download, minSelected: 2, disabledHint: intl.formatMessage(EXPORT_HINT), onClick: (sel) => exportTxns(sel) },
                ]}
                footer={intl.formatMessage(m.transactionsFooter, { count: scopedTxns.length, unmatched: unmatchedCount })}
              />
            </>
          )}

          {/* A responsive grid rather than a table: a match is a pair of
              facing labels, which reads badly in columns that have to scroll
              sideways once this sits inside a client tab. One up on a phone,
              two on a laptop, three on a wide screen. */}
          {tab === 'Matches' && (
            // The seed match cards point at seed transactions the live rows
            // replaced — meaningless against the feed. Live, this tab says
            // where matches actually live (METH S14 sweep).
            liveBank ? (
              <div className="border border-white/5 rounded-[32px] bg-card p-4 md:p-10 text-center text-zinc-500 text-[13px] shadow-2xl">
                {intl.formatMessage(m.matchesLiveNote)}
              </div>
            ) : scopedMatches.length === 0 ? (
              <div className="border border-white/5 rounded-[32px] bg-card p-4 md:p-10 text-center text-zinc-500 text-[13px] shadow-2xl">
                {intl.formatMessage(m.matchesEmpty)}
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">
                {/* Named `match` rather than `m`, which is the message
                    catalogue in this module. */}
                {scopedMatches.map((match: Match) => (
                  <div
                    key={match.id}
                    className="border border-white/5 rounded-[24px] bg-card shadow-2xl overflow-hidden flex flex-col"
                  >
                    <div className="p-5 flex items-center justify-between gap-3 flex-wrap border-b border-white/5">
                      <span className="inline-flex items-center gap-2">
                        {match.kind === 'exact' ? <Pill tone="green">{intl.formatMessage(m.matchKindExact)}</Pill>
                          : match.kind === 'credit-note' ? <Pill tone="blue">{intl.formatMessage(m.matchKindCreditNote)}</Pill>
                          : match.kind === 'partial' ? <Pill tone="blue">{intl.formatMessage(m.matchKindPartial)}</Pill>
                          : <Pill tone="amber">{intl.formatMessage(m.matchKindProbable)}</Pill>}
                        {/* Who made the call — the matcher, or a person. */}
                        <Pill>{intl.formatMessage(match.auto ? m.decidedByAi : m.decidedByYou)}</Pill>
                      </span>
                      <span className="inline-flex items-center gap-2 shrink-0">
                        <span className="w-14 h-1.5 rounded-full bg-white/5 overflow-hidden">
                          <span
                            className={`block h-full rounded-full ${match.kind === 'probable' ? 'bg-amber-400' : 'bg-brand'}`}
                            style={{ width: `${Math.round(match.confidence * 100)}%` }}
                          />
                        </span>
                        <span className="tabular-nums text-zinc-400 text-[12px] font-bold">
                          {intl.formatMessage(m.confidence, { percent: Math.round(match.confidence * 100) })}
                        </span>
                      </span>
                    </div>

                    <div className="p-5 flex flex-col gap-3 flex-1">
                      <div>
                        <div className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest mb-1">
                          {intl.formatMessage(m.documentSection)}
                        </div>
                        <div className="text-[13px] text-white font-semibold leading-snug">{match.documentLabel}</div>
                      </div>
                      <div>
                        <div className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest mb-1">
                          {intl.formatMessage(m.transactionSection)}
                        </div>
                        <div className="text-[13px] text-zinc-400 leading-snug">{match.transactionLabel}</div>
                      </div>
                      {match.reason && <p className="text-[12px] text-zinc-500 leading-relaxed">{match.reason}</p>}
                    </div>

                    <div className="p-4 bg-raised/50 flex items-center justify-between gap-2 sm:gap-3 flex-wrap">
                      <span className="text-[13px] font-bold text-white tabular-nums">{currency(Math.abs(match.amount))}</span>
                      <button
                        onClick={async () => {
                          const ok = await confirm({
                            tone: 'red',
                            title: intl.formatMessage(m.unmatchConfirmTitle),
                            detail: intl.formatMessage(m.unmatchConfirmDetail, {
                              document: match.documentLabel,
                              transaction: match.transactionLabel,
                            }),
                            consequence: intl.formatMessage(m.unmatchConfirmConsequence),
                            confirmLabel: intl.formatMessage(m.unmatchConfirmLabel),
                          });
                          if (!ok) return;
                          unmatchTransaction(match.id);
                          logAudit({ action: intl.formatMessage(m.unmatchAudit), scope: match.documentLabel, reviewOpened: true });
                        }}
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-bold text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5 transition-colors"
                      >
                        <Unlink size={12} />
                        {intl.formatMessage(m.unmatchAction)}
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
                        {intl.formatMessage(m.gapsHeading, { count: scopedGaps.length })}
                      </h3>
                      <p className="text-[12px] text-amber-200/70 font-semibold">
                        {intl.formatMessage(m.gapsSubheading)}
                      </p>
                    </div>
                  </div>
                  <div className="divide-y divide-amber-500/10">
                    {scopedGaps.map((g: StatementGap) => (
                      <div key={g.id} className="px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
                        <div>
                          <div className="text-sm font-bold text-white">
                            {intl.formatMessage(m.gapRow, {
                              client: g.clientName,
                              start: g.periodStart,
                              end: g.periodEnd,
                            })}
                          </div>
                          <div className="text-[12px] text-amber-200/70 mt-0.5">{g.reason}</div>
                        </div>
                        {/* The synthetic composer again — hidden live
                            (METH S14 sweep). */}
                        {!liveBank && (
                          <button
                            onClick={() => chase([g.clientId])}
                            className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shrink-0"
                          >
                            <Send size={14} />
                            {intl.formatMessage(m.requestStatementAction)}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <DataTable
                className="max-w-none"
                title={intl.formatMessage(m.statementsTitle)}
                subtitle={intl.formatMessage(m.statementsSubtitle)}
                columns={[
                  { key: 'fileName', label: intl.formatMessage(m.columnFile), render: (s) => <span className="text-white font-semibold">{s.fileName}</span> },
                  { key: 'clientName', label: intl.formatMessage(m.columnClient), sortValue: (s) => s.clientName },
                  { key: 'period', label: intl.formatMessage(m.columnPeriod), sortValue: (s) => s.period },
                  { key: 'rows', label: intl.formatMessage(m.columnRows), align: 'right', sortValue: (s) => s.rows, render: (s) => <span className="tabular-nums text-zinc-400">{s.rows || '—'}</span> },
                  {
                    key: 'balances', label: intl.formatMessage(m.columnBalances), align: 'right',
                    render: (s: Statement) => s.status === 'extracted'
                      ? <span className="tabular-nums text-zinc-400">{currency(s.openingBalance)} → <span className="text-white font-bold">{currency(s.closingBalance)}</span></span>
                      : <span className="text-zinc-600">—</span>,
                  },
                  {
                    key: 'status', label: intl.formatMessage(commonLabels.status), sortValue: (s) => s.status,
                    render: (s: Statement) =>
                      s.status === 'extracted' ? <Pill tone="green">{intl.formatMessage(m.statusExtracted)}</Pill>
                        : s.status === 'processing' ? <Pill>{intl.formatMessage(m.statusProcessing)}</Pill>
                        : <Pill tone="red">{s.note ?? intl.formatMessage(m.statusFailed)}</Pill>,
                  },
                  {
                    // Every upload can be opened and taken away — a statement
                    // nobody can look at is just a filename in a list.
                    key: 'actions', label: '', align: 'right',
                    render: (s: Statement) => (
                      <span className="flex items-center justify-end gap-1.5">
                        <StatementButton icon={Eye} title={intl.formatMessage(m.viewStatementAction)} onClick={() => setViewingStatement(s.id)} />
                        <StatementButton icon={Download} title={intl.formatMessage(m.downloadStatementAction)} onClick={() => downloadBank(s)} />
                      </span>
                    ),
                  },
                ]}
                rows={scopedStatements}
                rowId={(s) => s.id}
                emptyMessage={intl.formatMessage(m.statementsEmpty)}
              />
            </div>
          )}

          {tab === 'Accounts' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {scopedAccounts.map((a: BankAccount) => (
                <div key={a.id} className="border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
                  <div className="p-6 flex items-start justify-between gap-4 border-b border-white/5">
                    <div>
                      <h3 className="font-sans font-bold text-xl text-white tracking-tight">{a.bankName}</h3>
                      <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                        {a.clientName} · {a.sortCode} · ••{a.last4}
                      </p>
                    </div>
                    {a.status === 'live' ? <Pill tone="green">{intl.formatMessage(m.accountFeedLive)}</Pill>
                      : a.status === 'error' ? <Pill tone="red">{intl.formatMessage(m.accountCredentialError)}</Pill>
                      : <Pill tone="amber">{intl.formatMessage(m.accountStatementsOnly)}</Pill>}
                  </div>
                  <div className="p-6 flex flex-col gap-2.5 text-[13px]">
                    <Row label={intl.formatMessage(m.rowBalance)} value={currency(a.balance)} />
                    <Row label={intl.formatMessage(m.rowLastSync)} value={a.lastSync} />
                    <Row
                      label={intl.formatMessage(m.rowSource)}
                      value={intl.formatMessage(a.source === 'feed' ? m.sourceFeed : m.sourceUpload)}
                    />
                    {a.status !== 'disconnected' && (
                      <div className="mt-2">
                        <div className="flex justify-between items-center text-[12px] mb-1.5">
                          <span className="text-zinc-500 font-medium">{intl.formatMessage(m.consentExpires)}</span>
                          <span className={`font-bold ${a.reauthDays < 14 ? 'text-red-400' : 'text-white'}`}>
                            {intl.formatMessage(m.consentDays, { count: a.reauthDays })}
                          </span>
                        </div>
                        <div className="h-1.5 w-full bg-raised rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${a.reauthDays < 14 ? 'bg-red-500' : 'bg-brand'}`}
                            style={{ width: `${Math.min(100, (a.reauthDays / 90) * 100)}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="p-4 bg-raised/50 flex items-center gap-3 flex-wrap">
                    <button
                      onClick={() => { reauthAccount(a.id); logAudit({ action: intl.formatMessage(m.reauthAudit), scope: `${a.bankName} ••${a.last4}`, reviewOpened: true }); }}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                    >
                      <RefreshCw size={15} />
                      {intl.formatMessage(a.status === 'disconnected' ? m.connectFeedAction : m.reauthAction)}
                    </button>
                    <button
                      onClick={() => { setUploadFor(a.clientId); fileRef.current?.click(); }}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-2xl text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5 transition-colors"
                    >
                      <FileText size={15} />
                      {intl.formatMessage(m.uploadStatementAction)}
                    </button>
                    <span className="ml-auto text-[12px] text-zinc-600 font-semibold">
                      {intl.formatMessage(m.accountUnexplained, { count: statsFor(a.clientId).unmatched })}
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
                logAudit({ action: intl.formatMessage(m.matchAudit), scope: `${c.document.supplier} ↔ ${matchFor.description}`, reviewOpened: true });
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
            note={intl.formatMessage(m.chaseNote)}
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
                logAudit({ action: intl.formatMessage(m.cashCodeAudit), scope: `${cashFor.description} → ${category}`, reviewOpened: true });
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
            <div className="w-full max-w-md border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
              <div className="p-6 border-b border-white/5">
                <h3 className="font-sans font-bold text-xl text-white tracking-tight">
                  {intl.formatMessage(m.settingsHeading)}
                </h3>
                <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                  {intl.formatMessage(m.settingsSubheading)}
                </p>
              </div>
              <div className="p-6 flex flex-col gap-5">
                <NumberField label={intl.formatMessage(m.settingsDocumentWindow)} value={matchSettings.documentWindow} onChange={(v) => setMatchSettings({ ...matchSettings, documentWindow: v })} />
                <NumberField label={intl.formatMessage(m.settingsDueWindow)} value={matchSettings.dueWindow} onChange={(v) => setMatchSettings({ ...matchSettings, dueWindow: v })} />
                <NumberField label={intl.formatMessage(m.settingsLookback)} value={matchSettings.lookbackMonths} onChange={(v) => setMatchSettings({ ...matchSettings, lookbackMonths: v })} />
                <button
                  onClick={() => setMatchSettings({ ...matchSettings, allowProbable: !matchSettings.allowProbable })}
                  className="flex items-center justify-between gap-4 p-4 rounded-2xl border border-white/5 bg-ground/60 hover:border-white/15 transition-colors text-left"
                >
                  <div>
                    <div className="text-sm font-bold text-white">{intl.formatMessage(m.settingsProbableTitle)}</div>
                    <div className="text-[12px] text-zinc-500 mt-0.5">{intl.formatMessage(m.settingsProbableDetail)}</div>
                  </div>
                  <span className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${matchSettings.allowProbable ? 'bg-brand' : 'bg-white/10'}`}>
                    <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${matchSettings.allowProbable ? 'left-6' : 'left-1'}`} />
                  </span>
                </button>
              </div>
              <div className="p-4 bg-raised/50 flex justify-end">
                <button onClick={() => setSettingsOpen(false)} className="px-6 py-2.5 text-sm font-bold text-white bg-brand hover:bg-brand-hover rounded-full transition-all">
                  {intl.formatMessage(m.settingsDone)}
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
  const intl = useIntl();

  return (
    <div className="w-full max-w-2xl border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
      <div className="p-6 border-b border-white/5 flex items-center gap-4">
        <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white border border-white/5 shadow-inner shrink-0">
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
            <div className="text-[13px] font-bold text-amber-400">{intl.formatMessage(mPicker.whyAsked)}</div>
            <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">{verdict.reason}</p>
          </div>
        </div>

        <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-4">
          {candidates.length
            ? intl.formatMessage(mPicker.candidateCount, { count: candidates.length })
            : intl.formatMessage(mPicker.noCandidates)}
        </div>

        {candidates.length === 0 ? (
          <p className="text-sm text-zinc-400 leading-relaxed">
            {intl.formatMessage(mPicker.noCandidatesBody)}
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
                      : 'border-white/5 bg-ground/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <span className="text-sm font-bold text-white truncate">{c.document.supplier}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      {probable ? <Pill tone="amber">{intl.formatMessage(mPicker.kindProbable)}</Pill>
                        : c.kind === 'credit-note' ? <Pill tone="blue">{intl.formatMessage(mPicker.kindCreditNote)}</Pill>
                        : c.kind === 'partial' ? <Pill tone="blue">{intl.formatMessage(mPicker.kindPartial)}</Pill>
                        : <Pill tone="green">{intl.formatMessage(mPicker.kindExact)}</Pill>}
                      <span className="text-[12px] font-bold text-zinc-400 tabular-nums">
                        {intl.formatMessage(mPicker.confidence, { percent: Math.round(c.confidence * 100) })}
                      </span>
                    </span>
                  </div>
                  <div className="text-[13px] text-zinc-400">
                    {currency(c.document.total)} · {c.document.date} · {c.document.category}
                  </div>
                  <div className="text-[12px] text-zinc-500 mt-1.5 leading-relaxed">{c.reason}</div>

                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => onMatch(c)}
                      className="px-4 py-2 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                    >
                      {intl.formatMessage(mPicker.chooseAction)}
                    </button>
                    <button
                      onClick={() => onPreview(c.document)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
                    >
                      <Eye size={13} />
                      {intl.formatMessage(mPicker.previewAction)}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="p-4 bg-raised/50 flex items-center gap-3 flex-wrap justify-end">
        <button onClick={onChase} className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5 transition-colors">
          <Send size={15} />
          {intl.formatMessage(mPicker.chaseAction)}
        </button>
        <button onClick={onCashCode} className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-colors">
          <Wand2 size={15} />
          {intl.formatMessage(mPicker.cashCodeAction)}
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
  const intl = useIntl();
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
    <div className="w-full max-w-md border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
      <div className="p-6 border-b border-white/5">
        <h3 className="font-sans font-bold text-xl text-white tracking-tight">{intl.formatMessage(mCash.heading)}</h3>
        <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
          {txn.description} · {currency(txn.amount)}
        </p>
      </div>
      <div className="p-6 flex flex-col gap-4">
        <p className="text-[13px] text-zinc-400 leading-relaxed">
          {intl.formatMessage(mCash.body)}
        </p>
        <div>
          <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2.5">
            {intl.formatMessage(commonLabels.category)}
          </div>
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`px-3.5 py-2 rounded-full text-[13px] font-bold border transition-all ${
                  category === c
                    ? 'bg-brand text-white border-brand'
                    : 'bg-ground text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
                }`}
              >
                {c === '—' ? intl.formatMessage(mCash.decideLater) : c}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-3">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addCustom(); }}
              placeholder={intl.formatMessage(mCash.addCategoryPlaceholder)}
              maxLength={40}
              className="flex-1 bg-ground border border-white/5 rounded-full py-2 px-4 text-[13px] font-semibold text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-brand"
            />
            <button
              onClick={addCustom}
              disabled={!draft.trim()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-bold text-white bg-white/10 hover:bg-white/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus size={14} strokeWidth={3} />
              {intl.formatMessage(mCash.addAction)}
            </button>
          </div>
        </div>
      </div>
      <div className="p-4 bg-raised/50 flex justify-end">
        <button
          onClick={() => onConfirm(category)}
          className="flex items-center gap-2 px-6 py-2.5 text-sm font-bold text-white bg-brand hover:bg-brand-hover rounded-full transition-all"
        >
          <Check size={16} strokeWidth={3} />
          {intl.formatMessage(mCash.confirmAction)}
        </button>
      </div>
    </div>
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
        className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand transition-colors"
      />
    </div>
  );
}

function exportTxns(rows: BankTransaction[]) {
  const header = 'Client,Description,Date,Amount,Evidence,Type\n';
  const body = rows
    .map((t) => `"${t.clientName}","${t.description}","${t.date}",${t.amount},"${isMatched(t) ? 'matched' : 'none'}","${t.isCredit ? 'credit' : 'payment'}"`)
    .join('\n');
  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bank-transactions.csv';
  a.click();
  URL.revokeObjectURL(url);
}
