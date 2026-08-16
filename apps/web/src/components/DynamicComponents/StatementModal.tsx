import { X, Download, Check, AlertTriangle, Landmark, Building2 } from 'lucide-react';
import { motion } from 'motion/react';
import { Pill } from './DataTable';
import { currency } from '../../lib/resolver';
import type { Statement, SupplierStatement } from '../../lib/types';

/**
 * What was read off an uploaded statement, and a way to take it away.
 *
 * Bank and supplier statements are different documents doing different jobs —
 * one is an account's transactions, the other is a supplier's list of what
 * they invoiced — but the question asked of both is the same: what did you
 * get out of the file I sent you? So they share this window, and each shows
 * the part that matters. For a bank statement that is the balances and
 * whether they run continuously; for a supplier statement it is every line
 * and whether we hold a document for it.
 *
 * The original file itself is not retrievable in this build — uploads record
 * the name and the extraction, not the bytes — and the footer says so rather
 * than offering a download that would quietly hand over something else.
 */
export function StatementModal({ statement, onClose }: {
  statement: { kind: 'bank'; data: Statement } | { kind: 'supplier'; data: SupplierStatement };
  onClose: () => void;
}) {
  const isBank = statement.kind === 'bank';
  const data = statement.data;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={data.fileName}
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl my-auto border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden"
      >
        <div className="p-6 flex items-start justify-between gap-4 border-b border-white/5">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-12 h-12 rounded-2xl bg-raised border border-white/5 flex items-center justify-center text-zinc-400 shrink-0">
              {isBank ? <Landmark size={20} /> : <Building2 size={20} />}
            </div>
            <div className="min-w-0">
              <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">{data.fileName}</h3>
              <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                {isBank ? 'Bank statement' : `Supplier statement · ${(data as SupplierStatement).supplier}`}
                {' · '}{data.clientName}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors shrink-0" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 flex flex-col gap-5 max-h-[60vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {isBank ? <BankBody s={data as Statement} /> : <SupplierBody s={data as SupplierStatement} />}
        </div>

        <div className="p-4 bg-raised/50 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-[11.5px] text-zinc-600 leading-relaxed max-w-md">
            The download is what was read off the file, as CSV. The original upload is not kept in this build.
          </p>
          <button
            onClick={() => (isBank ? downloadBank(data as Statement) : downloadSupplier(data as SupplierStatement))}
            className="shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-[0_0_15px_rgba(20,227,196,0.25)]"
          >
            <Download size={15} strokeWidth={2.5} />
            Download CSV
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function BankBody({ s }: { s: Statement }) {
  const movement = s.closingBalance - s.openingBalance;
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Figure label="Period" value={s.period} />
        <Figure label="Rows read" value={s.rows ? String(s.rows) : '—'} />
        <Figure label="Opening" value={s.status === 'extracted' ? currency(s.openingBalance) : '—'} />
        <Figure label="Closing" value={s.status === 'extracted' ? currency(s.closingBalance) : '—'} />
      </div>

      {s.status === 'extracted' ? (
        <div className="p-4 rounded-2xl bg-ground/60 border border-white/5 shadow-inner flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-bold text-white">Movement over the period</div>
            <div className="text-[12px] text-zinc-500 mt-0.5">Closing less opening, across {s.rows} rows</div>
          </div>
          <span className={`text-lg font-bold tabular-nums shrink-0 ${movement < 0 ? 'text-red-400' : 'text-brand'}`}>
            {movement < 0 ? '−' : '+'}{currency(Math.abs(movement))}
          </span>
        </div>
      ) : (
        <div className="p-4 rounded-2xl bg-red-500/[0.07] border border-red-400/20 flex items-start gap-3">
          <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-[13px] font-bold text-white">
              {s.status === 'processing' ? 'Still extracting' : 'Nothing could be read'}
            </div>
            <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">
              {s.note ?? 'Extraction has not produced balances for this file yet.'}
            </p>
          </div>
        </div>
      )}

      <p className="text-[12px] text-zinc-500 leading-relaxed">
        Uploaded {s.uploadedAt}. Balances are what the gap detector compares — a closing balance that does not meet
        the next opening is how a missing statement is found.
      </p>
    </>
  );
}

function SupplierBody({ s }: { s: SupplierStatement }) {
  const missing = s.lines.filter((l) => !l.documentId);
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Figure label="Period" value={s.period} />
        <Figure label="Lines" value={String(s.lines.length)} />
        <Figure label="Statement total" value={currency(s.statementTotal)} />
        <Figure label="Not on file" value={String(missing.length)} tone={missing.length ? 'red' : 'plain'} />
      </div>

      <div>
        <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2.5">Every line, reconciled</div>
        <div className="flex flex-col gap-2">
          {s.lines.length === 0 && <p className="text-[13px] text-zinc-500">No lines read from this statement yet.</p>}
          {s.lines.map((l) => (
            <div key={l.reference} className="flex items-center gap-3 p-3.5 rounded-2xl bg-ground/60 border border-white/5">
              <span
                className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border ${
                  l.documentId
                    ? 'bg-brand/10 text-brand border-brand/25'
                    : 'bg-red-500/10 text-red-400 border-red-400/25'
                }`}
              >
                {l.documentId ? <Check size={13} strokeWidth={3} /> : <AlertTriangle size={13} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-bold text-white">{l.reference}</div>
                <div className="text-[12px] text-zinc-500">{l.date}</div>
              </div>
              <span className="text-[13px] font-bold text-white tabular-nums shrink-0">{currency(l.total)}</span>
              <span className="shrink-0 w-28 text-right">
                {l.documentId ? <Pill tone="green">On file</Pill> : <Pill tone="red">No document</Pill>}
              </span>
            </div>
          ))}
        </div>
      </div>

      <p className="text-[12px] text-zinc-500 leading-relaxed">
        Uploaded {s.uploadedAt}. A line with no document is an invoice the supplier says they sent and we do not
        hold — which is what makes it worth asking for the statement.
      </p>
    </>
  );
}

function Figure({ label, value, tone = 'plain' }: { label: string; value: string; tone?: 'plain' | 'red' }) {
  return (
    <div className="p-3.5 rounded-2xl bg-ground/60 border border-white/5 shadow-inner">
      <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">{label}</div>
      <div className={`text-[15px] font-bold mt-1 tabular-nums ${tone === 'red' && value !== '0' ? 'text-red-400' : 'text-white'}`}>
        {value}
      </div>
    </div>
  );
}

/* ── downloads ────────────────────────────────────────────────────────────── */

const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;

function save(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Named after the upload it came from, so the two stay associated. */
const csvName = (fileName: string) => `${fileName.replace(/\.[^.]+$/, '')}-extracted.csv`;

export function downloadBank(s: Statement) {
  const csv =
    'File,Client,Period,Rows,Opening,Closing,Movement,Status,Uploaded,Note\n' +
    [
      esc(s.fileName), esc(s.clientName), esc(s.period), s.rows,
      s.openingBalance, s.closingBalance, Math.round((s.closingBalance - s.openingBalance) * 100) / 100,
      esc(s.status), esc(s.uploadedAt), esc(s.note ?? ''),
    ].join(',');
  save(csvName(s.fileName), csv);
}

export function downloadSupplier(s: SupplierStatement) {
  // One row per line, because the lines are the point — a total on its own
  // cannot be reconciled against anything.
  const header = 'File,Client,Supplier,Period,Reference,Date,Total,On file,Document\n';
  const body = s.lines
    .map((l) =>
      [
        esc(s.fileName), esc(s.clientName), esc(s.supplier), esc(s.period),
        esc(l.reference), esc(l.date), l.total,
        l.documentId ? 'yes' : 'no', esc(l.documentId ?? ''),
      ].join(','),
    )
    .join('\n');
  save(csvName(s.fileName), header + body);
}
