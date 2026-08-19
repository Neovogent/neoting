import { useMemo, useRef, useState } from 'react';
import {
  Search, FileText, FolderTree, AlertTriangle, UploadCloud, Trash2, ArrowRightLeft,
  Eye, Download, ChevronRight, ChevronDown, Archive, Lock, Building2, User,
  MoreHorizontal, X, RotateCcw,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import { useAppContext } from '../context/AppContext';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { DocumentPreview } from '../components/DynamicComponents/DocumentPreview';
import { Modal } from './ApprovalsView';
import { currency } from '../lib/resolver';
import { PRACTICE_NAME } from '../lib/seed2';
import type { Document, VaultDocument } from '../lib/types';
import { EXPORT_HINT } from '../lib/exportRules';
import { commonActions, commonLabels } from '../i18n/common';
import { DataSourceBadge } from '../components/DataSourceBadge';

const TABS = ['Archive', 'Vault'] as const;
type Tab = (typeof TABS)[number];

// The tab value is the shelf being looked at and is compared against, so it
// stays English. Only the word on the button is translated — descriptors here,
// formatted where the button renders, because no hook reaches module scope.
const TAB_LABEL: Record<Tab, MessageDescriptor> = defineMessages({
  Archive: { id: 'documents.documentsView.tabArchive', defaultMessage: 'Archive' },
  Vault: { id: 'documents.documentsView.tabVault', defaultMessage: 'Vault' },
});

const VAULT_CATEGORIES: VaultDocument['category'][] = [
  'Contracts', 'Leases', 'Insurance', 'Tax filings', 'Engagement letters', 'Payroll', 'Certificates',
];

/** What each vault shelf is called on screen. The union value itself is data. */
const VAULT_CATEGORY_LABEL: Record<VaultDocument['category'], MessageDescriptor> = defineMessages({
  Contracts: { id: 'documents.documentsView.categoryContracts', defaultMessage: 'Contracts' },
  Leases: { id: 'documents.documentsView.categoryLeases', defaultMessage: 'Leases' },
  Insurance: { id: 'documents.documentsView.categoryInsurance', defaultMessage: 'Insurance' },
  'Tax filings': { id: 'documents.documentsView.categoryTaxFilings', defaultMessage: 'Tax filings' },
  'Engagement letters': {
    id: 'documents.documentsView.categoryEngagementLetters',
    defaultMessage: 'Engagement letters',
  },
  Payroll: { id: 'documents.documentsView.categoryPayroll', defaultMessage: 'Payroll' },
  Certificates: { id: 'documents.documentsView.categoryCertificates', defaultMessage: 'Certificates' },
});

const m = defineMessages({
  heading: { id: 'documents.documentsView.heading', defaultMessage: 'Documents' },
  documentsLoading: { id: 'documents.documentsView.loading', defaultMessage: 'Loading documents…' },
  documentsError: { id: 'documents.documentsView.loadError', defaultMessage: 'Could not load documents — {error}' },
  summary: {
    id: 'documents.documentsView.summary',
    defaultMessage: '{archived} archived · {vault} in vault · {expiring} expiring',
  },
  searchArchive: {
    id: 'documents.documentsView.searchArchive',
    defaultMessage: 'Full-text search — try "avocado"',
  },
  searchVault: { id: 'documents.documentsView.searchVault', defaultMessage: 'Search vault...' },
  addToVault: { id: 'documents.documentsView.addToVault', defaultMessage: 'Add to vault' },
  addToVaultAudit: { id: 'documents.documentsView.addToVaultAudit', defaultMessage: 'Added vault document' },

  columnSource: { id: 'documents.documentsView.columnSource', defaultMessage: 'Source' },
  columnUploader: { id: 'documents.documentsView.columnUploader', defaultMessage: 'Uploader' },

  unarchiveAction: { id: 'documents.documentsView.unarchiveAction', defaultMessage: 'Unarchive' },
  unarchiveTitle: {
    id: 'documents.documentsView.unarchiveTitle',
    defaultMessage: '{count, plural, one {Unarchive # document?} other {Unarchive # documents?}}',
  },
  unarchiveDetail: {
    id: 'documents.documentsView.unarchiveDetail',
    defaultMessage: 'They return to Ready and leave the archive.',
  },
  unarchiveConsequence: {
    id: 'documents.documentsView.unarchiveConsequence',
    defaultMessage: 'Their publishing data is cleared — the ledger keeps whatever was already posted.',
  },
  unarchiveConfirm: { id: 'documents.documentsView.unarchiveConfirm', defaultMessage: 'Yes, unarchive' },
  unarchiveAudit: { id: 'documents.documentsView.unarchiveAudit', defaultMessage: 'Unarchived documents' },
  unarchiveAuditScope: {
    id: 'documents.documentsView.unarchiveAuditScope',
    defaultMessage: '{count} item(s) — publishing data cleared',
  },
  moveToClientAction: { id: 'documents.documentsView.moveToClientAction', defaultMessage: 'Move to client' },

  filterAllClients: { id: 'documents.documentsView.filterAllClients', defaultMessage: 'All clients' },
  filterAllCategories: { id: 'documents.documentsView.filterAllCategories', defaultMessage: 'All categories' },
  filterAllChannels: { id: 'documents.documentsView.filterAllChannels', defaultMessage: 'All channels' },
  groupByClient: { id: 'documents.documentsView.groupByClient', defaultMessage: 'Group by client' },
  filterAllYears: { id: 'documents.documentsView.filterAllYears', defaultMessage: 'All years' },
  filterAnyOwner: { id: 'documents.documentsView.filterAnyOwner', defaultMessage: 'Any owner' },
  filterFirmOwned: { id: 'documents.documentsView.filterFirmOwned', defaultMessage: 'Firm-owned — {practice}' },
  filterOwnedBy: { id: 'documents.documentsView.filterOwnedBy', defaultMessage: 'Owned by {owner}' },
  filterAnyExpiry: { id: 'documents.documentsView.filterAnyExpiry', defaultMessage: 'Any expiry' },
  filterExpiringSoon: { id: 'documents.documentsView.filterExpiringSoon', defaultMessage: 'Expiring soon ({count})' },
  filterExpired: { id: 'documents.documentsView.filterExpired', defaultMessage: 'Expired ({count})' },
  filterNoExpiry: { id: 'documents.documentsView.filterNoExpiry', defaultMessage: 'No expiry date' },
  filterAnyVisibility: { id: 'documents.documentsView.filterAnyVisibility', defaultMessage: 'Any visibility' },
  filterPracticeOnly: { id: 'documents.documentsView.filterPracticeOnly', defaultMessage: 'Practice only' },
  filterClientVisible: { id: 'documents.documentsView.filterClientVisible', defaultMessage: 'Client visible' },
  filterAnyTag: { id: 'documents.documentsView.filterAnyTag', defaultMessage: 'Any tag' },
  filterTag: { id: 'documents.documentsView.filterTag', defaultMessage: '#{tag}' },
  clearFilters: { id: 'documents.documentsView.clearFilters', defaultMessage: 'Clear' },

  archiveEmptySearch: {
    id: 'documents.documentsView.archiveEmptySearch',
    defaultMessage: 'Nothing in the archive matches that phrase.',
  },
  archiveEmpty: {
    id: 'documents.documentsView.archiveEmpty',
    defaultMessage: 'Nothing archived yet — items land here once published.',
  },
  archiveEmptyFiltered: {
    id: 'documents.documentsView.archiveEmptyFiltered',
    defaultMessage: 'Nothing in the archive matches those filters.',
  },
  archiveEmptyForClient: {
    id: 'documents.documentsView.archiveEmptyForClient',
    defaultMessage: 'Nothing archived for this client.',
  },
  archiveFooter: {
    id: 'documents.documentsView.archiveFooter',
    defaultMessage: '{count} archived • searches every extracted field and line item',
  },
  unassignedClient: { id: 'documents.documentsView.unassignedClient', defaultMessage: 'Unassigned' },
  groupCount: { id: 'documents.documentsView.groupCount', defaultMessage: '{count} documents' },

  vaultTree: {
    id: 'documents.documentsView.vaultTree',
    defaultMessage: 'Firm → Client → Financial year → Category',
  },
  vaultEmptyFiltered: {
    id: 'documents.documentsView.vaultEmptyFiltered',
    defaultMessage: 'Nothing in the vault matches those filters.',
  },

  moveHeading: { id: 'documents.documentsView.moveHeading', defaultMessage: 'Move to another entity' },
  moveCount: {
    id: 'documents.documentsView.moveCount',
    defaultMessage: '{count, plural, one {# item} other {# items}}',
  },
  moveWarning: {
    id: 'documents.documentsView.moveWarning',
    defaultMessage: 'Check the addressee matches before moving',
  },
  moveAudit: { id: 'documents.documentsView.moveAudit', defaultMessage: 'Moved between entities' },
  moveAuditScope: { id: 'documents.documentsView.moveAuditScope', defaultMessage: '{count} item(s) → {client}' },

  ownerAudit: { id: 'documents.documentsView.ownerAudit', defaultMessage: 'Changed vault file owner' },
  ownerAuditScope: { id: 'documents.documentsView.ownerAuditScope', defaultMessage: '{name} → {owner}' },

  deleteTitle: { id: 'documents.documentsView.deleteTitle', defaultMessage: 'Delete "{name}"?' },
  deleteDetail: { id: 'documents.documentsView.deleteDetail', defaultMessage: '{category} · owned by {owner}.' },
  deleteConsequenceProtected: {
    id: 'documents.documentsView.deleteConsequenceProtected',
    defaultMessage:
      'This is a permanent or statutory record — it should normally be kept for the life of the company.',
  },
  deleteConsequence: {
    id: 'documents.documentsView.deleteConsequence',
    defaultMessage: 'The file goes for good; the vault holds no second copy.',
  },
  deleteConfirm: { id: 'documents.documentsView.deleteConfirm', defaultMessage: 'Yes, delete it' },
  deleteAudit: { id: 'documents.documentsView.deleteAudit', defaultMessage: 'Deleted vault document' },
});

type ExpiryFilter = 'all' | 'expiring' | 'expired' | 'none';

export function DocumentsView() {
  const {
    documents, vault, clients, updateDocumentStatus, moveDocuments, addVaultDocument,
    updateVaultDocument, deleteVaultDocument, moveVaultDocument, logAudit,
    documentsSource, documentsLoading, documentsError, slices,
  } = useAppContext();

  const [tab, setTab] = useState<Tab>('Archive');
  const confirm = useConfirm();
  const intl = useIntl();
  const [query, setQuery] = useState('');
  const [clientFilter, setClientFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [yearFilter, setYearFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [accessFilter, setAccessFilter] = useState('all');
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [groupByClient, setGroupByClient] = useState(true);

  const [preview, setPreview] = useState<Document | null>(null);
  const [vaultPreview, setVaultPreview] = useState<VaultDocument | null>(null);
  const [expanded, setExpanded] = useState<string[]>([clients[0]?.id ?? '']);
  const [moveTarget, setMoveTarget] = useState<{ ids: string[]; kind: 'doc' | 'vault' } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Archive = processed historical evidence. Full-text, not just supplier search. */
  const archived = useMemo(() => {
    const q = query.trim().toLowerCase();
    return documents.filter((d) => {
      if (d.status !== 'published') return false;
      if (clientFilter !== 'all' && d.clientId !== clientFilter) return false;
      if (categoryFilter !== 'all' && d.category !== categoryFilter) return false;
      if (sourceFilter !== 'all' && d.source !== sourceFilter) return false;
      if (!q) return true;
      const haystack = [
        d.supplier, d.clientName, d.category, d.uploader, d.source, String(d.total),
        ...d.fields.map((f) => `${f.label} ${f.value}`),
        ...d.lineItems.map((l) => l.description),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [documents, query, clientFilter, categoryFilter, sourceFilter]);

  const vaultDocs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return vault.filter((v) => {
      if (clientFilter !== 'all' && v.clientId !== clientFilter) return false;
      if (categoryFilter !== 'all' && v.category !== categoryFilter) return false;
      if (yearFilter !== 'all' && v.financialYear !== yearFilter) return false;
      if (accessFilter !== 'all' && v.access !== accessFilter) return false;
      if (tagFilter !== 'all' && !v.tags.includes(tagFilter)) return false;
      if (ownerFilter === 'firm' && v.ownerKind !== 'firm') return false;
      if (ownerFilter !== 'all' && ownerFilter !== 'firm' && v.ownerName !== ownerFilter) return false;
      if (expiryFilter === 'none' && v.daysToExpiry !== undefined) return false;
      if (expiryFilter === 'expired' && !(v.daysToExpiry !== undefined && v.daysToExpiry <= 0)) return false;
      if (expiryFilter === 'expiring' && !(v.daysToExpiry !== undefined && v.daysToExpiry > 0 && v.daysToExpiry <= 14)) return false;
      if (!q) return true;
      return `${v.name} ${v.summary} ${v.tags.join(' ')} ${v.category} ${v.clientName} ${v.ownerName}`.toLowerCase().includes(q);
    });
  }, [vault, query, clientFilter, categoryFilter, yearFilter, accessFilter, tagFilter, ownerFilter, expiryFilter]);

  const expiringCount = vault.filter((v) => v.daysToExpiry !== undefined && v.daysToExpiry <= 14).length;

  // Filter option lists, derived so they only ever offer what exists.
  const archiveCategories = useMemo(
    () => [...new Set(documents.filter((d) => d.status === 'published').map((d) => d.category))].filter(Boolean).sort(),
    [documents],
  );
  const archiveSources = useMemo(
    () => [...new Set(documents.filter((d) => d.status === 'published').map((d) => d.source))].sort(),
    [documents],
  );
  const vaultYears = useMemo(() => [...new Set(vault.map((v) => v.financialYear))].sort(), [vault]);
  const vaultTags = useMemo(() => [...new Set(vault.flatMap((v) => v.tags))].sort(), [vault]);
  const vaultOwners = useMemo(
    () => [...new Set(vault.filter((v) => v.ownerKind === 'accountant').map((v) => v.ownerName))].sort(),
    [vault],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, Map<string, VaultDocument[]>>();
    vaultDocs.forEach((v) => {
      if (!map.has(v.clientId)) map.set(v.clientId, new Map());
      const years = map.get(v.clientId)!;
      const key = v.financialYear;
      if (!years.has(key)) years.set(key, []);
      years.get(key)!.push(v);
    });
    return map;
  }, [vaultDocs]);

  /** Archive rows filed under their client, which is how a practice thinks. */
  const archiveByClient = useMemo(() => {
    const map = new Map<string, Document[]>();
    archived.forEach((d) => {
      if (!map.has(d.clientId)) map.set(d.clientId, []);
      map.get(d.clientId)!.push(d);
    });
    return map;
  }, [archived]);

  const filtersActive =
    clientFilter !== 'all' || categoryFilter !== 'all' || sourceFilter !== 'all' || yearFilter !== 'all' ||
    ownerFilter !== 'all' || accessFilter !== 'all' || expiryFilter !== 'all' || tagFilter !== 'all' || query !== '';

  /**
   * While a filter is on, every group holding a match is open. Leaving them
   * collapsed makes a working filter look like it found nothing.
   */
  const isOpen = (clientId: string) => filtersActive || expanded.includes(clientId);

  const resetFilters = () => {
    setQuery(''); setClientFilter('all'); setCategoryFilter('all'); setSourceFilter('all');
    setYearFilter('all'); setOwnerFilter('all'); setAccessFilter('all'); setExpiryFilter('all'); setTagFilter('all');
  };

  const archiveColumns: Column<Document>[] = [
    { key: 'supplier', label: intl.formatMessage(commonLabels.supplier), sortValue: (d) => d.supplier, render: (d) => <span className="text-white font-semibold">{d.supplier}</span> },
    ...(groupByClient ? [] : [{ key: 'clientName', label: intl.formatMessage(commonLabels.client), sortValue: (d: Document) => d.clientName }]),
    { key: 'date', label: intl.formatMessage(commonLabels.date), sortValue: (d) => d.date },
    { key: 'category', label: intl.formatMessage(commonLabels.category), sortValue: (d) => d.category },
    { key: 'source', label: intl.formatMessage(m.columnSource), sortValue: (d) => d.source, render: (d) => <Pill>{d.source}</Pill> },
    { key: 'uploader', label: intl.formatMessage(m.columnUploader), sortValue: (d) => d.uploader },
    { key: 'total', label: intl.formatMessage(commonLabels.total), align: 'right', sortValue: (d) => d.total, render: (d) => <span className="text-white font-bold tabular-nums">{currency(d.total)}</span> },
  ];

  /**
   * Unarchive and move are local flips the live poll reverts — off live rows
   * (METH S14 sweep); a published document is locked server-side anyway. The
   * client-side export is real either way.
   */
  const syntheticArchiveActions = [
    {
      label: intl.formatMessage(m.unarchiveAction),
      icon: Archive,
      onClick: async (sel: Document[]) => {
        const ok = await confirm({
          tone: 'red',
          title: intl.formatMessage(m.unarchiveTitle, { count: sel.length }),
          detail: intl.formatMessage(m.unarchiveDetail),
          consequence: intl.formatMessage(m.unarchiveConsequence),
          confirmLabel: intl.formatMessage(m.unarchiveConfirm),
        });
        if (!ok) return;
        sel.forEach((d) => updateDocumentStatus(d.id, 'ready'));
        logAudit({
          action: intl.formatMessage(m.unarchiveAudit),
          scope: intl.formatMessage(m.unarchiveAuditScope, { count: sel.length }),
          reviewOpened: true,
        });
      },
    },
    { label: intl.formatMessage(m.moveToClientAction), icon: ArrowRightLeft, onClick: (sel: Document[]) => setMoveTarget({ ids: sel.map((d) => d.id), kind: 'doc' as const }) },
  ];

  const exportAction = { label: intl.formatMessage(commonActions.exportCsv), icon: Download, primary: true, minSelected: 2, disabledHint: intl.formatMessage(EXPORT_HINT), onClick: (sel: Document[]) => exportDocs(sel) };

  const archiveActions =
    documentsSource === 'api' ? [exportAction] : [...syntheticArchiveActions, exportAction];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-hidden">
      <header className="px-10 pt-8 pb-5 shrink-0">
        {/* Loading and failure said out loud (METH S14 sweep): seed rows may
            render underneath — the standing fallback — never silently. */}
        {documentsSource === 'api' && (documentsLoading || documentsError) && (
          <div
            className={`mb-4 flex items-center gap-3 px-5 py-3 rounded-2xl border text-[13px] font-semibold ${
              documentsError
                ? 'bg-red-500/10 border-red-500/20 text-red-300'
                : 'bg-white/[0.03] border-white/10 text-zinc-400'
            }`}
          >
            <AlertTriangle size={15} className="shrink-0" />
            <span className="min-w-0">
              {documentsError
                ? intl.formatMessage(m.documentsError, { error: documentsError })
                : intl.formatMessage(m.documentsLoading)}
            </span>
            <DataSourceBadge slice="documents" status={slices.documents} />
          </div>
        )}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white border border-white/5 shadow-inner">
              <FileText size={22} />
            </div>
            <div>
              <h1 className="font-sans text-3xl font-semibold text-white tracking-tight">{intl.formatMessage(m.heading)}</h1>
              <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                {intl.formatMessage(m.summary, {
                  archived: archived.length,
                  vault: vault.length,
                  expiring: expiringCount,
                })}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={intl.formatMessage(tab === 'Archive' ? m.searchArchive : m.searchVault)}
                className="w-72 bg-card border border-white/5 rounded-full py-2.5 pl-11 pr-4 text-sm focus:outline-none focus:border-brand placeholder:text-zinc-600 text-white font-medium shadow-inner"
              />
            </div>
            {tab === 'Vault' && (
              <>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-2 px-6 py-2.5 bg-brand text-white text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-glow-btn-soft"
                >
                  <UploadCloud size={16} />
                  {intl.formatMessage(m.addToVault)}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    const target = clientFilter === 'all' ? clients[0]?.id : clientFilter;
                    if (f && target) {
                      addVaultDocument(target, 'Contracts', f.name, Math.round(f.size / 1024));
                      logAudit({ action: intl.formatMessage(m.addToVaultAudit), scope: f.name, reviewOpened: true });
                    }
                    e.target.value = '';
                  }}
                />
              </>
            )}
          </div>
        </div>
      </header>

      <div className="px-10 pb-4 flex items-center gap-2 shrink-0">
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
            {intl.formatMessage(TAB_LABEL[t])}
          </button>
        ))}
      </div>

      {/* Filters. Every file is filed under a client, so that one is always
          offered; the rest follow whichever shelf you are looking at. */}
      <div className="px-10 pb-5 flex items-center gap-2 flex-wrap shrink-0">
        <FilterSelect
          value={clientFilter}
          onChange={setClientFilter}
          options={[{ value: 'all', label: intl.formatMessage(m.filterAllClients) }, ...clients.map((c) => ({ value: c.id, label: c.name }))]}
        />
        <FilterSelect
          value={categoryFilter}
          onChange={setCategoryFilter}
          options={[
            { value: 'all', label: intl.formatMessage(m.filterAllCategories) },
            // Archive categories come off the documents themselves, so they are
            // data; the vault's shelves are a fixed list, so they are copy.
            ...(tab === 'Archive'
              ? archiveCategories.map((c) => ({ value: c, label: c }))
              : VAULT_CATEGORIES.map((c) => ({ value: c, label: intl.formatMessage(VAULT_CATEGORY_LABEL[c]) }))),
          ]}
        />

        {tab === 'Archive' ? (
          <>
            <FilterSelect
              value={sourceFilter}
              onChange={setSourceFilter}
              options={[{ value: 'all', label: intl.formatMessage(m.filterAllChannels) }, ...archiveSources.map((s) => ({ value: s, label: s }))]}
            />
            <button
              onClick={() => setGroupByClient((g) => !g)}
              className={`px-4 py-2 rounded-full text-[13px] font-bold border transition-all ${
                groupByClient ? 'bg-brand/10 text-brand border-brand/30' : 'bg-card text-zinc-400 border-white/5 hover:text-white'
              }`}
            >
              {intl.formatMessage(m.groupByClient)}
            </button>
          </>
        ) : (
          <>
            <FilterSelect
              value={yearFilter}
              onChange={setYearFilter}
              options={[{ value: 'all', label: intl.formatMessage(m.filterAllYears) }, ...vaultYears.map((y) => ({ value: y, label: y }))]}
            />
            <FilterSelect
              value={ownerFilter}
              onChange={setOwnerFilter}
              options={[
                { value: 'all', label: intl.formatMessage(m.filterAnyOwner) },
                { value: 'firm', label: intl.formatMessage(m.filterFirmOwned, { practice: PRACTICE_NAME }) },
                ...vaultOwners.map((o) => ({ value: o, label: intl.formatMessage(m.filterOwnedBy, { owner: o }) })),
              ]}
            />
            <FilterSelect
              value={expiryFilter}
              onChange={(v) => setExpiryFilter(v as ExpiryFilter)}
              options={[
                { value: 'all', label: intl.formatMessage(m.filterAnyExpiry) },
                {
                  value: 'expiring',
                  label: intl.formatMessage(m.filterExpiringSoon, {
                    count: vault.filter((v) => v.daysToExpiry !== undefined && v.daysToExpiry > 0 && v.daysToExpiry <= 14).length,
                  }),
                },
                {
                  value: 'expired',
                  label: intl.formatMessage(m.filterExpired, {
                    count: vault.filter((v) => v.daysToExpiry !== undefined && v.daysToExpiry <= 0).length,
                  }),
                },
                { value: 'none', label: intl.formatMessage(m.filterNoExpiry) },
              ]}
            />
            <FilterSelect
              value={accessFilter}
              onChange={setAccessFilter}
              options={[
                { value: 'all', label: intl.formatMessage(m.filterAnyVisibility) },
                { value: 'practice', label: intl.formatMessage(m.filterPracticeOnly) },
                { value: 'client-visible', label: intl.formatMessage(m.filterClientVisible) },
              ]}
            />
            <FilterSelect
              value={tagFilter}
              onChange={setTagFilter}
              options={[
                { value: 'all', label: intl.formatMessage(m.filterAnyTag) },
                ...vaultTags.map((t) => ({ value: t, label: intl.formatMessage(m.filterTag, { tag: t }) })),
              ]}
            />
          </>
        )}

        {filtersActive && (
          <button
            onClick={resetFilters}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-500 hover:text-white transition-colors"
          >
            <RotateCcw size={13} />
            {intl.formatMessage(m.clearFilters)}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-10 pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {tab === 'Archive' && !groupByClient && (
            <DataTable<Document>
              className="max-w-none"
              columns={archiveColumns}
              rows={archived}
              rowId={(d) => d.id}
              selectable
              onRowClick={(d) => setPreview(d)}
              emptyMessage={intl.formatMessage(query ? m.archiveEmptySearch : m.archiveEmpty)}
              bulkActions={archiveActions}
              footer={intl.formatMessage(m.archiveFooter, { count: archived.length })}
            />
          )}

          {tab === 'Archive' && groupByClient && (
            <div className="flex flex-col gap-4">
              {[...archiveByClient.entries()].map(([clientId, docs]) => {
                const client = clients.find((c) => c.id === clientId);
                const open = isOpen(clientId);
                return (
                  <div key={clientId} className="border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
                    <button
                      onClick={() => setExpanded((p) => (p.includes(clientId) ? p.filter((x) => x !== clientId) : [...p, clientId]))}
                      className="w-full p-5 flex items-center gap-4 hover:bg-white/[0.02] transition-colors text-left"
                    >
                      {open ? <ChevronDown size={18} className="text-zinc-500" /> : <ChevronRight size={18} className="text-zinc-500" />}
                      <div className="w-10 h-10 rounded-xl bg-raised border border-white/5 flex items-center justify-center font-bold text-white shrink-0 overflow-hidden">
                        {client?.logoDataUrl ? <img src={client.logoDataUrl} alt="" className="w-full h-full object-cover" /> : client?.name.charAt(0)}
                      </div>
                      <span className="font-sans font-bold text-lg text-white tracking-tight">
                        {client?.name ?? intl.formatMessage(m.unassignedClient)}
                      </span>
                      <span className="ml-auto text-[12px] text-zinc-600 font-semibold">
                        {intl.formatMessage(m.groupCount, { count: docs.length })}
                      </span>
                    </button>
                    {open && (
                      <div className="border-t border-white/5 p-4">
                        <DataTable<Document>
                          className="max-w-none"
                          columns={archiveColumns}
                          rows={docs}
                          rowId={(d) => d.id}
                          selectable
                          onRowClick={(d) => setPreview(d)}
                          emptyMessage={intl.formatMessage(m.archiveEmptyForClient)}
                          bulkActions={archiveActions}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
              {archiveByClient.size === 0 && (
                <div className="border border-white/5 rounded-[32px] bg-card p-10 text-center text-zinc-500">
                  {intl.formatMessage(query || filtersActive ? m.archiveEmptyFiltered : m.archiveEmpty)}
                </div>
              )}
            </div>
          )}

          {tab === 'Vault' && (
            <div className="flex flex-col gap-4">
              <div className="text-[12px] text-zinc-500 font-semibold flex items-center gap-2">
                <FolderTree size={14} />
                {intl.formatMessage(m.vaultTree)}
              </div>

              {[...grouped.entries()].map(([clientId, years]) => {
                const client = clients.find((c) => c.id === clientId);
                const open = isOpen(clientId);
                const count = [...years.values()].reduce((n, list) => n + list.length, 0);
                return (
                  <div key={clientId} className="border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
                    <button
                      onClick={() => setExpanded((p) => (p.includes(clientId) ? p.filter((x) => x !== clientId) : [...p, clientId]))}
                      className="w-full p-5 flex items-center gap-4 hover:bg-white/[0.02] transition-colors text-left"
                    >
                      {open ? <ChevronDown size={18} className="text-zinc-500" /> : <ChevronRight size={18} className="text-zinc-500" />}
                      <div className="w-10 h-10 rounded-xl bg-raised border border-white/5 flex items-center justify-center font-bold text-white shrink-0 overflow-hidden">
                        {client?.logoDataUrl ? <img src={client.logoDataUrl} alt="" className="w-full h-full object-cover" /> : client?.name.charAt(0)}
                      </div>
                      <span className="font-sans font-bold text-lg text-white tracking-tight">{client?.name}</span>
                      <span className="ml-auto text-[12px] text-zinc-600 font-semibold">
                        {intl.formatMessage(m.groupCount, { count })}
                      </span>
                    </button>

                    {open && (
                      <div className="border-t border-white/5">
                        {[...years.entries()].map(([year, docs]) => (
                          <div key={year} className="px-5 py-4 border-b border-white/5 last:border-0">
                            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">{year}</div>
                            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                              {VAULT_CATEGORIES.filter((cat) => docs.some((d) => d.category === cat)).map((cat) => (
                                <div key={cat} className="rounded-2xl bg-ground/60 border border-white/5 p-4">
                                  <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2.5">
                                    {intl.formatMessage(VAULT_CATEGORY_LABEL[cat])}
                                  </div>
                                  <div className="flex flex-col gap-2.5">
                                    {docs.filter((d) => d.category === cat).map((d) => (
                                      <VaultFileRow key={d.id} doc={d} onPreview={() => setVaultPreview(d)} />
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {grouped.size === 0 && (
                <div className="border border-white/5 rounded-[32px] bg-card p-10 text-center text-zinc-500">
                  {intl.formatMessage(m.vaultEmptyFiltered)}
                </div>
              )}
            </div>
          )}
        </motion.div>
      </div>

      <AnimatePresence>
        {preview && (
          <Modal onClose={() => setPreview(null)}>
            <DocumentPreview document={documents.find((d) => d.id === preview.id) ?? preview} />
          </Modal>
        )}

        {vaultPreview && (
          <Modal onClose={() => setVaultPreview(null)}>
            <VaultPreview
              doc={vault.find((v) => v.id === vaultPreview.id) ?? vaultPreview}
              onMove={() => setMoveTarget({ ids: [vaultPreview.id], kind: 'vault' })}
              onSetOwner={(kind, name) => {
                updateVaultDocument(vaultPreview.id, { ownerKind: kind, ownerName: name });
                logAudit({
                  action: intl.formatMessage(m.ownerAudit),
                  scope: intl.formatMessage(m.ownerAuditScope, { name: vaultPreview.name, owner: name }),
                  reviewOpened: true,
                });
              }}
              onDelete={async () => {
                const ok = await confirm({
                  tone: 'red',
                  title: intl.formatMessage(m.deleteTitle, { name: vaultPreview.name }),
                  detail: intl.formatMessage(m.deleteDetail, {
                    category: intl.formatMessage(VAULT_CATEGORY_LABEL[vaultPreview.category]),
                    owner: vaultPreview.ownerName,
                  }),
                  consequence: intl.formatMessage(
                    vaultPreview.tags.includes('permanent') || vaultPreview.tags.includes('statutory')
                      ? m.deleteConsequenceProtected
                      : m.deleteConsequence,
                  ),
                  confirmLabel: intl.formatMessage(m.deleteConfirm),
                });
                if (!ok) return;
                deleteVaultDocument(vaultPreview.id);
                logAudit({ action: intl.formatMessage(m.deleteAudit), scope: vaultPreview.name, reviewOpened: true });
                setVaultPreview(null);
              }}
            />
          </Modal>
        )}

        {moveTarget && (
          <Modal onClose={() => setMoveTarget(null)}>
            <div className="w-full max-w-md border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
              <div className="p-6 border-b border-white/5">
                <h3 className="font-sans font-bold text-xl text-white tracking-tight">{intl.formatMessage(m.moveHeading)}</h3>
                <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                  {intl.formatMessage(m.moveCount, { count: moveTarget.ids.length })}
                </p>
              </div>
              <div className="p-4 flex flex-col gap-1">
                {clients.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      if (moveTarget.kind === 'doc') moveDocuments(moveTarget.ids, c.id);
                      else moveTarget.ids.forEach((id) => moveVaultDocument(id, c.id));
                      logAudit({
                        action: intl.formatMessage(m.moveAudit),
                        scope: intl.formatMessage(m.moveAuditScope, { count: moveTarget.ids.length, client: c.name }),
                        reviewOpened: true,
                      });
                      setMoveTarget(null);
                      setVaultPreview(null);
                    }}
                    className="px-4 py-3 rounded-2xl text-left hover:bg-white/5 transition-colors"
                  >
                    <div className="text-sm font-bold text-white">{c.name}</div>
                    <div className="text-[12px] text-amber-400 mt-0.5">{intl.formatMessage(m.moveWarning)}</div>
                  </button>
                ))}
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

const rowMessages = defineMessages({
  ownedByPractice: { id: 'documents.vaultFileRow.ownedByPractice', defaultMessage: 'Owned by the practice' },
  ownedBy: { id: 'documents.vaultFileRow.ownedBy', defaultMessage: 'Owned by {owner}' },
  firm: { id: 'documents.vaultFileRow.firm', defaultMessage: 'Firm' },
  expired: { id: 'documents.vaultFileRow.expired', defaultMessage: 'Expired' },
  daysLeft: { id: 'documents.vaultFileRow.daysLeft', defaultMessage: '{days}d' },
  tag: { id: 'documents.vaultFileRow.tag', defaultMessage: '#{tag}' },
  previewLabel: { id: 'documents.vaultFileRow.previewLabel', defaultMessage: 'Preview {name}' },
  preview: { id: 'documents.vaultFileRow.preview', defaultMessage: 'Preview' },
});

/** One file in the vault, with the same explicit preview the archive offers. */
function VaultFileRow({ doc, onPreview }: { doc: VaultDocument; onPreview: () => void }) {
  const intl = useIntl();

  return (
    <div className="group/item flex items-start gap-2">
      <button onClick={onPreview} className="text-left min-w-0 flex-1" title={doc.summary}>
        <div className="text-[13px] font-bold text-white group-hover/item:text-brand transition-colors truncate">
          {doc.name.replace(` — ${doc.clientName}`, '')}
        </div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-md border ${
              doc.ownerKind === 'firm'
                ? 'text-zinc-400 border-white/10 bg-white/[0.03]'
                : 'text-brand border-brand/25 bg-brand/10'
            }`}
            title={
              doc.ownerKind === 'firm'
                ? intl.formatMessage(rowMessages.ownedByPractice)
                : intl.formatMessage(rowMessages.ownedBy, { owner: doc.ownerName })
            }
          >
            {doc.ownerKind === 'firm' ? <Building2 size={9} /> : <User size={9} />}
            {doc.ownerKind === 'firm' ? intl.formatMessage(rowMessages.firm) : doc.ownerName}
          </span>
          {doc.daysToExpiry !== undefined && (
            <span className={`text-[10px] font-bold ${doc.daysToExpiry <= 0 ? 'text-red-400' : doc.daysToExpiry <= 14 ? 'text-amber-400' : 'text-zinc-600'}`}>
              {doc.daysToExpiry <= 0
                ? intl.formatMessage(rowMessages.expired)
                : intl.formatMessage(rowMessages.daysLeft, { days: doc.daysToExpiry })}
            </span>
          )}
          {doc.access === 'practice' && <Lock size={10} className="text-zinc-600" />}
          {doc.tags.slice(0, 2).map((t) => (
            <span key={t} className="text-[10px] text-zinc-600 font-semibold">
              {intl.formatMessage(rowMessages.tag, { tag: t })}
            </span>
          ))}
        </div>
      </button>
      <button
        onClick={onPreview}
        aria-label={intl.formatMessage(rowMessages.previewLabel, { name: doc.name })}
        title={intl.formatMessage(rowMessages.preview)}
        className="shrink-0 w-7 h-7 rounded-lg border border-white/5 text-zinc-500 hover:text-white hover:border-white/20 flex items-center justify-center transition-colors"
      >
        <Eye size={13} />
      </button>
    </div>
  );
}

const previewMessages = defineMessages({
  meta: { id: 'documents.vaultPreview.meta', defaultMessage: '{client} · {category} · {year} · {size}KB' },
  tag: { id: 'documents.vaultPreview.tag', defaultMessage: '#{tag}' },
  practiceOnly: { id: 'documents.vaultPreview.practiceOnly', defaultMessage: 'Practice only' },
  clientVisible: { id: 'documents.vaultPreview.clientVisible', defaultMessage: 'Client visible' },
  ownedBy: { id: 'documents.vaultPreview.ownedBy', defaultMessage: 'Owned by' },
  theFirm: { id: 'documents.vaultPreview.theFirm', defaultMessage: 'The firm' },
  ownershipNote: {
    id: 'documents.vaultPreview.ownershipNote',
    defaultMessage:
      'Firm-owned files stay with the practice. A file owned by one accountant follows their engagement.',
  },
  rowOwner: { id: 'documents.vaultPreview.rowOwner', defaultMessage: 'Owner' },
  rowUploader: { id: 'documents.vaultPreview.rowUploader', defaultMessage: 'Uploader' },
  rowSource: { id: 'documents.vaultPreview.rowSource', defaultMessage: 'Source' },
  rowUploaded: { id: 'documents.vaultPreview.rowUploaded', defaultMessage: 'Uploaded' },
  rowKeyDate: { id: 'documents.vaultPreview.rowKeyDate', defaultMessage: 'Key date' },
  expiredNote: {
    id: 'documents.vaultPreview.expiredNote',
    defaultMessage: 'This document has expired. A reminder was raised when the key date passed.',
  },
  expiringNote: {
    id: 'documents.vaultPreview.expiringNote',
    defaultMessage: 'Expires in {days} days — reminder already set from the extracted key date.',
  },
  confirmDelete: {
    id: 'documents.vaultPreview.confirmDelete',
    defaultMessage: 'Delete “{name}” permanently? This cannot be undone.',
  },
  deletePermanently: { id: 'documents.vaultPreview.deletePermanently', defaultMessage: 'Delete permanently' },
  moreActions: { id: 'documents.vaultPreview.moreActions', defaultMessage: 'More actions' },
  deleteFile: { id: 'documents.vaultPreview.deleteFile', defaultMessage: 'Delete file…' },
  moveToClient: { id: 'documents.vaultPreview.moveToClient', defaultMessage: 'Move to client' },
});

/**
 * Vault file detail. Deleting is deliberately two steps behind a menu — an
 * engagement letter removed by a stray click is not recoverable.
 */
function VaultPreview({
  doc,
  onMove,
  onSetOwner,
  onDelete,
}: {
  doc: VaultDocument;
  onMove: () => void;
  onSetOwner: (kind: VaultDocument['ownerKind'], name: string) => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const intl = useIntl();

  return (
    <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
      <div className="p-6 border-b border-white/5">
        <h3 className="font-sans font-bold text-xl text-white tracking-tight">{doc.name}</h3>
        <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
          {intl.formatMessage(previewMessages.meta, {
            client: doc.clientName,
            category: intl.formatMessage(VAULT_CATEGORY_LABEL[doc.category]),
            year: doc.financialYear,
            size: doc.sizeKb,
          })}
        </p>
      </div>

      <div className="p-6 flex flex-col gap-4">
        <p className="text-[13px] text-zinc-400 leading-relaxed">{doc.summary}</p>

        <div className="flex flex-wrap gap-2">
          {doc.tags.map((t) => <Pill key={t}>{intl.formatMessage(previewMessages.tag, { tag: t })}</Pill>)}
          {doc.access === 'practice'
            ? <Pill tone="amber">{intl.formatMessage(previewMessages.practiceOnly)}</Pill>
            : <Pill tone="blue">{intl.formatMessage(previewMessages.clientVisible)}</Pill>}
        </div>

        <div>
          <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
            {intl.formatMessage(previewMessages.ownedBy)}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onSetOwner('firm', PRACTICE_NAME)}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold border transition-all ${
                doc.ownerKind === 'firm'
                  ? 'bg-brand text-white border-brand'
                  : 'bg-ground text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
              }`}
            >
              <Building2 size={13} />
              {intl.formatMessage(previewMessages.theFirm)}
            </button>
            <button
              onClick={() => onSetOwner('accountant', doc.uploader)}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold border transition-all ${
                doc.ownerKind === 'accountant'
                  ? 'bg-brand text-white border-brand'
                  : 'bg-ground text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
              }`}
            >
              <User size={13} />
              {doc.uploader}
            </button>
          </div>
          <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">
            {intl.formatMessage(previewMessages.ownershipNote)}
          </p>
        </div>

        <div className="flex flex-col gap-2.5 text-[13px]">
          <Row label={intl.formatMessage(previewMessages.rowOwner)} value={doc.ownerName} />
          <Row label={intl.formatMessage(previewMessages.rowUploader)} value={doc.uploader} />
          <Row label={intl.formatMessage(previewMessages.rowSource)} value={doc.source} />
          <Row label={intl.formatMessage(previewMessages.rowUploaded)} value={doc.uploadedAt} />
          {doc.expiresOn && <Row label={intl.formatMessage(previewMessages.rowKeyDate)} value={doc.expiresOn} />}
        </div>

        {doc.daysToExpiry !== undefined && doc.daysToExpiry <= 14 && (
          <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 text-[13px] text-amber-200/90">
            <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
            {doc.daysToExpiry <= 0
              ? intl.formatMessage(previewMessages.expiredNote)
              : intl.formatMessage(previewMessages.expiringNote, { days: doc.daysToExpiry })}
          </div>
        )}
      </div>

      {confirming ? (
        <div className="p-4 bg-red-500/5 border-t border-red-500/20 flex items-center gap-3 justify-between flex-wrap">
          <p className="text-[12px] text-red-300 font-semibold min-w-0">
            {intl.formatMessage(previewMessages.confirmDelete, { name: doc.name })}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setConfirming(false)}
              className="px-4 py-2 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
            >
              {intl.formatMessage(commonActions.cancel)}
            </button>
            <button
              onClick={onDelete}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-white bg-red-500 hover:bg-red-600 transition-colors"
            >
              <Trash2 size={14} />
              {intl.formatMessage(previewMessages.deletePermanently)}
            </button>
          </div>
        </div>
      ) : (
        <div className="p-4 bg-raised/50 flex items-center gap-3 justify-end flex-wrap">
          <div className="relative mr-auto">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-label={intl.formatMessage(previewMessages.moreActions)}
              className="w-9 h-9 rounded-full border border-white/5 text-zinc-500 hover:text-white hover:border-white/20 flex items-center justify-center transition-colors"
            >
              {menuOpen ? <X size={15} /> : <MoreHorizontal size={16} />}
            </button>
            <AnimatePresence>
              {menuOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  className="absolute bottom-full left-0 mb-2 w-52 rounded-2xl border border-white/5 bg-card shadow-2xl p-1.5 z-10"
                >
                  <button
                    onClick={() => { setMenuOpen(false); setConfirming(true); }}
                    className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-[13px] font-semibold text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors text-left"
                  >
                    <Trash2 size={14} />
                    {intl.formatMessage(previewMessages.deleteFile)}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <button
            onClick={onMove}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
          >
            <ArrowRightLeft size={15} />
            {intl.formatMessage(previewMessages.moveToClient)}
          </button>
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const active = value !== 'all';
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`bg-card border rounded-full py-2 px-4 text-[13px] font-bold focus:outline-none focus:border-brand shadow-inner transition-colors ${
        active ? 'text-brand border-brand/30' : 'text-zinc-400 border-white/5'
      }`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-card text-white">
          {o.label}
        </option>
      ))}
    </select>
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

function exportDocs(rows: Document[]) {
  const header = 'Client,Supplier,Date,Total,Category,Source,Uploader\n';
  const body = rows.map((d) => `"${d.clientName}","${d.supplier}","${d.date}",${d.total},"${d.category}","${d.source}","${d.uploader}"`).join('\n');
  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'archive.csv';
  a.click();
  URL.revokeObjectURL(url);
}
