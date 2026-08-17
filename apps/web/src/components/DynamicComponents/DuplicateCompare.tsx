import { Copy, Trash2, GitMerge, ShieldCheck } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { useConfirm } from './ConfirmProvider';
import { currency } from '../../lib/resolver';
import { Pill } from './DataTable';
import type { DuplicatePair } from '../../lib/types';

const m = defineMessages({
  empty: { id: 'documents.duplicateCompare.empty', defaultMessage: 'No duplicates flagged for this scope.' },
  similarity: { id: 'documents.duplicateCompare.similarity', defaultMessage: '{similarity}% similar' },
  crossType: {
    id: 'documents.duplicateCompare.crossType',
    defaultMessage: 'Cross-type: invoice ↔ receipt',
  },
  signalsHeading: { id: 'documents.duplicateCompare.signalsHeading', defaultMessage: 'Signals' },
  confirmDetail: {
    id: 'documents.duplicateCompare.confirmDetail',
    defaultMessage: '{left} and {right}, {similarity}% similar.',
  },

  deleteTitle: { id: 'documents.duplicateCompare.deleteTitle', defaultMessage: 'Delete the duplicate copy?' },
  deleteConsequence: {
    id: 'documents.duplicateCompare.deleteConsequence',
    defaultMessage: 'The copy is removed. A deleted document cannot be matched to a bank line later.',
  },
  deleteConfirm: { id: 'documents.duplicateCompare.deleteConfirm', defaultMessage: 'Yes, delete the copy' },
  deleteAudit: { id: 'documents.duplicateCompare.deleteAudit', defaultMessage: 'Deleted duplicate' },
  deleteAuditScope: { id: 'documents.duplicateCompare.deleteAuditScope', defaultMessage: '{label} — {client}' },
  deleteAction: { id: 'documents.duplicateCompare.deleteAction', defaultMessage: 'Delete duplicate' },

  attachTitle: { id: 'documents.duplicateCompare.attachTitle', defaultMessage: 'Attach this to the original?' },
  attachConsequence: {
    id: 'documents.duplicateCompare.attachConsequence',
    defaultMessage: 'They become one document with two images. The flag is cleared.',
  },
  attachConfirm: { id: 'documents.duplicateCompare.attachConfirm', defaultMessage: 'Yes, that is right' },
  attachAudit: { id: 'documents.duplicateCompare.attachAudit', defaultMessage: 'Merged as evidence' },
  attachAuditScope: { id: 'documents.duplicateCompare.attachAuditScope', defaultMessage: '{left} + {right}' },
  attachAction: { id: 'documents.duplicateCompare.attachAction', defaultMessage: 'Attach to original' },

  keepBothTitle: { id: 'documents.duplicateCompare.keepBothTitle', defaultMessage: 'Keep both copies?' },
  keepBothConsequence: {
    id: 'documents.duplicateCompare.keepBothConsequence',
    defaultMessage: 'Both stay and both will be published — an intentional duplicate.',
  },
  keepBothConfirm: { id: 'documents.duplicateCompare.keepBothConfirm', defaultMessage: 'Yes, that is right' },
  keepBothAudit: {
    id: 'documents.duplicateCompare.keepBothAudit',
    defaultMessage: 'Kept both — intentional duplicate',
  },
  keepBothAuditScope: { id: 'documents.duplicateCompare.keepBothAuditScope', defaultMessage: '{label} — {client}' },
  keepBothHint: {
    id: 'documents.duplicateCompare.keepBothHint',
    defaultMessage: 'Force a legitimate duplicate through',
  },
  keepBothAction: { id: 'documents.duplicateCompare.keepBothAction', defaultMessage: 'Keep both' },
});

const sideMessages = defineMessages({
  rowTotal: { id: 'documents.docSide.rowTotal', defaultMessage: 'Total' },
  rowDate: { id: 'documents.docSide.rowDate', defaultMessage: 'Date' },
  rowUploader: { id: 'documents.docSide.rowUploader', defaultMessage: 'Uploader' },
});

/**
 * Side-by-side duplicate comparison (PRD stage 6).
 * Multi-signal scoring, cross-document-type pairs, and an explicit
 * "keep both — intentional duplicate" escape that Dext lacks.
 */
export function DuplicateCompare({ pairs }: { pairs: DuplicatePair[] }) {
  const { resolveDuplicate, logAudit } = useAppContext();
  const confirm = useConfirm();
  const intl = useIntl();

  if (pairs.length === 0) {
    return (
      <div className="w-full max-w-xl border border-white/5 rounded-[24px] bg-card p-5 text-sm text-zinc-400">
        {intl.formatMessage(m.empty)}
      </div>
    );
  }

  return (
    <div className="w-full max-w-3xl flex flex-col gap-4">
      {pairs.map((p) => (
        <div key={p.id} className="border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
          <div className="p-6 flex items-start justify-between gap-4 border-b border-white/5">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-amber-500/10 flex items-center justify-center text-amber-400 shrink-0 border border-amber-500/20 shadow-inner">
                <Copy size={22} />
              </div>
              <div>
                <h3 className="font-sans font-bold text-xl text-white tracking-tight">
                  {intl.formatMessage(m.similarity, { similarity: Math.round(p.similarity * 100) })}
                </h3>
                <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">{p.clientName}</p>
              </div>
            </div>
            {p.crossType && <Pill tone="blue">{intl.formatMessage(m.crossType)}</Pill>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-white/5">
            <DocSide side={p.left} />
            <DocSide side={p.right} />
          </div>

          <div className="px-6 py-4 border-t border-white/5">
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
              {intl.formatMessage(m.signalsHeading)}
            </div>
            <div className="flex flex-wrap gap-2">
              {p.signals.map((s) => (
                <Pill key={s}>{s}</Pill>
              ))}
            </div>
          </div>

          <div className="flex items-center bg-raised/50 p-4 gap-3 flex-wrap">
            <button
              onClick={async () => {
                const ok = await confirm({
                  tone: 'red',
                  title: intl.formatMessage(m.deleteTitle),
                  detail: intl.formatMessage(m.confirmDetail, {
                    left: p.left.label,
                    right: p.right.label,
                    similarity: Math.round(p.similarity * 100),
                  }),
                  consequence: intl.formatMessage(m.deleteConsequence),
                  confirmLabel: intl.formatMessage(m.deleteConfirm),
                });
                if (!ok) return;
                resolveDuplicate(p.id, 'delete');
                logAudit({
                  action: intl.formatMessage(m.deleteAudit),
                  scope: intl.formatMessage(m.deleteAuditScope, { label: p.right.label, client: p.clientName }),
                  reviewOpened: true,
                });
              }}
              className="flex-1 min-w-[160px] flex items-center justify-center gap-2 py-3 text-sm font-bold text-white bg-brand rounded-2xl hover:bg-brand-hover transition-all shadow-glow-btn-soft"
            >
              <Trash2 size={16} />
              {intl.formatMessage(m.deleteAction)}
            </button>
            <button
              onClick={async () => {
                const ok = await confirm({
                  tone: 'brand',
                  title: intl.formatMessage(m.attachTitle),
                  detail: intl.formatMessage(m.confirmDetail, {
                    left: p.left.label,
                    right: p.right.label,
                    similarity: Math.round(p.similarity * 100),
                  }),
                  consequence: intl.formatMessage(m.attachConsequence),
                  confirmLabel: intl.formatMessage(m.attachConfirm),
                });
                if (!ok) return;
                resolveDuplicate(p.id, 'keep-both');
                logAudit({
                  action: intl.formatMessage(m.attachAudit),
                  scope: intl.formatMessage(m.attachAuditScope, { left: p.left.label, right: p.right.label }),
                  reviewOpened: true,
                });
              }}
              className="flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 rounded-2xl transition-colors border border-white/5 bg-card shadow-inner"
            >
              <GitMerge size={16} />
              {intl.formatMessage(m.attachAction)}
            </button>
            <button
              onClick={async () => {
                const ok = await confirm({
                  tone: 'brand',
                  title: intl.formatMessage(m.keepBothTitle),
                  detail: intl.formatMessage(m.confirmDetail, {
                    left: p.left.label,
                    right: p.right.label,
                    similarity: Math.round(p.similarity * 100),
                  }),
                  consequence: intl.formatMessage(m.keepBothConsequence),
                  confirmLabel: intl.formatMessage(m.keepBothConfirm),
                });
                if (!ok) return;
                resolveDuplicate(p.id, 'keep-both');
                logAudit({
                  action: intl.formatMessage(m.keepBothAudit),
                  scope: intl.formatMessage(m.keepBothAuditScope, { label: p.left.label, client: p.clientName }),
                  reviewOpened: true,
                });
              }}
              className="flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 rounded-2xl transition-colors border border-white/5 bg-card shadow-inner"
              title={intl.formatMessage(m.keepBothHint)}
            >
              <ShieldCheck size={16} />
              {intl.formatMessage(m.keepBothAction)}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function DocSide({ side }: { side: DuplicatePair['left'] }) {
  const intl = useIntl();

  return (
    <div className="p-6">
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">{side.type}</div>
      <div className="font-sans font-bold text-white text-lg tracking-tight mb-3">{side.label}</div>
      <div className="flex flex-col gap-2.5 text-[13px]">
        <Row label={intl.formatMessage(sideMessages.rowTotal)} value={currency(side.total)} />
        <Row label={intl.formatMessage(sideMessages.rowDate)} value={side.date} />
        <Row label={intl.formatMessage(sideMessages.rowUploader)} value={side.uploader} />
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
