import { Copy, Trash2, GitMerge, ShieldCheck } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { useConfirm } from './ConfirmProvider';
import { currency } from '../../lib/resolver';
import { Pill } from './DataTable';
import type { DuplicatePair } from '../../lib/types';

/**
 * Side-by-side duplicate comparison (PRD stage 6).
 * Multi-signal scoring, cross-document-type pairs, and an explicit
 * "keep both — intentional duplicate" escape that Dext lacks.
 */
export function DuplicateCompare({ pairs }: { pairs: DuplicatePair[] }) {
  const { resolveDuplicate, logAudit } = useAppContext();
  const confirm = useConfirm();

  if (pairs.length === 0) {
    return (
      <div className="w-full max-w-xl border border-white/5 rounded-[24px] bg-[#16161a] p-5 text-sm text-zinc-400">
        No duplicates flagged for this scope.
      </div>
    );
  }

  return (
    <div className="w-full max-w-3xl flex flex-col gap-4">
      {pairs.map((p) => (
        <div key={p.id} className="border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
          <div className="p-6 flex items-start justify-between gap-4 border-b border-white/5">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/10 flex items-center justify-center text-amber-400 shrink-0 border border-amber-500/20 shadow-inner">
                <Copy size={22} />
              </div>
              <div>
                <h3 className="font-sans font-bold text-xl text-white tracking-tight">
                  {Math.round(p.similarity * 100)}% similar
                </h3>
                <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">{p.clientName}</p>
              </div>
            </div>
            {p.crossType && <Pill tone="blue">Cross-type: invoice ↔ receipt</Pill>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-white/5">
            <DocSide side={p.left} />
            <DocSide side={p.right} />
          </div>

          <div className="px-6 py-4 border-t border-white/5">
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">Signals</div>
            <div className="flex flex-wrap gap-2">
              {p.signals.map((s) => (
                <Pill key={s}>{s}</Pill>
              ))}
            </div>
          </div>

          <div className="flex items-center bg-[#202026]/50 p-4 gap-3 flex-wrap">
            <button
              onClick={async () => {
                const ok = await confirm({
                  tone: 'red',
                  title: 'Delete the duplicate copy?',
                  detail: `${p.left.label} and ${p.right.label}, ${Math.round(p.similarity * 100)}% similar.`,
                  consequence: 'The copy is removed. A deleted document cannot be matched to a bank line later.',
                  confirmLabel: 'Yes, delete the copy',
                });
                if (!ok) return;
                resolveDuplicate(p.id, 'delete');
                logAudit({ action: 'Deleted duplicate', scope: `${p.right.label} — ${p.clientName}`, reviewOpened: true });
              }}
              className="flex-1 min-w-[160px] flex items-center justify-center gap-2 py-3 text-sm font-bold text-white bg-[#14e3c4] rounded-2xl hover:bg-[#0fcbaf] transition-all shadow-[0_0_15px_rgba(20,227,196,0.2)]"
            >
              <Trash2 size={16} />
              Delete duplicate
            </button>
            <button
              onClick={async () => {
                const ok = await confirm({
                  tone: 'brand',
                  title: 'Attach this to the original?',
                  detail: `${p.left.label} and ${p.right.label}, ${Math.round(p.similarity * 100)}% similar.`,
                  consequence: 'They become one document with two images. The flag is cleared.',
                  confirmLabel: 'Yes, that is right',
                });
                if (!ok) return;
                resolveDuplicate(p.id, 'keep-both');
                logAudit({ action: 'Merged as evidence', scope: `${p.left.label} + ${p.right.label}`, reviewOpened: true });
              }}
              className="flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 rounded-2xl transition-colors border border-white/5 bg-[#16161a] shadow-inner"
            >
              <GitMerge size={16} />
              Attach to original
            </button>
            <button
              onClick={async () => {
                const ok = await confirm({
                  tone: 'brand',
                  title: 'Keep both copies?',
                  detail: `${p.left.label} and ${p.right.label}, ${Math.round(p.similarity * 100)}% similar.`,
                  consequence: 'Both stay and both will be published — an intentional duplicate.',
                  confirmLabel: 'Yes, that is right',
                });
                if (!ok) return;
                resolveDuplicate(p.id, 'keep-both');
                logAudit({ action: 'Kept both — intentional duplicate', scope: `${p.left.label} — ${p.clientName}`, reviewOpened: true });
              }}
              className="flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 rounded-2xl transition-colors border border-white/5 bg-[#16161a] shadow-inner"
              title="Force a legitimate duplicate through"
            >
              <ShieldCheck size={16} />
              Keep both
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function DocSide({ side }: { side: DuplicatePair['left'] }) {
  return (
    <div className="p-6">
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">{side.type}</div>
      <div className="font-sans font-bold text-white text-lg tracking-tight mb-3">{side.label}</div>
      <div className="flex flex-col gap-2.5 text-[13px]">
        <Row label="Total" value={currency(side.total)} />
        <Row label="Date" value={side.date} />
        <Row label="Uploader" value={side.uploader} />
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center gap-3">
      <span className="text-zinc-500 font-medium shrink-0">{label}</span>
      <span className="text-white font-bold text-right truncate">{value}</span>
    </div>
  );
}
