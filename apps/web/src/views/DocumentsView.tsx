import { useMemo, useRef, useState } from 'react';
import {
  Search, FileText, FolderTree, AlertTriangle, UploadCloud, Trash2, ArrowRightLeft,
  Eye, Download, ChevronRight, ChevronDown, Archive, Lock, Building2, User,
  MoreHorizontal, X, RotateCcw,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppContext } from '../context/AppContext';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { DocumentPreview } from '../components/DynamicComponents/DocumentPreview';
import { Modal } from './ApprovalsView';
import { currency } from '../lib/resolver';
import { PRACTICE_NAME } from '../lib/seed2';
import type { Document, VaultDocument } from '../lib/types';
import { EXPORT_HINT } from '../lib/exportRules';

const TABS = ['Archive', 'Vault'] as const;
type Tab = (typeof TABS)[number];

const VAULT_CATEGORIES: VaultDocument['category'][] = [
  'Contracts', 'Leases', 'Insurance', 'Tax filings', 'Engagement letters', 'Payroll', 'Certificates',
];

type ExpiryFilter = 'all' | 'expiring' | 'expired' | 'none';

export function DocumentsView() {
  const {
    documents, vault, clients, updateDocumentStatus, moveDocuments, addVaultDocument,
    updateVaultDocument, deleteVaultDocument, moveVaultDocument, logAudit,
  } = useAppContext();

  const [tab, setTab] = useState<Tab>('Archive');
  const confirm = useConfirm();
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
    { key: 'supplier', label: 'Supplier', sortValue: (d) => d.supplier, render: (d) => <span className="text-white font-semibold">{d.supplier}</span> },
    ...(groupByClient ? [] : [{ key: 'clientName', label: 'Client', sortValue: (d: Document) => d.clientName }]),
    { key: 'date', label: 'Date', sortValue: (d) => d.date },
    { key: 'category', label: 'Category', sortValue: (d) => d.category },
    { key: 'source', label: 'Source', sortValue: (d) => d.source, render: (d) => <Pill>{d.source}</Pill> },
    { key: 'uploader', label: 'Uploader', sortValue: (d) => d.uploader },
    { key: 'total', label: 'Total', align: 'right', sortValue: (d) => d.total, render: (d) => <span className="text-white font-bold tabular-nums">{currency(d.total)}</span> },
  ];

  const archiveActions = [
    {
      label: 'Unarchive',
      icon: Archive,
      onClick: async (sel: Document[]) => {
        const ok = await confirm({
          tone: 'red',
          title: `Unarchive ${sel.length} document${sel.length === 1 ? '' : 's'}?`,
          detail: 'They return to Ready and leave the archive.',
          consequence: 'Their publishing data is cleared — the ledger keeps whatever was already posted.',
          confirmLabel: 'Yes, unarchive',
        });
        if (!ok) return;
        sel.forEach((d) => updateDocumentStatus(d.id, 'ready'));
        logAudit({ action: 'Unarchived documents', scope: `${sel.length} item(s) — publishing data cleared`, reviewOpened: true });
      },
    },
    { label: 'Move to client', icon: ArrowRightLeft, onClick: (sel: Document[]) => setMoveTarget({ ids: sel.map((d) => d.id), kind: 'doc' as const }) },
    { label: 'Export CSV', icon: Download, primary: true, minSelected: 2, disabledHint: EXPORT_HINT, onClick: (sel: Document[]) => exportDocs(sel) },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#0a0a0c] h-full overflow-hidden">
      <header className="px-10 pt-8 pb-5 shrink-0">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-[#202026] flex items-center justify-center text-white border border-white/5 shadow-inner">
              <FileText size={22} />
            </div>
            <div>
              <h1 className="font-sans text-3xl font-semibold text-white tracking-tight">Documents</h1>
              <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                {archived.length} archived · {vault.length} in vault · {expiringCount} expiring
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tab === 'Archive' ? 'Full-text search — try "avocado"' : 'Search vault...'}
                className="w-72 bg-[#16161a] border border-white/5 rounded-full py-2.5 pl-11 pr-4 text-sm focus:outline-none focus:border-[#14e3c4] placeholder:text-zinc-600 text-white font-medium shadow-inner"
              />
            </div>
            {tab === 'Vault' && (
              <>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-2 px-6 py-2.5 bg-[#14e3c4] text-white text-sm font-bold rounded-full hover:bg-[#0fcbaf] transition-all shadow-[0_0_15px_rgba(20,227,196,0.2)]"
                >
                  <UploadCloud size={16} />
                  Add to vault
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
                      logAudit({ action: 'Added vault document', scope: f.name, reviewOpened: true });
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
                ? 'bg-[#14e3c4] text-white border-[#14e3c4] shadow-[0_0_12px_rgba(20,227,196,0.25)]'
                : 'bg-[#16161a] text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Filters. Every file is filed under a client, so that one is always
          offered; the rest follow whichever shelf you are looking at. */}
      <div className="px-10 pb-5 flex items-center gap-2 flex-wrap shrink-0">
        <FilterSelect
          value={clientFilter}
          onChange={setClientFilter}
          options={[{ value: 'all', label: 'All clients' }, ...clients.map((c) => ({ value: c.id, label: c.name }))]}
        />
        <FilterSelect
          value={categoryFilter}
          onChange={setCategoryFilter}
          options={[
            { value: 'all', label: 'All categories' },
            ...(tab === 'Archive' ? archiveCategories : VAULT_CATEGORIES).map((c) => ({ value: c, label: c })),
          ]}
        />

        {tab === 'Archive' ? (
          <>
            <FilterSelect
              value={sourceFilter}
              onChange={setSourceFilter}
              options={[{ value: 'all', label: 'All channels' }, ...archiveSources.map((s) => ({ value: s, label: s }))]}
            />
            <button
              onClick={() => setGroupByClient((g) => !g)}
              className={`px-4 py-2 rounded-full text-[13px] font-bold border transition-all ${
                groupByClient ? 'bg-[#14e3c4]/10 text-[#14e3c4] border-[#14e3c4]/30' : 'bg-[#16161a] text-zinc-400 border-white/5 hover:text-white'
              }`}
            >
              Group by client
            </button>
          </>
        ) : (
          <>
            <FilterSelect
              value={yearFilter}
              onChange={setYearFilter}
              options={[{ value: 'all', label: 'All years' }, ...vaultYears.map((y) => ({ value: y, label: y }))]}
            />
            <FilterSelect
              value={ownerFilter}
              onChange={setOwnerFilter}
              options={[
                { value: 'all', label: 'Any owner' },
                { value: 'firm', label: `Firm-owned — ${PRACTICE_NAME}` },
                ...vaultOwners.map((o) => ({ value: o, label: `Owned by ${o}` })),
              ]}
            />
            <FilterSelect
              value={expiryFilter}
              onChange={(v) => setExpiryFilter(v as ExpiryFilter)}
              options={[
                { value: 'all', label: 'Any expiry' },
                { value: 'expiring', label: `Expiring soon (${vault.filter((v) => v.daysToExpiry !== undefined && v.daysToExpiry > 0 && v.daysToExpiry <= 14).length})` },
                { value: 'expired', label: `Expired (${vault.filter((v) => v.daysToExpiry !== undefined && v.daysToExpiry <= 0).length})` },
                { value: 'none', label: 'No expiry date' },
              ]}
            />
            <FilterSelect
              value={accessFilter}
              onChange={setAccessFilter}
              options={[
                { value: 'all', label: 'Any visibility' },
                { value: 'practice', label: 'Practice only' },
                { value: 'client-visible', label: 'Client visible' },
              ]}
            />
            <FilterSelect
              value={tagFilter}
              onChange={setTagFilter}
              options={[{ value: 'all', label: 'Any tag' }, ...vaultTags.map((t) => ({ value: t, label: `#${t}` }))]}
            />
          </>
        )}

        {filtersActive && (
          <button
            onClick={resetFilters}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-500 hover:text-white transition-colors"
          >
            <RotateCcw size={13} />
            Clear
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
              emptyMessage={query ? 'Nothing in the archive matches that phrase.' : 'Nothing archived yet — items land here once published.'}
              bulkActions={archiveActions}
              footer={`${archived.length} archived • searches every extracted field and line item`}
            />
          )}

          {tab === 'Archive' && groupByClient && (
            <div className="flex flex-col gap-4">
              {[...archiveByClient.entries()].map(([clientId, docs]) => {
                const client = clients.find((c) => c.id === clientId);
                const open = isOpen(clientId);
                return (
                  <div key={clientId} className="border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
                    <button
                      onClick={() => setExpanded((p) => (p.includes(clientId) ? p.filter((x) => x !== clientId) : [...p, clientId]))}
                      className="w-full p-5 flex items-center gap-4 hover:bg-white/[0.02] transition-colors text-left"
                    >
                      {open ? <ChevronDown size={18} className="text-zinc-500" /> : <ChevronRight size={18} className="text-zinc-500" />}
                      <div className="w-10 h-10 rounded-xl bg-[#202026] border border-white/5 flex items-center justify-center font-bold text-white shrink-0 overflow-hidden">
                        {client?.logoDataUrl ? <img src={client.logoDataUrl} alt="" className="w-full h-full object-cover" /> : client?.name.charAt(0)}
                      </div>
                      <span className="font-sans font-bold text-lg text-white tracking-tight">{client?.name ?? 'Unassigned'}</span>
                      <span className="ml-auto text-[12px] text-zinc-600 font-semibold">{docs.length} documents</span>
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
                          emptyMessage="Nothing archived for this client."
                          bulkActions={archiveActions}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
              {archiveByClient.size === 0 && (
                <div className="border border-white/5 rounded-[32px] bg-[#16161a] p-10 text-center text-zinc-500">
                  {query || filtersActive ? 'Nothing in the archive matches those filters.' : 'Nothing archived yet — items land here once published.'}
                </div>
              )}
            </div>
          )}

          {tab === 'Vault' && (
            <div className="flex flex-col gap-4">
              <div className="text-[12px] text-zinc-500 font-semibold flex items-center gap-2">
                <FolderTree size={14} />
                Firm → Client → Financial year → Category
              </div>

              {[...grouped.entries()].map(([clientId, years]) => {
                const client = clients.find((c) => c.id === clientId);
                const open = isOpen(clientId);
                const count = [...years.values()].reduce((n, list) => n + list.length, 0);
                return (
                  <div key={clientId} className="border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
                    <button
                      onClick={() => setExpanded((p) => (p.includes(clientId) ? p.filter((x) => x !== clientId) : [...p, clientId]))}
                      className="w-full p-5 flex items-center gap-4 hover:bg-white/[0.02] transition-colors text-left"
                    >
                      {open ? <ChevronDown size={18} className="text-zinc-500" /> : <ChevronRight size={18} className="text-zinc-500" />}
                      <div className="w-10 h-10 rounded-xl bg-[#202026] border border-white/5 flex items-center justify-center font-bold text-white shrink-0 overflow-hidden">
                        {client?.logoDataUrl ? <img src={client.logoDataUrl} alt="" className="w-full h-full object-cover" /> : client?.name.charAt(0)}
                      </div>
                      <span className="font-sans font-bold text-lg text-white tracking-tight">{client?.name}</span>
                      <span className="ml-auto text-[12px] text-zinc-600 font-semibold">{count} documents</span>
                    </button>

                    {open && (
                      <div className="border-t border-white/5">
                        {[...years.entries()].map(([year, docs]) => (
                          <div key={year} className="px-5 py-4 border-b border-white/5 last:border-0">
                            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">{year}</div>
                            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                              {VAULT_CATEGORIES.filter((cat) => docs.some((d) => d.category === cat)).map((cat) => (
                                <div key={cat} className="rounded-2xl bg-[#0a0a0c]/60 border border-white/5 p-4">
                                  <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2.5">{cat}</div>
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
                <div className="border border-white/5 rounded-[32px] bg-[#16161a] p-10 text-center text-zinc-500">
                  Nothing in the vault matches those filters.
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
                logAudit({ action: 'Changed vault file owner', scope: `${vaultPreview.name} → ${name}`, reviewOpened: true });
              }}
              onDelete={async () => {
                const ok = await confirm({
                  tone: 'red',
                  title: `Delete "${vaultPreview.name}"?`,
                  detail: `${vaultPreview.category} · owned by ${vaultPreview.ownerName}.`,
                  consequence: vaultPreview.tags.includes('permanent') || vaultPreview.tags.includes('statutory')
                    ? 'This is a permanent or statutory record — it should normally be kept for the life of the company.'
                    : 'The file goes for good; the vault holds no second copy.',
                  confirmLabel: 'Yes, delete it',
                });
                if (!ok) return;
                deleteVaultDocument(vaultPreview.id);
                logAudit({ action: 'Deleted vault document', scope: vaultPreview.name, reviewOpened: true });
                setVaultPreview(null);
              }}
            />
          </Modal>
        )}

        {moveTarget && (
          <Modal onClose={() => setMoveTarget(null)}>
            <div className="w-full max-w-md border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
              <div className="p-6 border-b border-white/5">
                <h3 className="font-sans font-bold text-xl text-white tracking-tight">Move to another entity</h3>
                <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                  {moveTarget.ids.length} item{moveTarget.ids.length === 1 ? '' : 's'}
                </p>
              </div>
              <div className="p-4 flex flex-col gap-1">
                {clients.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      if (moveTarget.kind === 'doc') moveDocuments(moveTarget.ids, c.id);
                      else moveTarget.ids.forEach((id) => moveVaultDocument(id, c.id));
                      logAudit({ action: 'Moved between entities', scope: `${moveTarget.ids.length} item(s) → ${c.name}`, reviewOpened: true });
                      setMoveTarget(null);
                      setVaultPreview(null);
                    }}
                    className="px-4 py-3 rounded-2xl text-left hover:bg-white/5 transition-colors"
                  >
                    <div className="text-sm font-bold text-white">{c.name}</div>
                    <div className="text-[12px] text-amber-400 mt-0.5">Check the addressee matches before moving</div>
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

/** One file in the vault, with the same explicit preview the archive offers. */
function VaultFileRow({ doc, onPreview }: { doc: VaultDocument; onPreview: () => void }) {
  return (
    <div className="group/item flex items-start gap-2">
      <button onClick={onPreview} className="text-left min-w-0 flex-1" title={doc.summary}>
        <div className="text-[13px] font-bold text-white group-hover/item:text-[#14e3c4] transition-colors truncate">
          {doc.name.replace(` — ${doc.clientName}`, '')}
        </div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-md border ${
              doc.ownerKind === 'firm'
                ? 'text-zinc-400 border-white/10 bg-white/[0.03]'
                : 'text-[#14e3c4] border-[#14e3c4]/25 bg-[#14e3c4]/10'
            }`}
            title={doc.ownerKind === 'firm' ? 'Owned by the practice' : `Owned by ${doc.ownerName}`}
          >
            {doc.ownerKind === 'firm' ? <Building2 size={9} /> : <User size={9} />}
            {doc.ownerKind === 'firm' ? 'Firm' : doc.ownerName}
          </span>
          {doc.daysToExpiry !== undefined && (
            <span className={`text-[10px] font-bold ${doc.daysToExpiry <= 0 ? 'text-red-400' : doc.daysToExpiry <= 14 ? 'text-amber-400' : 'text-zinc-600'}`}>
              {doc.daysToExpiry <= 0 ? 'Expired' : `${doc.daysToExpiry}d`}
            </span>
          )}
          {doc.access === 'practice' && <Lock size={10} className="text-zinc-600" />}
          {doc.tags.slice(0, 2).map((t) => (
            <span key={t} className="text-[10px] text-zinc-600 font-semibold">#{t}</span>
          ))}
        </div>
      </button>
      <button
        onClick={onPreview}
        aria-label={`Preview ${doc.name}`}
        title="Preview"
        className="shrink-0 w-7 h-7 rounded-lg border border-white/5 text-zinc-500 hover:text-white hover:border-white/20 flex items-center justify-center transition-colors"
      >
        <Eye size={13} />
      </button>
    </div>
  );
}

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

  return (
    <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
      <div className="p-6 border-b border-white/5">
        <h3 className="font-sans font-bold text-xl text-white tracking-tight">{doc.name}</h3>
        <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
          {doc.clientName} · {doc.category} · {doc.financialYear} · {doc.sizeKb}KB
        </p>
      </div>

      <div className="p-6 flex flex-col gap-4">
        <p className="text-[13px] text-zinc-400 leading-relaxed">{doc.summary}</p>

        <div className="flex flex-wrap gap-2">
          {doc.tags.map((t) => <Pill key={t}>#{t}</Pill>)}
          {doc.access === 'practice' ? <Pill tone="amber">Practice only</Pill> : <Pill tone="blue">Client visible</Pill>}
        </div>

        <div>
          <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Owned by</div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onSetOwner('firm', PRACTICE_NAME)}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold border transition-all ${
                doc.ownerKind === 'firm'
                  ? 'bg-[#14e3c4] text-white border-[#14e3c4]'
                  : 'bg-[#0a0a0c] text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
              }`}
            >
              <Building2 size={13} />
              The firm
            </button>
            <button
              onClick={() => onSetOwner('accountant', doc.uploader)}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold border transition-all ${
                doc.ownerKind === 'accountant'
                  ? 'bg-[#14e3c4] text-white border-[#14e3c4]'
                  : 'bg-[#0a0a0c] text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
              }`}
            >
              <User size={13} />
              {doc.uploader}
            </button>
          </div>
          <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">
            Firm-owned files stay with the practice. A file owned by one accountant follows their engagement.
          </p>
        </div>

        <div className="flex flex-col gap-2.5 text-[13px]">
          <Row label="Owner" value={doc.ownerName} />
          <Row label="Uploader" value={doc.uploader} />
          <Row label="Source" value={doc.source} />
          <Row label="Uploaded" value={doc.uploadedAt} />
          {doc.expiresOn && <Row label="Key date" value={doc.expiresOn} />}
        </div>

        {doc.daysToExpiry !== undefined && doc.daysToExpiry <= 14 && (
          <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 text-[13px] text-amber-200/90">
            <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
            {doc.daysToExpiry <= 0
              ? 'This document has expired. A reminder was raised when the key date passed.'
              : `Expires in ${doc.daysToExpiry} days — reminder already set from the extracted key date.`}
          </div>
        )}
      </div>

      {confirming ? (
        <div className="p-4 bg-red-500/5 border-t border-red-500/20 flex items-center gap-3 justify-between flex-wrap">
          <p className="text-[12px] text-red-300 font-semibold min-w-0">
            Delete “{doc.name}” permanently? This cannot be undone.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setConfirming(false)}
              className="px-4 py-2 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onDelete}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-white bg-red-500 hover:bg-red-600 transition-colors"
            >
              <Trash2 size={14} />
              Delete permanently
            </button>
          </div>
        </div>
      ) : (
        <div className="p-4 bg-[#202026]/50 flex items-center gap-3 justify-end flex-wrap">
          <div className="relative mr-auto">
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="More actions"
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
                  className="absolute bottom-full left-0 mb-2 w-52 rounded-2xl border border-white/5 bg-[#16161a] shadow-2xl p-1.5 z-10"
                >
                  <button
                    onClick={() => { setMenuOpen(false); setConfirming(true); }}
                    className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-[13px] font-semibold text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors text-left"
                  >
                    <Trash2 size={14} />
                    Delete file…
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <button
            onClick={onMove}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors"
          >
            <ArrowRightLeft size={15} />
            Move to client
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
      className={`bg-[#16161a] border rounded-full py-2 px-4 text-[13px] font-bold focus:outline-none focus:border-[#14e3c4] shadow-inner transition-colors ${
        active ? 'text-[#14e3c4] border-[#14e3c4]/30' : 'text-zinc-400 border-white/5'
      }`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-[#16161a] text-white">
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
