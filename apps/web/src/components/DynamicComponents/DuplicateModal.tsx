import { useState } from 'react';
import { Copy, X, Trash2, Layers, GitCompare, ArrowRight } from 'lucide-react';
import { motion } from 'motion/react';
import { useAppContext } from '../../context/AppContext';
import { DocumentPreview } from './DocumentPreview';
import { Pill } from './DataTable';
import { currency } from '../../lib/resolver';
import { useConfirm } from './ConfirmProvider';
import type { DuplicatePair } from '../../lib/types';

/**
 * Side-by-side compare, opened from anywhere in the dashboard rather than
 * through chat. The two copies sit next to each other with the signals that
 * flagged them, because "96% similar" on its own is a number to be trusted or
 * ignored — the signals are what let someone actually decide.
 *
 * Four outcomes, matching the ones the pipeline supports:
 *   Delete the copy        — the usual case, and recoverable
 *   Attach to the original — one document, two images of it
 *   Different documents    — the flag was wrong; teaches nothing away
 *   Keep both              — an intentional duplicate, which genuinely happens
 */
export function DuplicateModal({ pair, onClose }: { pair: DuplicatePair; onClose: () => void }) {
  const { documents, resolveDuplicate } = useAppContext();
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState<'left' | 'right' | null>(null);

  const left = documents.find((d) => d.id === pair.left.id);
  const right = documents.find((d) => d.id === pair.right.id);

  const decide = async (action: 'delete' | 'keep-both', label: string, consequence: string) => {
    const ok = await confirm({
      tone: action === 'delete' ? 'red' : 'brand',
      title: label,
      detail: `${pair.left.label} and ${pair.right.label}, ${Math.round(pair.similarity * 100)}% similar.`,
      consequence,
      confirmLabel: action === 'delete' ? 'Yes, delete the copy' : 'Yes, that is right',
    });
    if (!ok) return;
    resolveDuplicate(pair.id, action);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl my-auto border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden"
      >
        <div className="p-6 flex items-start justify-between gap-4 border-b border-white/5">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-12 h-12 rounded-2xl bg-amber-400/10 border border-amber-400/25 flex items-center justify-center text-amber-400 shrink-0">
              <Copy size={20} />
            </div>
            <div className="min-w-0">
              <h3 className="font-sans font-bold text-xl text-white tracking-tight">Suspected duplicate</h3>
              <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                {pair.clientName} · {Math.round(pair.similarity * 100)}% similar
                {pair.crossType ? ' · cross-type' : ''}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors shrink-0" aria-label="Close">
            <X size={20} />
          </button>
        </div>

        {/* Why it was flagged. Shown before the documents, because it is what
            tells you which of the four buttons below is the right one. */}
        <div className="px-6 py-4 bg-[#0a0a0c]/50 border-b border-white/5">
          <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2.5">
            Signals that flagged it
          </div>
          <div className="flex flex-wrap gap-2">
            {pair.signals.map((s) => (
              <span
                key={s}
                className={`px-2.5 py-1 rounded-lg text-[11.5px] font-semibold border ${
                  /differs|different/i.test(s)
                    ? 'text-zinc-500 bg-[#16161a] border-white/5'
                    : 'text-[#14e3c4] bg-[#14e3c4]/10 border-[#14e3c4]/20'
                }`}
              >
                {s}
              </span>
            ))}
          </div>
        </div>

        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Side title="This copy" pair={pair.left} onOpen={() => setExpanded('left')} hasDoc={!!left} />
          <Side title="Already on file" pair={pair.right} onOpen={() => setExpanded('right')} hasDoc={!!right} tone="muted" />
        </div>

        {expanded && (
          <div className="px-6 pb-6">
            <div className="flex items-center justify-between gap-3 mb-3">
              <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
                {expanded === 'left' ? 'This copy' : 'Already on file'} — the original, immutable
              </span>
              <button
                onClick={() => setExpanded(null)}
                className="text-[12px] font-bold text-zinc-500 hover:text-white transition-colors"
              >
                Hide
              </button>
            </div>
            <div className="flex justify-center">
              {(expanded === 'left' ? left : right) ? (
                <DocumentPreview document={(expanded === 'left' ? left : right)!} />
              ) : (
                <p className="text-[13px] text-zinc-500">That copy is no longer on file.</p>
              )}
            </div>
          </div>
        )}

        <div className="p-4 bg-[#202026]/50 flex items-center gap-2 justify-end flex-wrap">
          <button
            onClick={() => decide('keep-both', 'These are two different documents?', 'The flag is dismissed and both stay in the pipeline.')}
            title="The flag was wrong — these are two different documents"
            className="flex items-center gap-2 px-4 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 border border-white/5 hover:text-white hover:border-white/20 transition-colors"
          >
            <GitCompare size={14} />
            Different documents
          </button>
          <button
            onClick={() => decide('keep-both', 'Keep both copies?', 'Both stay and both will be published — an intentional duplicate.')}
            title="Two identical documents that both genuinely exist"
            className="flex items-center gap-2 px-4 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 border border-white/5 hover:text-white hover:border-white/20 transition-colors"
          >
            <Layers size={14} />
            Keep both
          </button>
          <button
            onClick={() => decide('keep-both', 'Attach this to the original?', 'They become one document with two images. The flag is cleared.')}
            title="One document, two images of it"
            className="flex items-center gap-2 px-4 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 border border-white/5 hover:text-white hover:border-white/20 transition-colors"
          >
            <ArrowRight size={14} />
            Attach to the original
          </button>
          <button
            onClick={() => decide('delete', `Delete the ${pair.right.type.toLowerCase()} copy?`, 'The copy and its original are removed. A deleted document cannot be matched to a bank line later.')}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-red-500 hover:bg-red-600 transition-colors"
          >
            <Trash2 size={14} />
            Delete the copy
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function Side({ title, pair, onOpen, hasDoc, tone = 'plain' }: {
  title: string;
  pair: DuplicatePair['left'];
  onOpen: () => void;
  hasDoc: boolean;
  tone?: 'plain' | 'muted';
}) {
  return (
    <div className={`rounded-2xl border p-5 flex flex-col gap-3 ${
      tone === 'muted' ? 'border-white/5 bg-[#0a0a0c]/40' : 'border-white/10 bg-[#0a0a0c]/70'
    }`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">{title}</span>
        <Pill>{pair.type}</Pill>
      </div>

      <div>
        <div className="text-[15px] font-bold text-white leading-tight">{pair.label}</div>
        <div className="text-2xl font-bold text-white tabular-nums mt-1">{currency(pair.total)}</div>
      </div>

      <div className="flex flex-col gap-1.5 text-[12.5px]">
        <Row label="Date" value={pair.date} />
        <Row label="Sent by" value={pair.uploader} />
      </div>

      <button
        onClick={onOpen}
        disabled={!hasDoc}
        className="mt-auto px-4 py-2 rounded-full text-[12px] font-bold text-[#14e3c4] bg-[#14e3c4]/10 border border-[#14e3c4]/20 hover:bg-[#14e3c4]/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {hasDoc ? 'View this document' : 'No longer on file'}
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline gap-3">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-300 font-semibold text-right truncate">{value}</span>
    </div>
  );
}
