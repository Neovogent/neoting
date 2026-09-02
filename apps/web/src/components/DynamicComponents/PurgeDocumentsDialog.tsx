import { useMemo, useState } from 'react';
import { ArrowRight, ShieldAlert, Trash2 } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { PURGE_BATCH_MAX, PURGE_REASON_MAX, purgeRequestFor } from '../../api/document-lifecycle';
import { commonActions } from '../../i18n/common';
import type { Document } from '../../lib/types';
import { LiveProposalFlow } from './LiveProposalFlow';
import { ReviewSection } from './ReviewGate';
import { Modal } from './Modal';

/**
 * **Permanent delete, as a proposal — the only door it has.**
 *
 * Soft-delete into Trash is a call (`POST …/deletion`) because it is
 * reversible: nothing is lost, and `POST …/restoration` puts it back. Purging
 * is not, so it takes the path every irreversible state change in this product
 * takes — create → Read review → Approve, echoing the review's
 * `renderedSummaryHash`. `LiveProposalFlow` makes only the CREATE call;
 * `LiveProposalCard` is the server's own review card, so **Approve is not
 * merely disabled before `POST …/review` returns — it is not in the DOM**, and
 * the same rule is enforced server-side and again by a database trigger. This
 * file writes no state and builds no second path.
 *
 * Three things that are decisions, not details:
 *
 * - **⚠ There is NO client-side rule about what may be purged.** The server
 *   refuses a document that has been published or exported, and it refuses it
 *   with its own `NT-` code and its own sentence — which is what appears on
 *   screen, verbatim, from `LiveProposalFlow`'s create-refusal line or from the
 *   card's approve-refusal line. A mirror of the rule written here could
 *   disagree with the one actually enforced, and a screen that pre-empts a
 *   refusal it has guessed at teaches an accountant to trust the guess. The
 *   export screen learned this the hard way (`publishedOutsidePeriod`, 2 Sep).
 * - **One proposal names ONE business**, so a selection spanning clients
 *   becomes one purge per client, walked one at a time — the `document.route`
 *   and `publish.batch` idiom.
 * - **The copy is allowed to be frightening, because the act is.** This is the
 *   opposite of the Trash confirmation, which must NOT be: a reversible act
 *   dressed as an irreversible one trains people to click through warnings.
 *
 * Lazy on purpose: none of this copy, and none of `api/proposals.ts`, belongs
 * on the Documents route's opening download.
 */

const m = defineMessages({
  dialogLabel: { id: 'documents.purgeDialog.dialogLabel', defaultMessage: 'Delete documents permanently' },
  title: {
    id: 'documents.purgeDialog.title',
    defaultMessage: '{count, plural, one {Delete # document permanently} other {Delete # documents permanently}}',
  },
  subtitle: { id: 'documents.purgeDialog.subtitle', defaultMessage: '{client} · this cannot be undone' },
  batchProgress: {
    id: 'documents.purgeDialog.batchProgress',
    defaultMessage: 'Request {position} of {total} — one per client, and at most {max} documents each.',
  },
  /** The cap said BEFORE it is hit, the `EXPORT_BATCH_CAP` precedent. */
  capNote: {
    id: 'documents.purgeDialog.capNote',
    defaultMessage:
      'A permanent deletion carries at most {max} documents, so your selection is split into {count} requests, each reviewed and approved on its own.',
  },
  reasonLabel: { id: 'documents.purgeDialog.reasonLabel', defaultMessage: 'Why (optional)' },
  reasonPlaceholder: {
    id: 'documents.purgeDialog.reasonPlaceholder',
    defaultMessage: 'Duplicate scans of the same March invoices',
  },
  reasonNote: {
    id: 'documents.purgeDialog.reasonNote',
    defaultMessage:
      'Shown on the review card and kept on the audit record. Since the documents themselves stop existing, this is the only surviving explanation of why they are gone.',
  },
  reasonCount: { id: 'documents.purgeDialog.reasonCount', defaultMessage: '{used} of {max}' },
  meaning: {
    id: 'documents.purgeDialog.meaning',
    defaultMessage:
      'Permanent deletion removes the record and the original file. Restoring from Trash will no longer be possible, and a deleted document cannot be matched to a bank line or exported later.',
  },
  /**
   * ⚠ **D42 lives in this sentence.** The refusal it describes is D43's: a
   * document that reached Published — *approved and released for export* — or
   * that an export file already carries a resolvable link to. The vendor
   * vocabulary for the same idea is "published to" / "posted", and both would
   * tell an accountant a ledger was written to. Neither appears here, and
   * neither may.
   */
  serverRule: {
    id: 'documents.purgeDialog.serverRule',
    defaultMessage:
      'The server decides what may be deleted. A document that has been released for export, or that an export file already links to, is refused — the reason and its reference appear here.',
  },
  itemsSection: { id: 'documents.purgeDialog.itemsSection', defaultMessage: 'Documents in this request' },
  itemRow: { id: 'documents.purgeDialog.itemRow', defaultMessage: '{supplier} · {date}' },
  stage: { id: 'documents.purgeDialog.stage', defaultMessage: 'Stage for review' },
  gate: {
    id: 'documents.purgeDialog.gate',
    defaultMessage:
      'Staging queues it in Approvals. Nothing is deleted until someone reads the review the server renders and approves it.',
  },
  nextBatch: { id: 'documents.purgeDialog.nextBatch', defaultMessage: 'Next client ({remaining} left)' },
  emptyTitle: { id: 'documents.purgeDialog.emptyTitle', defaultMessage: 'Nothing selected to delete' },
  emptyDetail: {
    id: 'documents.purgeDialog.emptyDetail',
    defaultMessage: 'Tick the documents you want removed for good, then choose Delete permanently again.',
  },
});

export interface PurgeDocumentsDialogProps {
  selection: Document[];
  onClose: () => void;
  /** Fired after an approve or cancel lands server-side — the refetch seam. */
  onSettled?: () => void;
}

export default function PurgeDocumentsDialog({ selection, onClose, onSettled }: PurgeDocumentsDialogProps) {
  const intl = useIntl();
  const { clientNameFor } = useAppContext();
  const [index, setIndex] = useState(0);
  const [decided, setDecided] = useState(false);
  const [reason, setReason] = useState('');

  /**
   * One request per client, then split at the contract's cap.
   *
   * ⚠ The cap is **all-or-nothing per request**, and that is why it is honoured
   * here rather than left to the server: `documentIds` refuses the ENTIRE batch
   * if one id is over the limit, and the contract's own reason for the rule —
   * "a partially purged batch cannot be re-run to completion, because the
   * successful half no longer exists" — is exactly why a refusal after the fact
   * is not an acceptable way to discover it.
   */
  const batches = useMemo(() => {
    const grouped = new Map<string, Document[]>();
    selection.forEach((d) => grouped.set(d.clientId, [...(grouped.get(d.clientId) ?? []), d]));
    return [...grouped.entries()].flatMap(([businessId, docs]) => {
      const chunks: { businessId: string; docs: Document[] }[] = [];
      for (let i = 0; i < docs.length; i += PURGE_BATCH_MAX) {
        chunks.push({ businessId, docs: docs.slice(i, i + PURGE_BATCH_MAX) });
      }
      return chunks;
    });
  }, [selection]);

  const batch = batches[index];

  /* ── the empty state, which teaches the next action ─────────────────────── */
  if (!batch) {
    return (
      <Modal onClose={onClose} label={intl.formatMessage(m.emptyTitle)}>
        <div className="w-full border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
          <div className="p-6 border-b border-white/5">
            <h3 className="font-sans font-bold text-xl text-white tracking-tight">{intl.formatMessage(m.emptyTitle)}</h3>
            <p className="text-[13px] text-zinc-400 mt-1.5 leading-relaxed">{intl.formatMessage(m.emptyDetail)}</p>
          </div>
          <div className="p-4 bg-raised/50 flex justify-end">
            <button
              onClick={onClose}
              className="px-6 py-2.5 rounded-full text-[13px] font-bold text-brand-on bg-brand hover:bg-brand-hover transition-colors"
            >
              {intl.formatMessage(commonActions.close)}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  const clientName = clientNameFor(batch.businessId);
  const remaining = batches.length - index - 1;

  return (
    <Modal onClose={onClose} label={intl.formatMessage(m.dialogLabel)}>
      <div className="w-full border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col">
        <div className="p-6 flex items-center gap-4 border-b border-white/5">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border shadow-inner bg-red-500/10 text-red-400 border-red-500/25">
            <Trash2 size={20} />
          </div>
          <div className="min-w-0">
            <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">
              {intl.formatMessage(m.title, { count: batch.docs.length })}
            </h3>
            <p className="text-[12px] text-zinc-500 mt-1 font-semibold">
              {intl.formatMessage(m.subtitle, { client: clientName })}
            </p>
          </div>
        </div>

        <div className="p-6 space-y-5">
          <p className="text-[12.5px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.meaning)}</p>

          {batches.length > 1 && (
            <p className="text-[12px] text-zinc-500">
              {intl.formatMessage(m.batchProgress, {
                position: index + 1,
                total: batches.length,
                max: PURGE_BATCH_MAX,
              })}
            </p>
          )}

          {selection.length > PURGE_BATCH_MAX && (
            <p className="text-[12px] text-amber-400 leading-relaxed">
              {intl.formatMessage(m.capNote, { max: PURGE_BATCH_MAX, count: batches.length })}
            </p>
          )}

          <ReviewSection title={intl.formatMessage(m.itemsSection)}>
            <div className="bg-card border border-white/5 rounded-2xl divide-y divide-white/5 shadow-inner max-h-52 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {batch.docs.map((d) => (
                <div key={d.id} className="px-4 py-2.5 text-[13px] text-zinc-400 truncate">
                  {intl.formatMessage(m.itemRow, { supplier: d.supplier, date: d.date })}
                </div>
              ))}
            </div>
          </ReviewSection>

          <label className="flex flex-col gap-2">
            <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
              {intl.formatMessage(m.reasonLabel)}
            </span>
            <textarea
              value={reason}
              maxLength={PURGE_REASON_MAX}
              rows={2}
              onChange={(e) => setReason(e.target.value)}
              placeholder={intl.formatMessage(m.reasonPlaceholder)}
              className="w-full bg-ground border border-white/10 rounded-2xl px-4 py-3 text-[13px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand resize-none"
            />
            <span className="flex items-center justify-between gap-3 text-[11.5px] text-zinc-600 leading-relaxed">
              <span className="min-w-0">{intl.formatMessage(m.reasonNote)}</span>
              <span className="shrink-0 tabular-nums">
                {intl.formatMessage(m.reasonCount, { used: reason.length, max: PURGE_REASON_MAX })}
              </span>
            </span>
          </label>

          {/* ⚠ The refusal rule, stated but never enforced here. */}
          <p className="text-[12px] text-zinc-500 leading-relaxed flex items-start gap-2">
            <ShieldAlert size={14} className="shrink-0 mt-0.5" />
            <span className="min-w-0">{intl.formatMessage(m.serverRule)}</span>
          </p>

          <p className="text-[12px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.gate)}</p>

          <LiveProposalFlow
            key={batch.businessId}
            buildRequest={() => purgeRequestFor(batch.businessId, batch.docs.map((d) => d.id), reason)}
            clientName={clientName}
            stageLabel={intl.formatMessage(m.stage)}
            onExecuted={() => {
              setDecided(true);
              onSettled?.();
            }}
          />

          {decided && remaining > 0 && (
            <button
              onClick={() => {
                setDecided(false);
                setIndex((i) => i + 1);
              }}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-zinc-400 hover:text-white border border-white/10 rounded-full transition-colors"
            >
              {intl.formatMessage(m.nextBatch, { remaining })}
              <ArrowRight size={16} />
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
