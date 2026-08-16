import { ArrowLeftRight, FileText, Landmark, LucideIcon, Unlink } from 'lucide-react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { useConfirm } from './ConfirmProvider';
import { currency } from '../../lib/resolver';
import { Pill } from './DataTable';
import type { Match } from '../../lib/types';

/**
 * The kind keys are the union from `Match['kind']` — data, not copy — so the
 * table holds descriptors keyed by them and the call site formats. A hook
 * cannot run at module scope.
 */
const KIND_LABEL_MESSAGES = defineMessages({
  exact: { id: 'shell.matchCard.kindExact', defaultMessage: 'Exact match' },
  'credit-note': { id: 'shell.matchCard.kindCreditNote', defaultMessage: 'Credit note / refund' },
  partial: { id: 'shell.matchCard.kindPartial', defaultMessage: 'Batch payment' },
  probable: { id: 'shell.matchCard.kindProbable', defaultMessage: 'Probable — needs evidence' },
});

const KIND_LABEL: Record<Match['kind'], { label: MessageDescriptor; tone: 'green' | 'blue' | 'amber' | 'neutral' }> = {
  exact: { label: KIND_LABEL_MESSAGES.exact, tone: 'green' },
  'credit-note': { label: KIND_LABEL_MESSAGES['credit-note'], tone: 'blue' },
  partial: { label: KIND_LABEL_MESSAGES.partial, tone: 'blue' },
  probable: { label: KIND_LABEL_MESSAGES.probable, tone: 'amber' },
};

const m = defineMessages({
  empty: { id: 'shell.matchCard.empty', defaultMessage: 'No bank matches for this scope.' },
  confidence: { id: 'shell.matchCard.confidence', defaultMessage: '{percent}% confidence' },
  documentSide: { id: 'shell.matchCard.documentSide', defaultMessage: 'Document' },
  transactionSide: { id: 'shell.matchCard.transactionSide', defaultMessage: 'Transaction' },
  unmatchTitle: { id: 'shell.matchCard.unmatchTitle', defaultMessage: 'Break this match?' },
  unmatchDetail: { id: 'shell.matchCard.unmatchDetail', defaultMessage: '{document} and {transaction}.' },
  unmatchConsequence: {
    id: 'shell.matchCard.unmatchConsequence',
    defaultMessage: 'The transaction goes back to having no evidence, which makes it a missing item again.',
  },
  unmatchConfirm: { id: 'shell.matchCard.unmatchConfirm', defaultMessage: 'Yes, unmatch' },
  unmatchAudit: {
    id: 'shell.matchCard.unmatchAudit',
    defaultMessage: 'Unmatched document from transaction',
  },
  unmatchAction: { id: 'shell.matchCard.unmatchAction', defaultMessage: 'Unmatch' },
});

/**
 * Bank match cards (PRD stage 7). Probable matches are always visually
 * distinct from exact ones; every link shows its confidence and can be undone.
 */
export function MatchCard({ matches }: { matches: Match[] }) {
  const { logAudit, unmatchTransaction } = useAppContext();
  const confirm = useConfirm();
  const intl = useIntl();

  if (matches.length === 0) {
    return (
      <div className="w-full max-w-xl border border-white/5 rounded-[24px] bg-card p-5 text-sm text-zinc-400">
        {intl.formatMessage(m.empty)}
      </div>
    );
  }

  return (
    <div className="w-full max-w-3xl flex flex-col gap-3">
      {/* `match` rather than `m`: the module-scope `m` holds the messages, and
          the callback parameter used to shadow it. */}
      {matches.map((match) => {
        const kind = KIND_LABEL[match.kind];
        const isProbable = match.kind === 'probable';
        return (
          <div
            key={match.id}
            className={`border rounded-[28px] bg-card shadow-2xl overflow-hidden ${
              isProbable ? 'border-amber-500/30 border-dashed' : 'border-white/5'
            }`}
          >
            <div className="p-5 flex items-center justify-between gap-3 border-b border-white/5">
              <Pill tone={kind.tone}>{intl.formatMessage(kind.label)}</Pill>
              <div className="flex items-center gap-3">
                <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
                  {intl.formatMessage(m.confidence, { percent: Math.round(match.confidence * 100) })}
                </span>
                <div className="w-20 h-1.5 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${isProbable ? 'bg-amber-400' : 'bg-brand'}`}
                    style={{ width: `${Math.round(match.confidence * 100)}%` }}
                  />
                </div>
              </div>
            </div>

            <div className="p-5 grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-center gap-4">
              {/* `startsWith('No document')` reads the seeded label, not copy —
                  it is a data probe and stays a literal. */}
              <Side
                icon={FileText}
                label={intl.formatMessage(m.documentSide)}
                value={match.documentLabel}
                muted={match.documentLabel.startsWith('No document')}
              />
              <div className="hidden sm:flex w-9 h-9 rounded-xl bg-raised border border-white/5 items-center justify-center text-zinc-500 shadow-inner">
                <ArrowLeftRight size={16} />
              </div>
              <Side icon={Landmark} label={intl.formatMessage(m.transactionSide)} value={match.transactionLabel} />
            </div>

            <div className="px-5 pb-5">
              <p className="text-[12px] text-zinc-500 leading-relaxed">{match.reason}</p>
            </div>

            <div className="flex items-center justify-between bg-raised/50 px-5 py-3 gap-3">
              <span className="text-sm font-bold text-white">{currency(match.amount)}</span>
              <button
                onClick={async () => {
                  const ok = await confirm({
                  tone: 'red',
                  title: intl.formatMessage(m.unmatchTitle),
                  detail: intl.formatMessage(m.unmatchDetail, {
                    document: match.documentLabel,
                    transaction: match.transactionLabel,
                  }),
                  consequence: intl.formatMessage(m.unmatchConsequence),
                  confirmLabel: intl.formatMessage(m.unmatchConfirm),
                });
                if (!ok) return;
                unmatchTransaction(match.id);
                  logAudit({ action: intl.formatMessage(m.unmatchAudit), scope: match.documentLabel, reviewOpened: true });
                }}
                className="flex items-center gap-2 px-4 py-2 text-[13px] font-bold text-zinc-400 hover:text-white hover:bg-white/5 rounded-full transition-colors border border-white/5 bg-card shadow-inner"
              >
                <Unlink size={14} />
                {intl.formatMessage(m.unmatchAction)}
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
