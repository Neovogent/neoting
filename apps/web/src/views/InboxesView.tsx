import { useMemo, useRef, useState } from 'react';
import {
  Search, AlertCircle, CheckCircle2, UploadCloud, Eye, PencilLine, X, Copy, Link2,
  ShieldAlert, Sparkles, Send, Trash2, RefreshCw, Download, ArrowRightLeft, Check, SlidersHorizontal,
  LucideIcon,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppContext } from '../context/AppContext';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { Tooltip } from '../components/DynamicComponents/Tooltip';
import { blockedReason, describeMissing, partitionByReadiness, readinessOf } from '../lib/readiness';
import { DocumentPreview } from '../components/DynamicComponents/DocumentPreview';
import { currency } from '../lib/resolver';
import { missingMandatory, OPTIONAL_MANDATORY } from '../lib/selectors';
import { DuplicateModal } from '../components/DynamicComponents/DuplicateModal';
import { navigate, path, usePath, useQueryParam } from '../lib/router';
import { EXPORT_HINT, EXPORT_MIN_ROWS } from '../lib/exportRules';
import { failureOf, retryMeaning } from '../lib/failures';
import { AnalysisModal } from '../components/DynamicComponents/AnalysisModal';
import type { DocKind, DocStatus, Document, DuplicatePair } from '../lib/types';

const STATUS_TABS = ['review', 'ready', 'processing', 'published', 'rejected'] as const;
const INBOXES = ['cost', 'sales'] as const;

type StatusTab = (typeof STATUS_TABS)[number];
type Inbox = (typeof INBOXES)[number] & DocKind;

export function InboxesView() {
  const {
    documents, clients, duplicates, transactions, ingest, sheetImports,
    mandatoryFields, setMandatoryFields, ingestRejections, updateDocumentStatus,
    documentsSource, documentsLoading, documentsError,
    moveDocuments, deleteDocuments, retryDocument, startConversation, logAudit, publishDocuments,
  } = useAppContext();

  /**
   * /inboxes/:inbox/:status — both rows of tabs live in the address.
   *
   * A step is a place: Ready under Costs is where a person works for ten
   * minutes, sends the link to a colleague, and comes back to after opening a
   * document. Held in useState it survived none of that — Back left the screen
   * entirely and a refresh dropped them at To Review.
   */
  const segments = usePath();
  const inbox = (INBOXES.find((i) => i === segments[1]) ?? 'cost') as Inbox;
  const statusTab = (STATUS_TABS.find((st) => st === segments[2]) ?? 'review') as StatusTab;

  /** Both tabs move together so a queued pair of calls cannot half-navigate. */
  const goTo = (next: { inbox?: Inbox; status?: StatusTab }) =>
    navigate(path('inboxes', next.inbox ?? inbox, next.status ?? statusTab));
  const setInbox = (next: Inbox) => goTo({ inbox: next });
  const setStatusTab = (next: StatusTab) => goTo({ status: next });
  const [query, setQuery] = useState('');
  const [clientFilter, setClientFilter] = useState<string>('all');
  const [channelFilter, setChannelFilter] = useState<string>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<Document | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [teachSender, setTeachSender] = useState(false);
  /** The upload being read on screen, so the result is shown rather than filed silently. */
  const [analysing, setAnalysing] = useState<{ docIds: string[]; importIds: string[] } | null>(null);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const confirm = useConfirm();
  const [confirmPublish, setConfirmPublish] = useState<string[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** The failed document a replacement file is being chosen for, if any. */
  const replaceRef = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<Document | null>(null);

  /**
   * The pair each flagged document belongs to, not just the fact that it is
   * flagged. A duplicate warning that cannot show you the other copy asks the
   * accountant to go and find it themselves, which is the whole job.
   */
  const pairFor = useMemo(() => {
    const map = new Map<string, DuplicatePair>();
    duplicates.forEach((p) => { map.set(p.left.id, p); map.set(p.right.id, p); });
    return map;
  }, [duplicates]);

  // In the URL, so a compare can be linked to and Back closes it.
  const [comparingId, setComparingId] = useQueryParam('compare');
  const comparing = comparingId ? duplicates.find((p) => p.id === comparingId) ?? null : null;
  const setComparing = (pair: DuplicatePair | null) => setComparingId(pair ? pair.id : null);

  const matchedIds = useMemo(
    () => new Set(transactions.filter((t) => t.matchedDocId).map((t) => t.matchedDocId!)),
    [transactions],
  );

  const inKind = useMemo(
    () => documents.filter((d) => d.kind === inbox),
    [documents, inbox],
  );

  /** Everything the filters allow, before the status tab narrows it further. */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inKind.filter((d) => {
      if (clientFilter !== 'all' && d.clientId !== clientFilter) return false;
      if (channelFilter !== 'all' && d.source !== channelFilter) return false;
      if (q && !`${d.supplier} ${d.clientName} ${d.category} ${d.total}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [inKind, clientFilter, channelFilter, query]);

  const rows = useMemo(() => filtered.filter((d) => d.status === statusTab), [filtered, statusTab]);

  // Tab counts track the active filters so they always agree with the table.
  const counts = (s: DocStatus) => filtered.filter((d) => d.status === s).length;

  const selectedDocs = documents.filter((d) => selected.includes(d.id));
  const allSelected = rows.length > 0 && rows.every((d) => selected.includes(d.id));

  const handleFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files).map((f) => ({ name: f.name, size: f.size, raw: f }));
    const result = ingest(list, clientFilter === 'all' ? undefined : clientFilter, 'web');

    if (result.documents.length || result.imports.length) {
      setAnalysing({ docIds: result.documents.map((d) => d.id), importIds: result.imports.map((t) => t.id) });
    }

    logAudit({
      action: 'Uploaded documents',
      scope: `${result.documents.length} document(s) from ${list.length} file(s)`,
      reviewOpened: true,
    });
    goTo({ inbox: 'cost', status: 'processing' });
  };

  /** Publishing is irreversible, so every entry point routes through the confirmation modal. */
  const requestPublish = (ids: string[]) => {
    if (ids.length) setConfirmPublish(ids);
  };

  /** Publishes right here in the dashboard — items missing required fields stay in Ready. */
  const publishConfirmed = () => {
    if (!confirmPublish?.length) return;
    const docs = documents.filter((d) => confirmPublish.includes(d.id));
    const publishable = docs.filter((d) => missingMandatory(d, mandatoryFields).length === 0);
    if (!publishable.length) return;
    publishDocuments(publishable.map((d) => d.id));
    const names = [...new Set(publishable.map((d) => d.clientName))];
    logAudit({
      action: 'Published documents',
      scope: `${publishable.length} item(s) · ${currency(publishable.reduce((s, d) => s + d.total, 0))} → ${names.join(', ')}`,
      reviewOpened: true,
    });
    setConfirmPublish(null);
    setSelected([]);
    setStatusTab('published');
  };

  /**
   * Retry, with the confirmation saying what it will actually do — the two
   * stages behave differently and one of them overwrites what was read.
   */
  const askRetry = async (doc: Document) => {
    const failure = failureOf(doc);
    if (!failure) return;
    const ok = await confirm({
      title: failure.stage === 'extraction' ? `Read ${doc.supplier} again?` : `Publish ${doc.supplier} again?`,
      detail: `${failure.reason}. ${retryMeaning(failure)}`,
      ...(failure.retryHelps
        ? {}
        : { consequence: `This is unlikely to clear it on its own — ${failure.fixLabel.toLowerCase()} is what changes the outcome.` }),
      confirmLabel: 'Yes, retry',
    });
    if (!ok) return;
    retryDocument(doc.id);
  };

  /** The cause's own way out, which is a different thing in each case. */
  const runFix = (doc: Document) => {
    const failure = failureOf(doc);
    if (!failure) return;
    if (failure.fix === 'open-document') { setPreview(doc); return; }
    if (failure.fix === 'reconnect-ledger') { navigate(path('clients', doc.clientId, 'integrations')); return; }
    if (failure.fix === 'replace-file') { setReplacing(doc); replaceRef.current?.click(); }
  };

  /**
   * A replacement comes in under the same client and the unreadable original
   * goes — leaving both would put the same spend on file twice, which is the
   * problem the deduplicator exists to catch.
   */
  const handleReplacement = async (files: FileList | null) => {
    const doc = replacing;
    setReplacing(null);
    // Reading the file first says what the length check was really asserting:
    // a replacement is exactly one file, and there is nothing to do without it.
    const file = files?.[0];
    if (!doc || !file) return;
    const ok = await confirm({
      title: `Replace ${doc.supplier === 'Unknown' ? 'this document' : doc.supplier} with ${file.name}?`,
      detail: 'The new file is read from scratch under the same client.',
      consequence: 'The unreadable original is removed, so the same spend is not on file twice.',
      confirmLabel: 'Yes, replace it',
    });
    if (!ok) return;
    ingest([{ name: file.name, size: file.size }], doc.clientId, 'web');
    deleteDocuments([doc.id]);
    logAudit({
      action: 'Replaced an unreadable document',
      scope: `${file.name} → ${doc.clientName}${doc.statusNote ? ` — was: ${doc.statusNote}` : ''}`,
      reviewOpened: true,
    });
    goTo({ status: 'processing' });
  };

  // Selections don't carry across tabs — bulk actions must never touch rows the user can't see.
  const switchTab = (t: StatusTab) => {
    setStatusTab(t);
    setSelected([]);
  };

  const markReviewed = async (doc: Document) => {
    const { ready, missing } = readinessOf(doc, mandatoryFields);
    if (!ready) {
      await confirm({
        tone: 'red',
        title: `${doc.supplier} is not ready yet`,
        detail: `${describeMissing(missing)}. Ready means every check has passed, so it cannot move until they are filled in.`,
        confirmLabel: 'Close',
      });
      return;
    }
    const ok = await confirm({
      title: `Move ${doc.supplier} to Ready?`,
      detail: `${currency(doc.total)} · ${doc.category}. Ready means every check has passed and it is queued to publish.`,
      confirmLabel: 'Yes, mark it Ready',
    });
    if (!ok) return;
    updateDocumentStatus(doc.id, 'ready');
    logAudit({ action: 'Marked document reviewed', scope: `${doc.supplier} · ${currency(doc.total)} → Ready`, reviewOpened: true });
  };

  return (
    <div
      className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-y-auto relative [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
    >
      <header className="px-10 py-8 shrink-0 flex flex-col items-center">
        <div className="flex items-center justify-between w-full mb-6 gap-4 flex-wrap">
          <div className="flex items-center gap-5">
            <h1 className="font-sans text-3xl font-semibold text-white tracking-tight">Inboxes</h1>
            <div className="flex items-center gap-2">
              <InboxPill active={inbox === 'cost'} onClick={() => { setInbox('cost'); setSelected([]); }} label="Costs" />
              <InboxPill active={inbox === 'sales'} onClick={() => { setInbox('sales'); setSelected([]); }} label="Sales" />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setFieldsOpen(true)}
              className="flex items-center gap-2 px-5 py-3 text-sm font-bold text-zinc-300 bg-card border border-white/10 rounded-full hover:bg-white/5 shadow-lg transition-all"
              title="Fields required before publishing"
            >
              <SlidersHorizontal size={16} />
              Required fields
              {mandatoryFields.length > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-brand text-white text-[11px]">{mandatoryFields.length}</span>
              )}
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 px-6 py-3 text-sm font-bold text-white bg-card border border-white/10 rounded-full hover:bg-white/5 shadow-lg transition-all"
            >
              <UploadCloud size={18} />
              Upload Documents
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              accept=".jpg,.jpeg,.png,.gif,.bmp,.tiff,.heic,.pdf,.doc,.docx,.odt,.rtf,.zip,.csv,.xlsx"
              onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
            />
            {/* Separate input: a replacement is one file for one document, not
                a bulk upload, and it must not fall into handleFiles. */}
            <input
              ref={replaceRef}
              type="file"
              className="hidden"
              accept=".jpg,.jpeg,.png,.gif,.bmp,.tiff,.heic,.pdf,.doc,.docx,.odt,.rtf"
              onChange={(e) => { handleReplacement(e.target.files); e.target.value = ''; }}
            />
          </div>
        </div>

        {/* Where these rows came from. Silent on seed data — it is only worth
            saying when the answer is the API, because then "empty inbox" and
            "the request failed" look identical and are not. */}
        {documentsSource === 'api' && (documentsLoading || documentsError) && (
          <div
            className={`w-full mb-4 flex items-center gap-3 px-5 py-3 rounded-2xl border text-[13px] ${
              documentsError
                ? 'bg-red-500/10 border-red-500/20 text-red-300'
                : 'bg-white/[0.03] border-white/10 text-zinc-400'
            }`}
          >
            {documentsError ? <AlertCircle size={15} /> : <RefreshCw size={15} className="animate-spin" />}
            <span className="min-w-0">
              {documentsError
                ? `Could not load documents — ${documentsError}`
                : 'Loading documents from the API…'}
            </span>
          </div>
        )}

        {ingestRejections.length > 0 && (
          <div className="w-full mb-4 flex flex-col gap-2">
            {ingestRejections.slice(0, 3).map((r, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-3 rounded-2xl bg-red-500/10 border border-red-500/20 text-[13px] text-red-300">
                <ShieldAlert size={16} className="shrink-0" />
                <span className="font-bold">{r.fileName}</span>
                <span className="text-red-300/70">{r.reason}</span>
                <span className="ml-auto text-red-300/50 text-[11px] font-semibold">{r.at}</span>
              </div>
            ))}
          </div>
        )}

        {(
          <div className="flex items-center gap-2 bg-card p-1.5 rounded-full border border-white/5 shadow-2xl relative z-10 -mb-16">
            <TabButton active={statusTab === 'review'} onClick={() => switchTab('review')} label="To Review" count={counts('review')} />
            <TabButton active={statusTab === 'ready'} onClick={() => switchTab('ready')} label="Ready" count={counts('ready')} />
            <TabButton active={statusTab === 'processing'} onClick={() => switchTab('processing')} label="Processing" count={counts('processing')} />
            <TabButton active={statusTab === 'published'} onClick={() => switchTab('published')} label="Published" count={counts('published')} />
            <TabButton active={statusTab === 'rejected'} onClick={() => switchTab('rejected')} label="Failed" count={counts('rejected')} />
          </div>
        )}
      </header>

      <div className="flex-1 bg-white rounded-t-[40px] m-4 mt-8 pt-16 p-8 shadow-2xl flex flex-col overflow-hidden border border-white/10">
        {(
          <>
            <div className="flex items-center justify-between shrink-0 mb-6 px-2 gap-4 flex-wrap">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="relative">
                  <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search supplier, amount..."
                    className="w-64 bg-zinc-100 border-none rounded-full py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-brand transition-all placeholder:text-zinc-500 font-medium"
                  />
                </div>
                <LightSelect value={clientFilter} onChange={setClientFilter} options={[{ value: 'all', label: 'All clients' }, ...clients.map((c) => ({ value: c.id, label: c.name }))]} />
                <LightSelect
                  value={channelFilter}
                  onChange={setChannelFilter}
                  options={[
                    { value: 'all', label: 'All channels' },
                    { value: 'email', label: 'Email' },
                    { value: 'web', label: 'Web upload' },
                    { value: 'whatsapp', label: 'WhatsApp' },
                    { value: 'sms-link', label: 'SMS link' },
                    { value: 'csv', label: 'CSV / XLSX' },
                    { value: 'portal', label: 'Business portal' },
                  ]}
                />
              </div>

              <div className="flex items-center gap-3">
                <span className="text-[13px] font-bold text-zinc-400">{rows.length} items</span>
                <button
                  onClick={() => requestPublish(selected.length ? selected : rows.map((d) => d.id))}
                  disabled={statusTab !== 'ready' || rows.length === 0}
                  className="px-6 py-2.5 text-sm font-bold text-white bg-brand hover:bg-brand-hover rounded-full transition-all shadow-md disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Publish {selected.length ? selected.length : rows.length} Items
                </button>
              </div>
            </div>

            <AnimatePresence>
              {selected.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: -8, height: 0 }}
                  animate={{ opacity: 1, y: 0, height: 'auto' }}
                  exit={{ opacity: 0, y: -8, height: 0 }}
                  className="shrink-0 mb-5 mx-2 overflow-visible"
                >
                  <div className="flex items-center gap-2 flex-wrap bg-zinc-100 rounded-2xl px-4 py-3">
                    <span className="text-[13px] font-bold text-zinc-700 mr-2">{selected.length} selected</span>
                    {statusTab === 'review' && (
                      <BulkBtn
                        icon={CheckCircle2}
                        label="Mark reviewed"
                        onClick={async () => {
                          const { ready, blocked } = partitionByReadiness(selectedDocs, mandatoryFields);
                          if (ready.length === 0) {
                            await confirm({
                              tone: 'red',
                              title: 'None of these can move yet',
                              detail: blocked
                                .map(({ doc, missing }) => `${doc.supplier} — ${describeMissing(missing).toLowerCase()}`)
                                .slice(0, 4)
                                .join('. '),
                              confirmLabel: 'Close',
                            });
                            return;
                          }
                          const ok = await confirm({
                            title: `Move ${ready.length} item${ready.length === 1 ? '' : 's'} to Ready?`,
                            detail: 'Ready means every check has passed and they are queued to publish.',
                            ...(blocked.length
                              ? { consequence: `${blocked.length} still missing required fields will be left alone: ${blocked.map((b) => b.doc.supplier).join(', ')}.` }
                              : {}),
                            confirmLabel: 'Yes, mark them Ready',
                          });
                          if (!ok) return;
                          ready.forEach((d) => updateDocumentStatus(d.id, 'ready'));
                          setSelected([]);
                        }}
                      />
                    )}
                    <div className="relative">
                      <BulkBtn icon={ArrowRightLeft} label="Move to client" onClick={() => setMoveOpen((o) => !o)} />
                      <AnimatePresence>
                        {moveOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: -6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -6 }}
                            className="absolute top-full left-0 mt-2 w-72 bg-white border border-zinc-200 rounded-2xl shadow-2xl z-50 p-2"
                          >
                            <div className="px-3 py-2 text-[11px] font-bold text-zinc-400 uppercase tracking-widest">Move to</div>
                            {/* The taught-sender tick from the old unrouted
                                card, kept where the routing decision now
                                happens: correcting an addressee once should
                                mean never correcting it again. */}
                            <label className="flex items-start gap-2 px-3 py-2 mb-1 rounded-xl cursor-pointer hover:bg-zinc-50">
                              <input
                                type="checkbox"
                                checked={teachSender}
                                onChange={(e) => setTeachSender(e.target.checked)}
                                className="mt-0.5 accent-brand"
                              />
                              <span className="text-[12px] font-semibold text-zinc-600 leading-snug">
                                Always route this sender here
                                <span className="block text-[11px] font-medium text-zinc-400">
                                  {[...new Set(selectedDocs.map((d) => d.uploader))].slice(0, 2).join(', ') || 'the senders of these documents'}
                                </span>
                              </span>
                            </label>
                            {clients.map((c) => {
                              const mismatch = selectedDocs.some((d) => d.clientName !== c.name);
                              return (
                                <button
                                  key={c.id}
                                  onClick={async () => {
                                    const ok = await confirm({
                                      title: `Move ${selected.length} document${selected.length === 1 ? '' : 's'} to ${c.name}?`,
                                      detail: selectedDocs.map((d) => d.supplier).slice(0, 4).join(' · '),
                                      ...(teachSender
                                        ? { consequence: 'Every future document from these senders will be filed under this client automatically.' }
                                        : {}),
                                      confirmLabel: 'Yes, move them',
                                    });
                                    if (!ok) return;
                                    moveDocuments(selected, c.id, teachSender);
                                    logAudit({
                                      action: 'Moved documents between entities',
                                      scope: `${selected.length} item(s) → ${c.name}${teachSender ? ' · sender taught' : ''}`,
                                      reviewOpened: true,
                                    });
                                    setMoveOpen(false);
                                    setTeachSender(false);
                                    setSelected([]);
                                  }}
                                  className="w-full px-3 py-2.5 rounded-xl text-left text-[13px] font-semibold text-zinc-700 hover:bg-zinc-50 transition-colors"
                                >
                                  {c.name}
                                  {mismatch && (
                                    <span className="block text-[11px] font-medium text-amber-600 mt-0.5">
                                      Addressee differs from the current workspace
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                    <BulkBtn icon={Sparkles} label="Ask AI" onClick={() => {
                      // The bar only renders with a selection, but the rows it
                      // names can go under it — a delete elsewhere leaves ids
                      // selected with no document behind them, and there is
                      // nothing to open in the workspace then.
                      const first = selectedDocs[0];
                      if (!first) return;
                      const names = [...new Set(selectedDocs.map((d) => d.clientName))];
                      const ids = clients.filter((c) => names.includes(c.name)).map((c) => c.id);
                      startConversation(ids, [
                        { id: `${Date.now()}-u`, role: 'user', content: `Review the ${first.supplier} document` },
                        { id: `${Date.now()}-a`, role: 'assistant', content: 'Every field shows confidence and provenance — click any value to correct it.', intent: 'REVIEW_DOCUMENT', payload: { documentId: first.id, clientIds: ids, clientNames: names } },
                      ]);
                    }} />
                    {statusTab === 'ready' && (
                      <BulkBtn icon={Send} label="Publish" onClick={() => requestPublish(selected)} />
                    )}
                    {statusTab === 'rejected' && (
                      <BulkBtn
                        icon={RefreshCw}
                        label="Retry"
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Retry ${selected.length} failed item${selected.length === 1 ? '' : 's'}?`,
                            detail: 'Anything that failed to extract is read again; anything that failed to publish goes back to Ready to be pushed again. Whatever was already read off a document is kept.',
                            confirmLabel: 'Yes, retry',
                          });
                          if (!ok) return;
                          selected.forEach((id) => retryDocument(id));
                          setSelected([]);
                        }}
                      />
                    )}
                    <BulkBtn
                      icon={Download}
                      label="Export CSV"
                      minSelected={EXPORT_MIN_ROWS}
                      selectedCount={selected.length}
                      disabledHint={EXPORT_HINT}
                      onClick={() => exportDocs(selectedDocs)}
                    />
                    {/* Was a click-twice-within-4s pattern, which is easy to
                        trip by accident and says nothing about what goes. */}
                    <BulkBtn
                      icon={Trash2}
                      label="Delete"
                      danger
                      onClick={async () => {
                        const ok = await confirm({
                          tone: 'red',
                          title: `Delete ${selected.length} document${selected.length === 1 ? '' : 's'}?`,
                          detail: selectedDocs.map((d) => d.supplier).slice(0, 4).join(' · ') || 'The selected items.',
                          consequence: 'The originals go with them, and a deleted document cannot be matched to a bank line later.',
                          confirmLabel: 'Yes, delete',
                        });
                        if (!ok) return;
                        deleteDocuments(selected);
                        logAudit({ action: 'Deleted documents', scope: `${selected.length} item(s)`, reviewOpened: true });
                        setSelected([]);
                      }}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="flex-1 overflow-auto px-2">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="text-[11px] uppercase tracking-widest font-bold text-zinc-400 border-b border-zinc-100">
                  <tr>
                    <th className="px-4 py-4 w-12">
                      <LightCheckbox
                        checked={allSelected}
                        onChange={() => setSelected(allSelected ? [] : rows.map((d) => d.id))}
                      />
                    </th>
                    <th className="px-4 py-4">Client</th>
                    <th className="px-4 py-4">{inbox === 'sales' ? 'Customer' : 'Supplier'}</th>
                    <th className="px-4 py-4">Date</th>
                    <th className="px-4 py-4 text-right">Total</th>
                    <th className="px-4 py-4">Category</th>
                    {/* A field the practice made mandatory is a field they
                        need to see: making it required and then hiding it
                        leaves people opening documents one by one to find out
                        which are missing it. */}
                    {mandatoryFields.map((f) => (
                      <th key={f} className="px-4 py-4">{f}</th>
                    ))}
                    <th className="px-4 py-4">Flags</th>
                    <th className="px-4 py-4 text-right">Status</th>
                    <th className="px-4 py-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={9 + mandatoryFields.length} className="px-4 py-16 text-center text-zinc-400 font-medium">
                        Nothing in this view. Drop files anywhere on this page to ingest them.
                      </td>
                    </tr>
                  )}
                  {rows.map((doc) => {
                    const isSel = selected.includes(doc.id);
                    const blocked = missingMandatory(doc, mandatoryFields);
                    return (
                      <tr
                        key={doc.id}
                        onClick={() => setSelected((p) => (p.includes(doc.id) ? p.filter((x) => x !== doc.id) : [...p, doc.id]))}
                        className={`transition-colors group cursor-pointer ${isSel ? 'bg-brand/[0.06]' : 'hover:bg-zinc-50'}`}
                      >
                        <td className="px-4 py-5">
                          <LightCheckbox checked={isSel} onChange={() => setSelected((p) => (p.includes(doc.id) ? p.filter((x) => x !== doc.id) : [...p, doc.id]))} />
                        </td>
                        <td className="px-4 py-5 text-zinc-900 font-bold">{doc.clientName}</td>
                        <td className="px-4 py-5 font-semibold text-zinc-700">
                          {doc.supplier}
                          {doc.splitFrom && <span className="block text-[11px] font-medium text-zinc-400">{doc.splitFrom}</span>}
                        </td>
                        <td className="px-4 py-5 text-zinc-500 font-medium">{doc.date}</td>
                        <td className="px-4 py-5 text-right font-bold text-zinc-900 text-[15px]">{currency(doc.total)}</td>
                        <td className="px-4 py-5">
                          <span className={`inline-flex items-center px-3 py-1 rounded-full text-[11px] font-bold tracking-wide uppercase ${doc.category === '—' ? 'bg-amber-100 text-amber-700' : 'bg-zinc-100 text-zinc-600'}`}>
                            {doc.category}
                          </span>
                        </td>
                        {mandatoryFields.map((label) => {
                          const value = doc.fields.find((f) => f.label.toLowerCase() === label.toLowerCase())?.value;
                          const filled = value && value !== '—';
                          return (
                            <td key={label} className="px-4 py-5">
                              <span
                                className={`text-[13px] font-semibold ${filled ? 'text-zinc-700' : 'text-amber-600'}`}
                                title={filled ? undefined : `${label} is required before this can be published`}
                              >
                                {filled ? value : 'Missing'}
                              </span>
                            </td>
                          );
                        })}
                        <td className="px-4 py-5">
                          <span className="flex items-center gap-1.5">
                            {pairFor.has(doc.id) && (
                              <FlagIcon
                                icon={Copy}
                                tone="amber"
                                title="Suspected duplicate"
                                detail="Another document on file looks like the same spend. Open them side by side to compare."
                                onClick={() => setComparing(pairFor.get(doc.id)!)}
                              />
                            )}
                            {matchedIds.has(doc.id) && (
                              <FlagIcon
                                icon={Link2}
                                tone="blue"
                                title="Matched to a bank transaction"
                                detail="The payment for this is on the bank feed, so it is evidenced."
                              />
                            )}
                            {doc.status === 'ready' && blocked.length > 0 && (
                              <FlagIcon
                                icon={ShieldAlert}
                                tone="red"
                                title={`Cannot publish — missing ${blocked.join(', ')}`}
                                detail="Your practice made these fields mandatory before anything reaches the ledger."
                              />
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-5 text-right">
                          <StatusBadge doc={doc} blocked={blocked} />
                        </td>
                        <td className="px-4 py-5 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {/* A document with anything outstanding is offered
                                the fix, not the move — moving it on is what we
                                are trying to stop until it is sorted. */}
                            {doc.status === 'review' && (() => {
                              const verdict = readinessOf(doc, mandatoryFields);
                              return verdict.ready ? (
                                <button
                                  onClick={(e) => { e.stopPropagation(); markReviewed(doc); }}
                                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-bold bg-zinc-100 text-zinc-700 hover:bg-brand hover:text-white transition-colors"
                                  title="Move to Ready — publish is the next step"
                                >
                                  <CheckCircle2 size={14} />
                                  Mark reviewed
                                </button>
                              ) : (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setPreview(doc); }}
                                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-bold bg-amber-100 text-amber-700 hover:bg-amber-200 transition-colors"
                                  title={`${blockedReason(verdict)} — open it to sort that out first.`}
                                >
                                  <PencilLine size={14} />
                                  Fix
                                </button>
                              );
                            })()}
                            {/* A failed row used to offer nothing but View.
                                It now offers whatever actually clears this
                                failure, with Retry beside it — and Retry says
                                so when it cannot help. */}
                            {doc.status === 'rejected' && (() => {
                              const failure = failureOf(doc);
                              if (!failure) return null;
                              return (
                                <>
                                  {failure.fix !== 'retry' && (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); runFix(doc); }}
                                      className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-bold bg-amber-100 text-amber-700 hover:bg-amber-200 transition-colors"
                                      title={failure.detail}
                                    >
                                      {failure.fix === 'replace-file' ? <UploadCloud size={14} /> : failure.fix === 'reconnect-ledger' ? <Link2 size={14} /> : <PencilLine size={14} />}
                                      {failure.fixLabel}
                                    </button>
                                  )}
                                  <button
                                    onClick={(e) => { e.stopPropagation(); askRetry(doc); }}
                                    className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-bold transition-colors ${
                                      failure.retryHelps
                                        ? 'bg-zinc-100 text-zinc-700 hover:bg-brand hover:text-white'
                                        : 'text-zinc-400 border border-zinc-200 hover:text-zinc-600'
                                    }`}
                                    title={
                                      failure.retryHelps
                                        ? retryMeaning(failure)
                                        : `Unlikely to help — ${failure.reason.toLowerCase()}. ${retryMeaning(failure)}`
                                    }
                                  >
                                    <RefreshCw size={13} />
                                    Retry
                                  </button>
                                </>
                              );
                            })()}
                            {doc.status === 'ready' && (
                              <button
                                onClick={(e) => { e.stopPropagation(); requestPublish([doc.id]); }}
                                disabled={blocked.length > 0}
                                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-bold bg-brand text-white hover:bg-brand-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                title={blocked.length ? `Cannot publish — missing ${blocked.join(', ')}` : 'Publish this item'}
                              >
                                <Send size={13} />
                                Publish
                              </button>
                            )}
                            {/* An eye, not an overflow menu: this opens the
                                document, it does not reveal more actions. It
                                also stays visible rather than appearing on
                                hover — a control you cannot see is one nobody
                                knows is there. */}
                            <button
                              onClick={(e) => { e.stopPropagation(); setPreview(doc); }}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold text-zinc-500 border border-zinc-200 hover:text-black hover:border-zinc-300 transition-colors"
                              title="Open the document — the original with every extracted field"
                            >
                              <Eye size={14} />
                              View
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Drop overlay */}
      <AnimatePresence>
        {dragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-brand/20 backdrop-blur-sm border-4 border-dashed border-brand flex items-center justify-center pointer-events-none"
          >
            <div className="bg-card border border-white/10 rounded-[32px] px-10 py-8 text-center shadow-2xl">
              <UploadCloud size={40} className="text-brand mx-auto mb-4" />
              <p className="text-xl font-bold text-white">Drop to ingest</p>
              <p className="text-[13px] text-zinc-500 mt-1">Multi-document PDFs are auto-split · 100MB per file</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Document detail */}
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
              <button onClick={() => setPreview(null)} className="absolute -top-3 -right-3 z-10 p-2 bg-card hover:bg-raised text-zinc-400 hover:text-white rounded-full border border-white/10 transition-colors shadow-lg">
                <X size={18} />
              </button>
              <DocumentPreview document={documents.find((d) => d.id === preview.id) ?? preview} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Extraction on screen, then its figures, then the calls it made —
          all before the document is filed anywhere. */}
      {analysing && (
        <AnalysisModal
          docIds={analysing.docIds}
          importIds={analysing.importIds}
          onClose={(settled) => {
            const importIds = analysing.importIds;
            setAnalysing(null);
            // Land where the rows actually went, so the result of the upload is
            // the thing on screen rather than something to go and find.
            const first = settled[0];
            if (first) {
              goTo({ inbox: first.kind as Inbox, status: first.status === 'ready' ? 'ready' : 'review' });
              return;
            }
            const imported = sheetImports.filter((t) => importIds.includes(t.id));
            const sales = imported.reduce((n, t) => n + t.counts.sales, 0);
            const costs = imported.reduce((n, t) => n + t.counts.cost, 0);
            if (sales || costs) goTo({ inbox: sales > costs ? 'sales' : 'cost', status: 'review' });
          }}
        />
      )}

      {/* The two suspected copies, side by side, with keep-one / keep-both */}
      {comparing && <DuplicateModal pair={comparing} onClose={() => setComparing(null)} />}

      {/* Publish confirmation — publishing posts to the ledger, so it always asks first */}
      <AnimatePresence>
        {confirmPublish && (() => {
          const docs = documents.filter((d) => confirmPublish.includes(d.id));
          const held = docs.filter((d) => missingMandatory(d, mandatoryFields).length > 0);
          const publishable = docs.length - held.length;
          const totalValue = docs.reduce((s, d) => s + d.total, 0);
          const clientNames = [...new Set(docs.map((d) => d.clientName))];
          // One client is named; more than one is counted. Naming the single
          // case keeps that the only thing clientNames[0] is read under.
          const onlyClient = clientNames.length === 1 ? clientNames[0] : undefined;
          return (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setConfirmPublish(null)}
              className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-10"
            >
              <motion.div
                initial={{ opacity: 0, y: 20, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: 0.97 }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-md border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden"
              >
                <div className="p-6 border-b border-white/5">
                  <h3 className="font-sans font-bold text-xl text-white tracking-tight">
                    Publish {docs.length} item{docs.length === 1 ? '' : 's'}?
                  </h3>
                  <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                    This posts to the ledger and can't be undone here
                  </p>
                </div>
                <div className="p-6 flex flex-col gap-3">
                  <ConfirmRow label="Items" value={String(docs.length)} />
                  <ConfirmRow label="Total value" value={currency(totalValue)} />
                  <ConfirmRow label={clientNames.length === 1 ? 'Client' : 'Clients'} value={onlyClient ?? `${clientNames.length} clients`} />
                  {held.length > 0 && (
                    <div className="flex items-start gap-2.5 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-[13px] text-amber-300 leading-relaxed">
                      <ShieldAlert size={16} className="shrink-0 mt-0.5" />
                      <span>
                        <span className="font-bold">{held.length} item{held.length === 1 ? '' : 's'}</span> held back — missing required
                        fields. Fix them in the review, or publish the remaining {publishable} now.
                      </span>
                    </div>
                  )}
                </div>
                <div className="p-4 bg-raised/50 flex justify-end gap-3">
                  <button
                    onClick={() => setConfirmPublish(null)}
                    className="px-6 py-2.5 text-sm font-bold text-zinc-300 bg-white/5 hover:bg-white/10 rounded-full transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={publishConfirmed}
                    disabled={publishable === 0}
                    className="px-6 py-2.5 text-sm font-bold text-white bg-brand hover:bg-brand-hover rounded-full transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Publish {publishable} item{publishable === 1 ? '' : 's'}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* Mandatory fields config */}
      <AnimatePresence>
        {fieldsOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setFieldsOpen(false)}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-10"
          >
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: 0.97 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-white/5">
                <h3 className="font-sans font-bold text-xl text-white tracking-tight">Required before publish</h3>
                <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">Items missing these are held back</p>
              </div>
              <div className="p-6 flex flex-col gap-3">
                <div className="text-[13px] text-zinc-500 leading-relaxed">
                  Supplier, Total and Category are always required. Add more below — construction firms require a class,
                  QBO users require a customer reference.
                </div>
                {OPTIONAL_MANDATORY.map((f) => (
                  <button
                    key={f}
                    onClick={() => setMandatoryFields(mandatoryFields.includes(f) ? mandatoryFields.filter((x) => x !== f) : [...mandatoryFields, f])}
                    className="flex items-center justify-between gap-3 p-4 rounded-2xl border border-white/5 bg-ground/60 hover:border-white/15 transition-colors text-left"
                  >
                    <span className="text-sm font-bold text-white">{f}</span>
                    <span className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${mandatoryFields.includes(f) ? 'bg-brand' : 'bg-white/10'}`}>
                      <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${mandatoryFields.includes(f) ? 'left-6' : 'left-1'}`} />
                    </span>
                  </button>
                ))}
              </div>
              <div className="p-4 bg-raised/50 flex justify-end">
                <button onClick={() => setFieldsOpen(false)} className="px-6 py-2.5 text-sm font-bold text-white bg-brand hover:bg-brand-hover rounded-full transition-all">
                  Done
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}


function StatusBadge({ doc, blocked }: { doc: Document; blocked: string[] }) {
  if (doc.status === 'processing') {
    return (
      <span className="inline-flex items-center gap-1.5 text-zinc-600 text-xs font-bold bg-zinc-100 px-3 py-1 rounded-full">
        <span className="w-2 h-2 rounded-full bg-zinc-400 animate-pulse" />
        Processing
      </span>
    );
  }
  if (doc.status === 'rejected') {
    // "Failed" alone tells an accountant nothing they can act on, so the
    // cause and the way out are one hover away rather than nowhere.
    const failure = failureOf(doc);
    return (
      <Tooltip label={failure?.reason ?? 'Failed'} {...(failure ? { detail: failure.detail } : {})}>
        <span className="inline-flex items-center gap-1.5 text-white text-xs font-bold bg-red-500 px-3 py-1 rounded-full cursor-help">
          <AlertCircle size={14} />
          Failed
        </span>
      </Tooltip>
    );
  }
  if (doc.status === 'review') {
    return (
      <span className="inline-flex items-center gap-1.5 text-zinc-900 text-xs font-bold bg-amber-200 px-3 py-1 rounded-full">
        <AlertCircle size={14} />
        {doc.statusNote ?? 'To review'}
      </span>
    );
  }
  if (doc.status === 'published') {
    return (
      <span className="inline-flex items-center gap-1.5 text-white text-xs font-bold bg-emerald-500 px-3 py-1 rounded-full">
        <CheckCircle2 size={14} />
        Published
      </span>
    );
  }
  // Ready: green when clean, yellow when a previous publish failed or fields are missing.
  const yellow = doc.publishFailed || blocked.length > 0;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1 rounded-full ${
        yellow ? 'bg-amber-200 text-zinc-900' : 'bg-brand text-white'
      }`}
      title={doc.publishFailed ? doc.statusNote : blocked.length ? `Missing ${blocked.join(', ')}` : undefined}
    >
      <CheckCircle2 size={14} />
      {doc.publishFailed ? 'Ready — publish failed' : blocked.length ? 'Ready — blocked' : 'Ready'}
    </span>
  );
}

function ConfirmRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 p-4 rounded-2xl border border-white/5 bg-ground/60">
      <span className="text-[12px] font-bold text-zinc-500 uppercase tracking-widest">{label}</span>
      <span className="text-sm font-bold text-white">{value}</span>
    </div>
  );
}

/**
 * An icon in the Flags column. The icon carries the whole meaning, so it gets
 * a real tooltip rather than a native `title` that waits a second and cannot
 * say a second sentence.
 */
/**
 * A flag, and where it leads.
 *
 * Where there is something to look at behind the flag it is a real button —
 * pointer cursor, hover state, keyboard-reachable — because "suspected
 * duplicate" is only useful next to the other copy. Where there is nothing to
 * open it stays a hint and keeps the help cursor, so the two do not look alike.
 */
function FlagIcon({ icon: Icon, tone, title, detail, onClick }: {
  icon: LucideIcon;
  tone: 'amber' | 'blue' | 'red';
  title: string;
  detail?: string;
  onClick?: () => void;
}) {
  const tones = {
    amber: 'bg-amber-100 text-amber-700 hover:bg-amber-200',
    blue: 'bg-brand/20 text-brand-deep hover:bg-brand/35',
    red: 'bg-red-100 text-red-600 hover:bg-red-200',
  };
  const shape = `w-6 h-6 rounded-lg flex items-center justify-center transition-colors ${tones[tone]}`;

  return (
    <Tooltip label={title} {...(detail ? { detail: `${detail}${onClick ? ' Click to open.' : ''}` } : {})}>
      {onClick ? (
        <button
          type="button"
          aria-label={`${title} — compare`}
          onClick={(e) => { e.stopPropagation(); onClick(); }}
          className={`${shape} cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60`}
        >
          <Icon size={13} />
        </button>
      ) : (
        <span tabIndex={0} aria-label={title} className={`${shape} cursor-help`}>
          <Icon size={13} />
        </span>
      )}
    </Tooltip>
  );
}

function InboxPill({ active, onClick, label, count, alert }: { active: boolean; onClick: () => void; label: string; count?: number; alert?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-full text-[13px] font-bold transition-all border flex items-center gap-2 ${
        active
          ? 'bg-brand text-white border-brand shadow-[0_0_12px_rgba(20,227,196,0.25)]'
          : 'bg-card text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
      }`}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${active ? 'bg-black/30' : alert ? 'bg-amber-500/20 text-amber-400' : 'bg-raised'}`}>
          {count}
        </span>
      )}
    </button>
  );
}

function TabButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-5 py-2.5 rounded-full text-sm transition-all duration-300 ${
        active
          ? 'bg-brand text-white font-bold shadow-[0_0_10px_rgba(20,227,196,0.2)]'
          : 'text-zinc-400 font-semibold hover:text-white hover:bg-white/5'
      }`}
    >
      {label}
      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${active ? 'bg-black text-brand' : 'bg-raised text-zinc-500'}`}>
        {count}
      </span>
    </button>
  );
}

function BulkBtn({ icon: Icon, label, onClick, danger, minSelected, selectedCount, disabledHint }: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** How many rows this action needs to mean anything. Defaults to 1. */
  minSelected?: number;
  selectedCount?: number;
  disabledHint?: string;
}) {
  const short = minSelected !== undefined && (selectedCount ?? 0) < minSelected;
  return (
    <button
      disabled={short}
      title={short ? disabledHint : undefined}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent ${
        danger ? 'text-red-600 hover:bg-red-50' : 'text-zinc-600 hover:bg-white'
      }`}
    >
      <Icon size={15} />
      {label}
    </button>
  );
}

function LightSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-zinc-100 border-none rounded-full py-2.5 px-4 text-sm font-semibold text-zinc-600 focus:outline-none focus:ring-2 focus:ring-brand transition-all"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function LightCheckbox({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onChange(); }}
      className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${
        checked ? 'bg-brand border-brand' : 'border-zinc-300 hover:border-black'
      }`}
    >
      {checked && <Check size={12} strokeWidth={4} className="text-white" />}
    </button>
  );
}

function exportDocs(rows: Document[]) {
  const header = 'Client,Supplier,Date,Total,Category,Status,Channel,Inbox\n';
  const body = rows
    .map((d) => `"${d.clientName}","${d.supplier}","${d.date}",${d.total},"${d.category}","${d.status}","${d.source}","${d.kind}"`)
    .join('\n');
  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'inbox.csv';
  a.click();
  URL.revokeObjectURL(url);
}
