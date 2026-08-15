import { useRef, useState } from 'react';
import { UploadCloud, X, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppContext } from '../../context/AppContext';
import { Pill } from '../../components/DynamicComponents/DataTable';
import { ACCEPTED_EXTENSIONS } from '../../lib/ingest';
import { PORTAL_UPLOAD_LIMIT } from '../../lib/business';
import { Panel } from './BusinessHomeView';
import type { BusinessAccount } from '../../lib/types';

/**
 * Send a file to the accountant. Rejections are shown with a reason rather than
 * silently dropped — a business that thinks a receipt went through and hasn't is
 * exactly how paperwork goes missing.
 */
export function BusinessUploadView({ account }: { account: BusinessAccount }) {
  const { ingest, documents } = useAppContext();
  const inputRef = useRef<HTMLInputElement>(null);

  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState('');
  const [accepted, setAccepted] = useState<{ name: string; size: number }[]>([]);
  const [rejected, setRejected] = useState<{ name: string; reason: string }[]>([]);

  const submit = (files: { name: string; size: number }[]) => {
    if (!files.length) return;

    const ok: { name: string; size: number }[] = [];
    const bad: { name: string; reason: string }[] = [];

    for (const f of files) {
      const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
      if (!ACCEPTED_EXTENSIONS.includes(ext)) {
        bad.push({ name: f.name, reason: `We can't read .${ext} files` });
      } else if (f.size > PORTAL_UPLOAD_LIMIT) {
        bad.push({ name: f.name, reason: `Over the ${Math.round(PORTAL_UPLOAD_LIMIT / 1024 / 1024)}MB limit — try splitting it` });
      } else {
        ok.push(f);
      }
    }

    if (ok.length) {
      ingest(ok, account.clientId, 'portal', {
        limit: PORTAL_UPLOAD_LIMIT,
        uploader: `${account.contactName} (business portal)`,
        // No kind: the business sends paperwork, it does not file it.
        // Extraction classifies money in vs money out.
        clientNote: note,
      });
      setAccepted((prev) => [...ok, ...prev].slice(0, 12));
      setNote('');
    }
    setRejected(bad);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    submit(Array.from(e.dataTransfer.files).map((f) => ({ name: f.name, size: f.size })));
  };

  const portalDocs = documents.filter((d) => d.clientId === account.clientId && d.source === 'portal').slice(0, 6);

  return (
    <div className="p-8 max-w-3xl mx-auto flex flex-col gap-6">
      <div>
        <h1 className="font-sans text-2xl font-bold text-white tracking-tight">Upload a document</h1>
        <p className="text-[13px] text-zinc-500 mt-1">
          Invoices, receipts, bills and statements — send them as they come. You do not need to sort them:
          we work out what each one is.
        </p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`rounded-[28px] border-2 border-dashed p-12 flex flex-col items-center justify-center text-center cursor-pointer transition-colors ${
          dragging ? 'border-[#14e3c4] bg-[#14e3c4]/5' : 'border-white/10 bg-[#16161a] hover:border-white/20'
        }`}
      >
        <div className="w-14 h-14 rounded-2xl bg-[#202026] border border-white/5 flex items-center justify-center text-zinc-300">
          <UploadCloud size={24} />
        </div>
        <p className="text-sm font-bold text-white mt-4">Drop files here, or click to choose</p>
        <p className="text-[12px] text-zinc-500 mt-1.5 max-w-sm leading-relaxed">
          PDF, JPG, PNG, HEIC, CSV or XLSX · up to {Math.round(PORTAL_UPLOAD_LIMIT / 1024 / 1024)}MB each. A PDF with
          several documents in it is split automatically.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            submit(Array.from(e.target.files ?? []).map((f) => ({ name: f.name, size: f.size })));
            e.target.value = '';
          }}
        />
      </div>

      <div>
        <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
          Note for your accountant (optional)
        </div>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. the Bidfood invoice for the July delivery"
          className="w-full bg-[#0a0a0c] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#14e3c4] transition-colors"
        />
      </div>

      <AnimatePresence>
        {rejected.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4"
          >
            <div className="flex items-center justify-between gap-3 mb-3">
              <span className="flex items-center gap-2 text-[13px] font-bold text-red-400">
                <AlertTriangle size={15} />
                {rejected.length} {rejected.length === 1 ? 'file' : 'files'} not sent
              </span>
              <button onClick={() => setRejected([])} className="text-zinc-500 hover:text-white">
                <X size={15} />
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              {rejected.map((r) => (
                <div key={r.name} className="text-[12px] text-zinc-400">
                  <span className="font-semibold text-white">{r.name}</span> — {r.reason}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {accepted.length > 0 && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
            <Panel title="Just sent" subtitle="Your accountant can see these already">
              <div className="flex flex-col gap-2">
                {accepted.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="flex items-center justify-between gap-4 p-3.5 rounded-2xl bg-[#0a0a0c]/60 border border-white/5">
                    <span className="flex items-center gap-3 min-w-0">
                      <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
                      <span className="text-[13px] font-semibold text-white truncate">{f.name}</span>
                    </span>
                    <span className="text-[11px] text-zinc-500 font-semibold shrink-0">
                      {(f.size / 1024 / 1024).toFixed(1)}MB
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          </motion.div>
        )}
      </AnimatePresence>

      {portalDocs.length > 0 && (
        <Panel title="Sent from this portal" subtitle="Live status from your accountant's system">
          <div className="flex flex-col gap-2">
            {portalDocs.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-4 p-3.5 rounded-2xl bg-[#0a0a0c]/60 border border-white/5">
                <span className="text-[13px] font-semibold text-white truncate">{d.supplier}</span>
                <Pill tone={d.status === 'processing' ? 'blue' : d.status === 'review' ? 'amber' : 'green'}>
                  {d.status === 'processing' ? 'Reading it' : d.status === 'review' ? 'With your accountant' : 'Accepted'}
                </Pill>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
