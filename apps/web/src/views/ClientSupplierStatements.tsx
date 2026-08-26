import { useRef, useState } from 'react';
import { UploadCloud, Send, Trash2, ChevronRight, FileText, Check, AlertTriangle, Eye, Download } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
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
 * The lead is two whole messages rather than one with a tail appended: which
 * sentence follows is a different statement about the same file, and where it
 * sits in the paragraph is exactly what moves between languages.
 */
const m = defineMessages({
  intro: {
    id: 'analytics.clientSupplierStatements.intro',
    defaultMessage:
      'What each supplier says they invoiced, checked against what we hold. Every line is matched to a document.',
  },
  introGaps: {
    id: 'analytics.clientSupplierStatements.introGaps',
    defaultMessage:
      'What each supplier says they invoiced, checked against what we hold. {count, plural, one {# line} other {# lines}} on file have no document — those are the invoices to chase.',
  },
  supplierPlaceholder: {
    id: 'analytics.clientSupplierStatements.supplierPlaceholder',
    defaultMessage: 'Supplier name',
  },
  uploadReady: {
    id: 'analytics.clientSupplierStatements.uploadReady',
    defaultMessage: 'Upload a statement',
  },
  uploadBlocked: {
    id: 'analytics.clientSupplierStatements.uploadBlocked',
    defaultMessage: 'Name the supplier first',
  },
  uploadAction: {
    id: 'analytics.clientSupplierStatements.uploadAction',
    defaultMessage: 'Upload statement',
  },
  empty: {
    id: 'analytics.clientSupplierStatements.empty',
    defaultMessage:
      'No supplier statements yet. Ask a regular supplier for their monthly statement and upload it here — it is the fastest way to find invoices that never arrived.',
  },
  statusExtracting: {
    id: 'analytics.clientSupplierStatements.statusExtracting',
    defaultMessage: 'Extracting…',
  },
  statusReconciled: {
    id: 'analytics.clientSupplierStatements.statusReconciled',
    defaultMessage: 'Fully reconciled',
  },
  statusMissing: {
    id: 'analytics.clientSupplierStatements.statusMissing',
    defaultMessage: '{count, plural, one {# missing invoice} other {# missing invoices}}',
  },
  statusFailed: {
    id: 'analytics.clientSupplierStatements.statusFailed',
    defaultMessage: 'Extraction failed',
  },
  statementMeta: {
    id: 'analytics.clientSupplierStatements.statementMeta',
    defaultMessage: '{period} · {fileName} · uploaded {uploadedAt}',
  },
  statementTotal: {
    id: 'analytics.clientSupplierStatements.statementTotal',
    defaultMessage: 'Statement total',
  },
  matchedCount: {
    id: 'analytics.clientSupplierStatements.matchedCount',
    defaultMessage: '{matched} of {total} matched',
  },
  chaseAction: { id: 'analytics.clientSupplierStatements.chaseAction', defaultMessage: 'Chase {count}' },
  viewExtraction: {
    id: 'analytics.clientSupplierStatements.viewExtraction',
    defaultMessage: 'See what was read off this statement',
  },
  downloadCsv: {
    id: 'analytics.clientSupplierStatements.downloadCsv',
    defaultMessage: 'Download the extracted data as CSV',
  },
  hideLines: { id: 'analytics.clientSupplierStatements.hideLines', defaultMessage: 'Hide lines' },
  showLines: { id: 'analytics.clientSupplierStatements.showLines', defaultMessage: 'Show every line here' },
  removeStatement: {
    id: 'analytics.clientSupplierStatements.removeStatement',
    defaultMessage: 'Remove this statement',
  },
  removeTitle: {
    id: 'analytics.clientSupplierStatements.removeTitle',
    defaultMessage: 'Remove the {supplier} statement?',
  },
  removeDetail: {
    id: 'analytics.clientSupplierStatements.removeDetail',
    defaultMessage: '{fileName} · {period} · {count} lines.',
  },
  removeConsequenceGaps: {
    id: 'analytics.clientSupplierStatements.removeConsequenceGaps',
    defaultMessage:
      '{count, plural, one {# missing invoice} other {# missing invoices}} were found from it — removing it loses that finding.',
  },
  removeConsequence: {
    id: 'analytics.clientSupplierStatements.removeConsequence',
    defaultMessage: 'The reconciliation goes with it.',
  },
  removeConfirm: {
    id: 'analytics.clientSupplierStatements.removeConfirm',
    defaultMessage: 'Yes, remove it',
  },
  noLines: {
    id: 'analytics.clientSupplierStatements.noLines',
    defaultMessage: 'No lines read from this statement yet.',
  },
  lineOnFile: { id: 'analytics.clientSupplierStatements.lineOnFile', defaultMessage: 'On file' },
  lineNoDocument: {
    id: 'analytics.clientSupplierStatements.lineNoDocument',
    defaultMessage: 'No document',
  },
  chaseSummary: {
    id: 'analytics.clientSupplierStatements.chaseSummary',
    defaultMessage: '{supplier} say they invoiced {count} document(s) we do not hold.',
  },
  chaseDone: { id: 'analytics.clientSupplierStatements.chaseDone', defaultMessage: 'Done' },
});

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
  const intl = useIntl();
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
      <div data-tour="ss-header" className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-[13px] text-zinc-500 leading-relaxed max-w-2xl">
          {intl.formatMessage(gapCount > 0 ? m.introGaps : m.intro, { count: gapCount })}
        </p>
        <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
          <input
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            placeholder={intl.formatMessage(m.supplierPlaceholder)}
            aria-label={intl.formatMessage(m.supplierPlaceholder)}
            className="w-full sm:w-44 bg-card border border-white/5 rounded-full py-2.5 px-4 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand shadow-inner"
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={!supplier.trim()}
            title={intl.formatMessage(supplier.trim() ? m.uploadReady : m.uploadBlocked)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-btn-soft"
          >
            <UploadCloud size={16} />
            {intl.formatMessage(m.uploadAction)}
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
        <div className="border border-white/5 rounded-[32px] bg-card p-4 md:p-10 text-center shadow-2xl">
          <p className="text-[13px] text-zinc-500 leading-relaxed max-w-md mx-auto">
            {intl.formatMessage(m.empty)}
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
                      {st.status === 'processing' && <Pill>{intl.formatMessage(m.statusExtracting)}</Pill>}
                      {st.status === 'reconciled' && <Pill tone="green">{intl.formatMessage(m.statusReconciled)}</Pill>}
                      {st.status === 'gaps' && (
                        <Pill tone="red">
                          {intl.formatMessage(m.statusMissing, { count: missing.length })}
                        </Pill>
                      )}
                      {st.status === 'failed' && <Pill tone="red">{st.note ?? intl.formatMessage(m.statusFailed)}</Pill>}
                    </div>
                    <div className="text-[12px] text-zinc-500 mt-1">
                      {intl.formatMessage(m.statementMeta, {
                        period: st.period,
                        fileName: st.fileName,
                        uploadedAt: st.uploadedAt,
                      })}
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">{intl.formatMessage(m.statementTotal)}</div>
                    <div className="text-lg font-bold text-white tabular-nums">{currency(st.statementTotal)}</div>
                    <div className="text-[11px] text-zinc-600">
                      {intl.formatMessage(m.matchedCount, { matched, total: st.lines.length })}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {missing.length > 0 && (
                      <button
                        onClick={() => setChasingFor(st)}
                        className="flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                      >
                        <Send size={13} />
                        {intl.formatMessage(m.chaseAction, { count: missing.length })}
                      </button>
                    )}
                    {/* Open the upload itself, and take the extraction away —
                        a statement nobody can look at is a filename in a list. */}
                    <button
                      onClick={() => setViewing(st.id)}
                      className="p-2 rounded-lg text-zinc-400 border border-white/5 hover:text-white hover:border-white/20 transition-colors"
                      title={intl.formatMessage(m.viewExtraction)}
                      aria-label={intl.formatMessage(m.viewExtraction)}
                    >
                      <Eye size={15} />
                    </button>
                    <button
                      onClick={() => downloadSupplier(st)}
                      className="p-2 rounded-lg text-zinc-400 border border-white/5 hover:text-white hover:border-white/20 transition-colors"
                      title={intl.formatMessage(m.downloadCsv)}
                      aria-label={intl.formatMessage(m.downloadCsv)}
                    >
                      <Download size={15} />
                    </button>
                    <button
                      onClick={() => setOpen(isOpen ? null : st.id)}
                      className="p-2 rounded-lg text-zinc-400 border border-white/5 hover:text-white hover:border-white/20 transition-colors"
                      title={intl.formatMessage(isOpen ? m.hideLines : m.showLines)}
                      aria-label={intl.formatMessage(isOpen ? m.hideLines : m.showLines)}
                    >
                      <ChevronRight size={15} className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    </button>
                    <button
                      onClick={async () => {
                        const ok = await confirm({
                          tone: 'red',
                          title: intl.formatMessage(m.removeTitle, { supplier: st.supplier }),
                          detail: intl.formatMessage(m.removeDetail, {
                            fileName: st.fileName,
                            period: st.period,
                            count: st.lines.length,
                          }),
                          consequence: missing.length > 0
                            ? intl.formatMessage(m.removeConsequenceGaps, { count: missing.length })
                            : intl.formatMessage(m.removeConsequence),
                          confirmLabel: intl.formatMessage(m.removeConfirm),
                        });
                        if (ok) deleteSupplierStatement(st.id);
                      }}
                      className="p-2 rounded-lg text-zinc-600 border border-white/5 hover:text-red-400 hover:border-red-400/20 transition-colors"
                      title={intl.formatMessage(m.removeStatement)}
                      aria-label={intl.formatMessage(m.removeStatement)}
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
                          <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.noLines)}</p>
                        )}
                        {st.lines.map((l) => (
                          <div
                            key={l.reference}
                            className="flex items-center gap-3 p-3.5 rounded-2xl bg-ground/60 border border-white/5 flex-wrap"
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
                            <span className="shrink-0 sm:w-32 text-right basis-full sm:basis-auto pl-10 sm:pl-0 flex sm:block">
                              {l.documentId ? (
                                <Pill tone="green">{intl.formatMessage(m.lineOnFile)}</Pill>
                              ) : (
                                <Pill tone="red">{intl.formatMessage(m.lineNoDocument)}</Pill>
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
                {intl.formatMessage(m.chaseSummary, {
                  supplier: chasingFor.supplier,
                  count: chasingFor.lines.filter((l) => !l.documentId).length,
                })}
              </p>
              <button
                onClick={() => setChasingFor(null)}
                className="shrink-0 px-4 py-1.5 rounded-full text-[12px] font-bold text-zinc-400 hover:text-white transition-colors"
              >
                {intl.formatMessage(m.chaseDone)}
              </button>
            </div>
            <ChaseComposer clientIds={[client.id]} />
          </div>
        </Modal>
      )}
    </div>
  );
}
