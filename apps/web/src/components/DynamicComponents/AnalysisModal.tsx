import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, ArrowRight, Check, Loader2, ScanLine, Sparkles, Table2, X } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { DocumentPreview } from './DocumentPreview';
import type { SheetImport } from '../../lib/tableImport';
import type { DocKind, Document } from '../../lib/types';

/**
 * What happened to the file you just uploaded.
 *
 * Dropping a document used to end with a table quietly gaining a row, which
 * asks the person to work out where it went and whether anything was read off
 * it. Extraction is the moment the product does its actual work, so it is
 * shown: the pass runs on screen, then every figure it found, then the two
 * calls it made — whose this is, and whether it is money in or money out.
 *
 * Both calls are editable here, before anything is filed. A model that decides
 * silently is one people stop trusting the first time it is wrong; a model that
 * shows its answer next to a control that changes it is one they correct in a
 * second and carry on.
 */

/** A spreadsheet is read, not scanned, and the steps should say so. */
const SHEET_STEPS = [
  { label: 'Opening the file', detail: 'CSV straight through; XLSX unzipped first' },
  { label: 'Matching the columns', detail: 'Date, party, amount, VAT, reference' },
  { label: 'Working out what it is', detail: 'A bank export, or a list of documents' },
  { label: 'Reading every row', detail: 'One record per row, totals lines skipped' },
];

const STEPS = [
  { label: 'Reading the pages', detail: 'Text and layout off the original' },
  { label: 'Pulling out the figures', detail: 'Totals, tax, dates, references' },
  { label: 'Working out whose it is', detail: 'Bill-to block against your clients' },
  { label: 'Money in or money out', detail: 'Deciding which inbox it belongs in' },
];

export function AnalysisModal({ docIds, importIds = [], onClose, lockedClientId }: {
  docIds: string[];
  /** Spreadsheet tickets being read alongside, if any. */
  importIds?: string[];
  onClose: (settled: Document[]) => void;
  /** Set on a client's own inbox, where whose it is was never in question. */
  lockedClientId?: string;
}) {
  const { documents, clients, moveDocuments, setDocumentKind, sheetImports } = useAppContext();
  const [step, setStep] = useState(0);
  const [index, setIndex] = useState(0);

  const mine = useMemo(
    () => docIds.map((id) => documents.find((d) => d.id === id)).filter(Boolean) as Document[],
    [docIds, documents],
  );
  const sheets = useMemo(
    () => importIds.map((id) => sheetImports.find((t) => t.id === id)).filter(Boolean) as SheetImport[],
    [importIds, sheetImports],
  );
  const readingSheets = sheets.some((t) => t.status === 'reading');
  /** A lone import is named in the heading; two or more are only counted. */
  const onlySheet = sheets.length === 1 ? sheets[0] : undefined;

  // A spreadsheet import produces no document to walk through: the result is
  // the sheet itself — what it turned out to be and where its rows went.
  const sheetOnly = sheets.length > 0 && docIds.length === 0;
  const pending = readingSheets || (!sheetOnly && (mine.some((d) => d.status === 'processing') || mine.length === 0));

  /**
   * The panel stays up until the steps have finished saying what happened.
   *
   * A three-row CSV parses in about a millisecond, so gating purely on the
   * work would flash four labels past too fast to read and land the person on
   * a result with no idea how it was reached. The steps are a narration of a
   * real sequence, not a fake progress bar — each one names something that
   * actually ran — so they are allowed to finish.
   */
  const [narrated, setNarrated] = useState(false);
  const analysing = pending || !narrated;
  const current = mine[Math.min(index, mine.length - 1)];

  useEffect(() => {
    if (narrated) return;
    const t = window.setInterval(() => {
      setStep((s) => {
        if (s >= STEPS.length - 1) { setNarrated(true); return s; }
        return s + 1;
      });
    }, 620);
    return () => window.clearInterval(t);
  }, [narrated]);

  const kindOf = (d: Document) => d.fields.find((f) => f.label === 'Document type');
  const clientField = (d: Document) => d.fields.find((f) => f.label === 'Client');

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/75 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Analysing upload"
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="w-full max-w-3xl my-auto"
      >
        <AnimatePresence mode="wait">
          {analysing ? (
            <motion.div
              key="scanning"
              exit={{ opacity: 0, scale: 0.98 }}
              className="rounded-[32px] border border-white/10 bg-card p-10 shadow-2xl"
            >
              <div className="flex items-center gap-3 mb-8">
                <span className="relative flex items-center justify-center w-11 h-11 rounded-2xl bg-brand/15">
                  {readingSheets ? <Table2 size={20} className="text-brand" /> : <ScanLine size={20} className="text-brand" />}
                  <motion.span
                    className="absolute inset-0 rounded-2xl border border-brand/40"
                    animate={{ opacity: [0.2, 0.8, 0.2] }}
                    transition={{ duration: 1.4, repeat: Infinity }}
                  />
                </span>
                <div>
                  <h2 className="text-lg font-bold text-white">
                    {readingSheets
                      ? `Reading ${onlySheet ? onlySheet.fileName : `${sheets.length} spreadsheets`}`
                      : `Reading ${docIds.length === 1 ? 'your document' : `${docIds.length} documents`}`}
                  </h2>
                  <p className="text-[13px] text-zinc-500">
                    {readingSheets
                      ? 'Working out what the columns are, then reading every row.'
                      : 'This takes a few seconds. Nothing is filed until you have seen it.'}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                {(readingSheets ? SHEET_STEPS : STEPS).map((s, i) => {
                  const done = i < step;
                  const active = i === step;
                  return (
                    <div
                      key={s.label}
                      className={`flex items-center gap-3 px-4 py-3 rounded-2xl border transition-colors ${
                        active ? 'border-brand/30 bg-brand/[0.07]' : 'border-white/5 bg-white/[0.02]'
                      }`}
                    >
                      <span className="w-5 shrink-0">
                        {done ? (
                          <Check size={16} className="text-brand" />
                        ) : active ? (
                          <Loader2 size={16} className="text-brand animate-spin" />
                        ) : (
                          <span className="block w-2 h-2 rounded-full bg-zinc-700 mx-1" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <div className={`text-[13px] font-bold ${done || active ? 'text-white' : 'text-zinc-600'}`}>{s.label}</div>
                        <div className="text-[11.5px] text-zinc-500">{s.detail}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          ) : (
            <motion.div key="result" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
              {/* Each spreadsheet: what it turned out to be, and where its rows went. */}
              {sheets.map((sheet) => (
                <SheetResult key={sheet.id} sheet={sheet} onDone={() => onClose(mine)} />
              ))}

              {/* What the AI decided about a scanned document, and the controls
                  that overrule it. A sheet import has no such call to make. */}
              {current && (
              <div className="rounded-[28px] border border-white/10 bg-card p-6 shadow-2xl">
                <div className="flex items-start justify-between gap-4 mb-5">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Sparkles size={17} className="text-brand shrink-0" />
                    <div className="min-w-0">
                      <h2 className="text-[15px] font-bold text-white truncate">
                        {mine.length === 1 ? 'Read — check the two calls below' : `Read ${mine.length} documents — check the calls below`}
                      </h2>
                      <p className="text-[12px] text-zinc-500">Change anything that is wrong. Nothing is filed until you confirm.</p>
                    </div>
                  </div>
                  <button
                    onClick={() => onClose(mine)}
                    aria-label="Close"
                    className="shrink-0 p-2 rounded-full text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>

                {current && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {/* Decision 1 — whose it is */}
                    {!lockedClientId && (
                      <Decision
                        title="Client"
                        confidence={clientField(current)?.confidence}
                        provenance={clientField(current)?.provenance}
                      >
                        <select
                          value={current.clientId}
                          onChange={(e) => moveDocuments([current.id], e.target.value)}
                          className="w-full px-3 py-2 rounded-xl bg-raised border border-white/10 text-[13px] font-bold text-white focus:outline-none focus:border-brand/50"
                        >
                          {clients.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      </Decision>
                    )}

                    {/* Decision 2 — which way the money went */}
                    <Decision
                      title="Money in or out"
                      confidence={kindOf(current)?.confidence}
                      provenance={kindOf(current)?.provenance}
                    >
                      <div className="flex gap-2">
                        {(['cost', 'sales'] as DocKind[]).map((k) => (
                          <button
                            key={k}
                            onClick={() => setDocumentKind(current.id, k)}
                            className={`flex-1 px-3 py-2 rounded-xl text-[13px] font-bold border transition-colors ${
                              current.kind === k
                                ? 'bg-brand/15 border-brand/40 text-brand'
                                : 'bg-raised border-white/10 text-zinc-400 hover:text-white'
                            }`}
                          >
                            {k === 'cost' ? 'Money out — Costs' : 'Money in — Sales'}
                          </button>
                        ))}
                      </div>
                    </Decision>
                  </div>
                )}

              </div>
              )}

              {/* Every figure it found, in the same preview used everywhere else */}
              {current && <DocumentPreview document={current} />}

              {/* Confirm sits under the figures, not above them: the button
                  asks "does this look right?", so it belongs after the thing
                  being looked at rather than before it. */}
              {!sheetOnly && (
              <div className="flex items-center justify-between gap-4 rounded-[28px] border border-white/10 bg-card px-6 py-4 shadow-2xl">
                <p className="text-[12px] text-zinc-500 min-w-0 truncate">
                  {mine.length > 1 ? `Document ${index + 1} of ${mine.length}` : current?.supplier}
                </p>
                <div className="flex items-center gap-2 shrink-0">
                  {index < mine.length - 1 && (
                    <button
                      onClick={() => setIndex((i) => i + 1)}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold bg-raised text-white hover:bg-card transition-colors"
                    >
                      Next document
                      <ArrowRight size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => onClose(mine)}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold bg-brand text-white hover:bg-brand-hover transition-colors"
                  >
                    <Check size={15} />
                    {index < mine.length - 1 ? 'Take me to the inbox' : 'Looks right'}
                  </button>
                </div>
              </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

/**
 * What came out of a spreadsheet.
 *
 * The point of this panel is accountability for a bulk action: a hundred rows
 * have just entered the ledger's queue on the strength of some column matching,
 * and the accountant needs to see which columns were matched, which were
 * ignored, and which rows were refused — before any of it publishes. Silence
 * here would mean trusting an import nobody could check.
 */
function SheetResult({ sheet, onDone }: { sheet: SheetImport; onDone: () => void }) {
  const failed = sheet.status === 'failed';
  const { cost, sales, transactions } = sheet.counts;
  const total = cost + sales + transactions;

  const mapped = sheet.mapping
    ? (Object.entries(sheet.mapping) as [string, number][])
        .filter(([, at]) => at !== undefined)
        .map(([role, at]) => ({ role, header: sheet.headers?.[at] ?? `column ${at + 1}` }))
    : [];

  return (
    <div className="rounded-[28px] border border-white/10 bg-card p-6 shadow-2xl">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2.5 min-w-0">
          {failed ? (
            <AlertTriangle size={17} className="text-red-400 shrink-0" />
          ) : (
            <Table2 size={17} className="text-brand shrink-0" />
          )}
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold text-white truncate">{sheet.fileName}</h2>
            <p className="text-[12px] text-zinc-500">
              {failed
                ? sheet.error
                : `Read as ${sheet.sheetKind === 'bank' ? 'a bank statement' : 'a list of documents'} — ${sheet.reason}.`}
            </p>
          </div>
        </div>
        <button
          onClick={onDone}
          className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold bg-brand text-white hover:bg-brand-hover transition-colors"
        >
          <Check size={14} />
          Done
        </button>
      </div>

      {!failed && (
        <>
          <div className="grid grid-cols-3 gap-2 mt-5">
            <Count label="Costs" value={cost} />
            <Count label="Sales" value={sales} />
            <Count label="Bank lines" value={transactions} />
          </div>

          <div className="mt-4 pt-4 border-t border-white/5 space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-widest text-zinc-500">Columns used</p>
            <div className="flex flex-wrap gap-1.5">
              {mapped.map(({ role, header }) => (
                <span key={role} className="px-2.5 py-1 rounded-full text-[11px] font-bold text-brand bg-brand/10">
                  {header} → {ROLE_NAMES[role] ?? role}
                </span>
              ))}
              {sheet.unmapped?.map((header) => (
                <span key={header} className="px-2.5 py-1 rounded-full text-[11px] font-bold text-zinc-500 bg-white/[0.04]" title="Kept in the file, not used">
                  {header} — ignored
                </span>
              ))}
            </div>
          </div>

          {sheet.skipped.length > 0 && (
            <p className="text-[11.5px] text-amber-400 mt-3 leading-snug">
              {sheet.skipped.length} row{sheet.skipped.length === 1 ? '' : 's'} skipped —{' '}
              {[...new Set(sheet.skipped.map((r) => r.reason))].join('; ')}.
            </p>
          )}

          {total === 0 && (
            <p className="text-[11.5px] text-amber-400 mt-3">
              Nothing was imported. Check the file has a heading row above its data.
            </p>
          )}
        </>
      )}
    </div>
  );
}

const ROLE_NAMES: Record<string, string> = {
  date: 'date',
  party: 'supplier or customer',
  description: 'description',
  amount: 'total',
  moneyIn: 'money in',
  moneyOut: 'money out',
  tax: 'VAT',
  category: 'category',
  reference: 'reference',
  balance: 'balance',
};

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className={`p-3 rounded-2xl border text-center ${value ? 'border-brand/25 bg-brand/[0.07]' : 'border-white/5 bg-white/[0.02]'}`}>
      <div className={`text-xl font-bold tabular-nums ${value ? 'text-brand' : 'text-zinc-600'}`}>{value}</div>
      <div className="text-[11px] font-bold uppercase tracking-widest text-zinc-500 mt-0.5">{label}</div>
    </div>
  );
}

/** One AI call: what it decided, how sure it was, and the way to overrule it. */
function Decision({ title, confidence, provenance, children }: {
  title: string;
  /** Absent when the field carried no score — the panel then shows no badge. */
  confidence?: number | undefined;
  provenance?: string | undefined;
  children: React.ReactNode;
}) {
  const pct = confidence === undefined ? null : Math.round(confidence * 100);
  const unsure = pct !== null && pct < 70;

  return (
    <div className="p-4 rounded-2xl border border-white/5 bg-white/[0.02]">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[11px] font-bold uppercase tracking-widest text-zinc-500">{title}</span>
        {pct !== null && (
          <span
            className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
              unsure ? 'text-amber-400 bg-amber-400/10' : 'text-brand bg-brand/10'
            }`}
          >
            {pct}% sure
          </span>
        )}
      </div>
      {children}
      {provenance && (
        <p className="text-[11px] text-zinc-500 mt-2 leading-snug">
          {provenance.charAt(0).toUpperCase() + provenance.slice(1)}.
        </p>
      )}
    </div>
  );
}
