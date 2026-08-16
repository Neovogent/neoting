import { ArrowLeftRight, FileText, Landmark, LucideIcon, Unlink } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { useConfirm } from './ConfirmProvider';
import { currency } from '../../lib/resolver';
import { Pill } from './DataTable';
import type { Match } from '../../lib/types';

const KIND_LABEL: Record<Match['kind'], { label: string; tone: 'green' | 'blue' | 'amber' | 'neutral' }> = {
  exact: { label: 'Exact match', tone: 'green' },
  'credit-note': { label: 'Credit note / refund', tone: 'blue' },
  partial: { label: 'Batch payment', tone: 'blue' },
  probable: { label: 'Probable — needs evidence', tone: 'amber' },
};

/**
 * Bank match cards (PRD stage 7). Probable matches are always visually
 * distinct from exact ones; every link shows its confidence and can be undone.
 */
export function MatchCard({ matches }: { matches: Match[] }) {
  const { logAudit, unmatchTransaction } = useAppContext();
  const confirm = useConfirm();

  if (matches.length === 0) {
    return (
      <div className="w-full max-w-xl border border-white/5 rounded-[24px] bg-card p-5 text-sm text-zinc-400">
        No bank matches for this scope.
      </div>
    );
  }

  return (
    <div className="w-full max-w-3xl flex flex-col gap-3">
      {matches.map((m) => {
        const kind = KIND_LABEL[m.kind];
        const isProbable = m.kind === 'probable';
        return (
          <div
            key={m.id}
            className={`border rounded-[28px] bg-card shadow-2xl overflow-hidden ${
              isProbable ? 'border-amber-500/30 border-dashed' : 'border-white/5'
            }`}
          >
            <div className="p-5 flex items-center justify-between gap-3 border-b border-white/5">
              <Pill tone={kind.tone}>{kind.label}</Pill>
              <div className="flex items-center gap-3">
                <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
                  {Math.round(m.confidence * 100)}% confidence
                </span>
                <div className="w-20 h-1.5 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${isProbable ? 'bg-amber-400' : 'bg-brand'}`}
                    style={{ width: `${Math.round(m.confidence * 100)}%` }}
                  />
                </div>
              </div>
            </div>

            <div className="p-5 grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-center gap-4">
              <Side icon={FileText} label="Document" value={m.documentLabel} muted={m.documentLabel.startsWith('No document')} />
              <div className="hidden sm:flex w-9 h-9 rounded-xl bg-raised border border-white/5 items-center justify-center text-zinc-500 shadow-inner">
                <ArrowLeftRight size={16} />
              </div>
              <Side icon={Landmark} label="Transaction" value={m.transactionLabel} />
            </div>

            <div className="px-5 pb-5">
              <p className="text-[12px] text-zinc-500 leading-relaxed">{m.reason}</p>
            </div>

            <div className="flex items-center justify-between bg-raised/50 px-5 py-3 gap-3">
              <span className="text-sm font-bold text-white">{currency(m.amount)}</span>
              <button
                onClick={async () => {
                  const ok = await confirm({
                  tone: 'red',
                  title: 'Break this match?',
                  detail: `${m.documentLabel} and ${m.transactionLabel}.`,
                  consequence: 'The transaction goes back to having no evidence, which makes it a missing item again.',
                  confirmLabel: 'Yes, unmatch',
                });
                if (!ok) return;
                unmatchTransaction(m.id);
                  logAudit({ action: 'Unmatched document from transaction', scope: m.documentLabel, reviewOpened: true });
                }}
                className="flex items-center gap-2 px-4 py-2 text-[13px] font-bold text-zinc-400 hover:text-white hover:bg-white/5 rounded-full transition-colors border border-white/5 bg-card shadow-inner"
              >
                <Unlink size={14} />
                Unmatch
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Side({ icon: Icon, label, value, muted }: { icon: LucideIcon; label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className="w-9 h-9 rounded-xl bg-raised border border-white/5 flex items-center justify-center text-zinc-400 shrink-0 shadow-inner">
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">{label}</div>
        <div className={`text-sm font-bold truncate ${muted ? 'text-amber-400' : 'text-white'}`}>{value}</div>
      </div>
    </div>
  );
}
