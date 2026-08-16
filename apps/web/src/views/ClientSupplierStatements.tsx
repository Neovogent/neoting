import { useRef, useState } from 'react';
import { UploadCloud, Send, Trash2, ChevronRight, FileText, Check, AlertTriangle, Eye, Download } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppContext } from '../context/AppContext';
import { ChaseComposer } from '../components/DynamicComponents/ChaseComposer';
import { Modal } from './ApprovalsView';
import { Pill } from '../components/DynamicComponents/DataTable';
import { currency } from '../lib/resolver';
import type { Client, SupplierStatement } from '../lib/types';
import { useQueryParam } from '../lib/router';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { StatementModal, downloadSupplier } from '../components/DynamicComponents/StatementModal';

/**
 * A client's supplier statements. A statement is the supplier's own list of
 * what they invoiced in a period, so reconciling it against the documents on
 * file finds the invoices nobody knew were missing — the `supplier-statement`
 * detection engine, made visible.
 *
 * Deliberately not bank statements: those are one account's transactions and
 * live on the Bank tab.
 */
export function ClientSupplierStatements({ client }: { client: Client }) {
  const {
    supplierStatements, uploadSupplierStatement, deleteSupplierStatement,
  } = useAppContext();

  const fileRef = useRef<HTMLInputElement>(null);
  const [supplier, setSupplier] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  // ?statement=<id> — linkable like every other overlay.
  const [viewing, setViewing] = useQueryParam('statement');
  const confirm = useConfirm();
  const openStatement = supplierStatements.find((st) => st.id === viewing) ?? null;

  const mine = supplierStatements.filter((st) => st.clientId === client.id);
  const gapCount = mine.reduce((n, st) => n + st.lines.filter((l) => !l.documentId).length, 0);

  /**
   * Composes the chase here rather than opening the chat. The lines on a
   * statement are not tracked missing items, so the composer takes the
   * client's outstanding list — which is what it did before, just without
   * throwing the page away to do it.
   */
  const [chasingFor, setChasingFor] = useState<SupplierStatement | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-[13px] text-zinc-500 leading-relaxed max-w-2xl">
          What each supplier says they invoiced, checked against what we hold.
          {gapCount > 0
            ? ` ${gapCount} line${gapCount === 1 ? '' : 's'} on file have no document — those are the invoices to chase.`
            : ' Every line is matched to a document.'}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <input
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            placeholder="Supplier name"
            aria-label="Supplier name"
            className="w-44 bg-card border border-white/5 rounded-full py-2.5 px-4 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand shadow-inner"
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={!supplier.trim()}
            title={supplier.trim() ? 'Upload a statement' : 'Name the supplier first'}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-[0_0_15px_rgba(20,227,196,0.2)]"
          >
            <UploadCloud size={16} />
            Upload statement
          </button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".pdf,.tiff,.csv,.xlsx,.png,.jpg"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f && supplier.trim()) {
                uploadSupplierStatement(f.name, client.id, supplier.trim());
                setSupplier('');
              }
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {mine.length === 0 ? (
        <div className="border border-white/5 rounded-[32px] bg-card p-10 text-center shadow-2xl">
          <p className="text-[13px] text-zinc-500 leading-relaxed max-w-md mx-auto">
            No supplier statements yet. Ask a regular supplier for their monthly statement and upload it here — it is
            the fastest way to find invoices that never arrived.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {mine.map((st) => {
            const missing = st.lines.filter((l) => !l.documentId);
            const matched = st.lines.length - missing.length;
            const isOpen = open === st.id;
            return (
              <div key={st.id} className="border border-white/5 rounded-[28px] bg-card shadow-2xl overflow-hidden">
                <div className="p-5 flex items-center gap-4 flex-wrap">
                  <div className="w-10 h-11 rounded-xl bg-raised border border-white/5 flex items-center justify-center text-zinc-500 shrink-0">
                    <FileText size={16} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className="text-[15px] font-bold text-white">{st.supplier}</span>
                      {st.status === 'processing' && <Pill>Extracting…</Pill>}
                      {st.status === 'reconciled' && <Pill tone="green">Fully reconciled</Pill>}
                      {st.status === 'gaps' && (
                        <Pill tone="red">
                          {missing.length} missing invoice{missing.length === 1 ? '' : 's'}
                        </Pill>
                      )}
                      {st.status === 'failed' && <Pill tone="red">{st.note ?? 'Extraction failed'}</Pill>}
                    </div>
                    <div className="text-[12px] text-zinc-500 mt-1">
                      {st.period} · {st.fileName} · uploaded {st.uploadedAt}
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">Statement total</div>
                    <div className="text-lg font-bold text-white tabular-nums">{currency(st.statementTotal)}</div>
                    <div className="text-[11px] text-zinc-600">
                      {matched} of {st.lines.length} matched
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {missing.length > 0 && (
                      <button
                        onClick={() => setChasingFor(st)}
                        className="flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                      >
                        <Send size={13} />
                        Chase {missing.length}
                      </button>
                    )}
                    {/* Open the upload itself, and take the extraction away —
                        a statement nobody can look at is a filename in a list. */}
                    <button
                      onClick={() => setViewing(st.id)}
                      className="p-2 rounded-lg text-zinc-400 border border-white/5 hover:text-white hover:border-white/20 transition-colors"
                      title="See what was read off this statement"
                      aria-label="See what was read off this statement"
                    >
                      <Eye size={15} />
                    </button>
                    <button
                      onClick={() => downloadSupplier(st)}
                      className="p-2 rounded-lg text-zinc-400 border border-white/5 hover:text-white hover:border-white/20 transition-colors"
                      title="Download the extracted data as CSV"
                      aria-label="Download the extracted data as CSV"
                    >
                      <Download size={15} />
                    </button>
                    <button
                      onClick={() => setOpen(isOpen ? null : st.id)}
                      className="p-2 rounded-lg text-zinc-400 border border-white/5 hover:text-white hover:border-white/20 transition-colors"
                      title={isOpen ? 'Hide lines' : 'Show every line here'}
                      aria-label={isOpen ? 'Hide lines' : 'Show every line here'}
                    >
                      <ChevronRight size={15} className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    </button>
                    <button
                      onClick={async () => {
                        const ok = await confirm({
                          tone: 'red',
                          title: `Remove the ${st.supplier} statement?`,
                          detail: `${st.fileName} · ${st.period} · ${st.lines.length} lines.`,
                          consequence: missing.length > 0
                            ? `${missing.length} missing invoice${missing.length === 1 ? '' : 's'} were found from it — removing it loses that finding.`
                            : 'The reconciliation goes with it.',
                          confirmLabel: 'Yes, remove it',
                        });
                        if (ok) deleteSupplierStatement(st.id);
                      }}
                      className="p-2 rounded-lg text-zinc-600 border border-white/5 hover:text-red-400 hover:border-red-400/20 transition-colors"
                      title="Remove this statement"
                      aria-label="Remove this statement"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>

                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden border-t border-white/5"
                    >
                      <div className="p-5 flex flex-col gap-2">
                        {st.lines.length === 0 && (
                          <p className="text-[13px] text-zinc-500">No lines read from this statement yet.</p>
                        )}
                        {st.lines.map((l) => (
                          <div
                            key={l.reference}
                            className="flex items-center gap-3 p-3.5 rounded-2xl bg-ground/60 border border-white/5"
                          >
                            <span
                              className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                                l.documentId
                                  ? 'bg-brand/10 text-brand border border-brand/25'
                                  : 'bg-red-500/10 text-red-400 border border-red-400/25'
                              }`}
                            >
                              {l.documentId ? <Check size={13} strokeWidth={3} /> : <AlertTriangle size={13} />}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="text-[13px] font-bold text-white">{l.reference}</div>
                              <div className="text-[12px] text-zinc-500">{l.date}</div>
                            </div>
                            <span className="text-[13px] font-bold text-white tabular-nums shrink-0">
                              {currency(l.total)}
                            </span>
                            <span className="shrink-0 w-32 text-right">
                              {l.documentId ? (
                                <Pill tone="green">On file</Pill>
                              ) : (
                                <Pill tone="red">No document</Pill>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      )}

      {openStatement && (
        <StatementModal statement={{ kind: 'supplier', data: openStatement }} onClose={() => setViewing(null)} />
      )}

      {chasingFor && (
        <Modal onClose={() => setChasingFor(null)}>
          <div className="w-full flex flex-col items-center gap-3">
            <div className="w-full max-w-xl px-5 py-3 rounded-[20px] border border-white/5 bg-card shadow-2xl flex items-center justify-between gap-4">
              <p className="text-[12px] text-zinc-500 min-w-0">
                {chasingFor.supplier} say they invoiced{' '}
                {chasingFor.lines.filter((l) => !l.documentId).length} document(s) we do not hold.
              </p>
              <button
                onClick={() => setChasingFor(null)}
                className="shrink-0 px-4 py-1.5 rounded-full text-[12px] font-bold text-zinc-400 hover:text-white transition-colors"
              >
                Done
              </button>
            </div>
            <ChaseComposer clientIds={[client.id]} />
          </div>
        </Modal>
      )}
    </div>
  );
}
