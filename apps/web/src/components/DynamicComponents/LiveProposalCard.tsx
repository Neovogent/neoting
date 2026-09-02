import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ShieldCheck } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import { NtProblemError } from '@neoting/contracts';
import type { ActionProposal } from '@neoting/contracts/model';
import { useAppContext } from '../../context/AppContext';
import { approveReviewed, cancelPending, KIND_LABEL, KIND_NOTE, offboardReason, openReview, type ReviewCard } from '../../api/proposals';
import { commonActions } from '../../i18n/common';
import { ReviewRows, ReviewSection } from './ReviewGate';

const m = defineMessages({
  createdBy: { id: 'proposals.liveCard.createdBy', defaultMessage: 'Proposed by {who} · {when}' },
  createdByModel: { id: 'proposals.liveCard.createdByModel', defaultMessage: 'Proposed by AI ({model}) · {when}' },
  statePending: { id: 'proposals.liveCard.statePending', defaultMessage: 'Awaiting review' },
  stateReviewed: { id: 'proposals.liveCard.stateReviewed', defaultMessage: 'Reviewed' },
  readReview: { id: 'proposals.liveCard.readReview', defaultMessage: 'Read review' },
  opening: { id: 'proposals.liveCard.opening', defaultMessage: 'Opening the review…' },
  unknownKind: { id: 'proposals.liveCard.unknownKind', defaultMessage: 'A change awaiting your review' },
  approve: { id: 'proposals.liveCard.approve', defaultMessage: 'Approve' },
  approving: { id: 'proposals.liveCard.approving', defaultMessage: 'Executing…' },
  approved: { id: 'proposals.liveCard.approved', defaultMessage: 'Approved and executed — {title}' },
  cancelled: { id: 'proposals.liveCard.cancelled', defaultMessage: 'Cancelled — nothing was changed.' },
  errorWithCode: { id: 'proposals.liveCard.errorWithCode', defaultMessage: '{message} ({code})' },
  offboardReason: { id: 'proposals.liveCard.offboardReason', defaultMessage: 'Reason given: “{reason}”' },
  reviewEnforcement: {
    id: 'proposals.liveCard.reviewEnforcement',
    defaultMessage:
      'This review was rendered and recorded by the server; approving echoes its hash back. An approval without this review open is refused server-side.',
  },
  auditApprove: { id: 'proposals.liveCard.auditApprove', defaultMessage: 'Approved a proposal' },
  auditCancel: { id: 'proposals.liveCard.auditCancel', defaultMessage: 'Cancelled a proposal' },
});

/**
 * One live proposal, driven through the engine's own three doors (METH S12):
 * [Read review] calls `POST .../review` and renders EXACTLY what came back;
 * Approve mounts only after that response arrives and echoes its hash; Cancel
 * is the contracted cancellation. The gate here mirrors the server's — the
 * server enforces it regardless (NT-PRP-002), which is a demo talking point.
 */
export function LiveProposalCard({
  proposal,
  clientName,
  onSettled,
}: {
  proposal: ActionProposal;
  clientName: string | null;
  /** Fired after an approve or cancel lands server-side — the refetch seam. */
  onSettled?: () => void;
}) {
  const intl = useIntl();
  const { logAudit } = useAppContext();
  const [review, setReview] = useState<ReviewCard | null>(null);
  const [phase, setPhase] = useState<'idle' | 'opening' | 'reviewed' | 'approving' | 'approved' | 'cancelled'>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * ⚠ `KIND_LABEL` is total over the CONTRACT's kinds — but the queue is served
   * by a SERVER, which can be ahead of the generated client. A kind added to the
   * spec and deployed before the web build is regenerated arrives here as a key
   * the map has not got, and `intl.formatMessage(undefined)` throws: the whole
   * approval card, and the accountant's only route to Approve, taken down over a
   * missing label. (`document.purge` was in exactly that gap for the length of
   * one afternoon while it was being built.) The fallback is honest about what
   * it does not know, and the SERVER's own review title — which Read review
   * renders regardless — is the authoritative description either way.
   */
  const known = KIND_LABEL[proposal.kind] as MessageDescriptor | undefined;
  const kindLabel = known === undefined ? intl.formatMessage(m.unknownKind) : intl.formatMessage(known);
  const subtitle = [clientName, kindLabel].filter(Boolean).join(' · ');
  // The kind→copy mapping's second line, plus the queued reason for an
  // offboard — both from the proposal itself, so the card says what approving
  // does before Read review is even opened.
  const kindNote = KIND_NOTE[proposal.kind];
  const reason = offboardReason(proposal);

  const fail = (error: unknown) => {
    setProblem(
      error instanceof NtProblemError
        ? intl.formatMessage(m.errorWithCode, { message: error.detail ?? error.title, code: error.code })
        : error instanceof Error
          ? error.message
          : 'The request failed',
    );
  };

  const open = async () => {
    setProblem(null);
    setPhase('opening');
    try {
      setReview(await openReview(proposal.id));
      setPhase('reviewed');
    } catch (error) {
      setPhase('idle');
      fail(error);
    }
  };

  const approve = async () => {
    if (!review) return;
    setProblem(null);
    setPhase('approving');
    try {
      await approveReviewed(proposal.id, review.renderedSummaryHash);
      logAudit({ action: intl.formatMessage(m.auditApprove), scope: review.title, reviewOpened: true });
      setPhase('approved');
      onSettled?.();
    } catch (error) {
      setPhase('reviewed');
      fail(error);
    }
  };

  const cancel = async () => {
    setProblem(null);
    try {
      await cancelPending(proposal.id);
      logAudit({ action: intl.formatMessage(m.auditCancel), scope: subtitle, reviewOpened: true });
      setPhase('cancelled');
      onSettled?.();
    } catch (error) {
      fail(error);
    }
  };

  if (phase === 'approved') {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full border border-brand/30 bg-brand/10 rounded-[24px] p-5 flex items-center gap-4 text-brand"
      >
        <div className="w-10 h-10 rounded-2xl bg-brand/20 flex items-center justify-center shrink-0 border border-brand/30">
          <Check size={20} strokeWidth={3} />
        </div>
        <p className="text-sm font-bold tracking-wide">
          {intl.formatMessage(m.approved, { title: review?.title ?? kindLabel })}
        </p>
      </motion.div>
    );
  }

  if (phase === 'cancelled') {
    return (
      <div className="w-full border border-white/5 bg-card rounded-[24px] p-5 flex items-center gap-4 text-zinc-500">
        <p className="text-sm font-bold tracking-wide">{intl.formatMessage(m.cancelled)}</p>
      </div>
    );
  }

  return (
    <div className="w-full border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col">
      <div className="p-6 flex items-center justify-between gap-4 border-b border-white/5">
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border shadow-inner bg-raised text-white border-white/5">
            <ShieldCheck size={20} />
          </div>
          <div className="min-w-0">
            <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">{kindLabel}</h3>
            <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider truncate">
              {clientName ? `${clientName} · ` : ''}
              {proposal.createdByModel
                ? intl.formatMessage(m.createdByModel, { model: proposal.createdByModel, when: proposal.createdAt.slice(0, 10) })
                : intl.formatMessage(m.createdBy, { who: proposal.createdByUserId ?? '—', when: proposal.createdAt.slice(0, 10) })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wide bg-amber-500/10 text-amber-400">
            {intl.formatMessage(proposal.state === 'REVIEWED' ? m.stateReviewed : m.statePending)}
          </span>
          {phase === 'idle' && (
            <button
              onClick={() => void open()}
              className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-brand rounded-full hover:bg-brand-hover transition-all shadow-glow-btn-soft"
            >
              {intl.formatMessage(m.readReview)}
              <ChevronDown size={16} strokeWidth={2.5} />
            </button>
          )}
          {phase === 'opening' && (
            <span className="text-[12px] font-bold text-zinc-500">{intl.formatMessage(m.opening)}</span>
          )}
        </div>
      </div>

      {(kindNote || reason) && (
        <div className="px-6 py-4 border-b border-white/5 flex flex-col gap-1.5">
          {kindNote && <p className="text-[12px] text-zinc-500 leading-relaxed">{intl.formatMessage(kindNote)}</p>}
          {reason && (
            <p className="text-[13px] text-zinc-300 leading-relaxed">
              {intl.formatMessage(m.offboardReason, { reason })}
            </p>
          )}
        </div>
      )}

      <AnimatePresence>
        {review && (phase === 'reviewed' || phase === 'approving') && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-b border-white/5 bg-raised/30 overflow-hidden"
          >
            <div className="p-6 space-y-6">
              <h4 className="text-[15px] font-bold text-white">{review.title}</h4>
              {review.warnings.map((w) => (
                <div key={w.code} className="flex items-start gap-2.5 text-[13px] text-amber-400 bg-amber-400/10 border border-amber-400/25 rounded-2xl px-4 py-3">
                  <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                  <span>{w.message}</span>
                </div>
              ))}
              {review.sections.map((section) => (
                <ReviewSection key={section.heading} title={section.heading}>
                  <ReviewRows
                    rows={section.entries.map((entry) => ({
                      label: entry.label,
                      // The server's render, verbatim — an SMS body keeps its line breaks.
                      value: <span className="whitespace-pre-wrap break-words text-left">{entry.value}</span>,
                    }))}
                  />
                </ReviewSection>
              ))}
              <p className="text-[12px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.reviewEnforcement)}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {problem && (
        <div className="px-6 py-3 flex items-center gap-2.5 text-[13px] text-red-300 bg-red-500/10 border-b border-red-500/20">
          <AlertTriangle size={15} className="shrink-0" />
          <span className="min-w-0">{problem}</span>
        </div>
      )}

      {/* Approve mounts only once the server-rendered review is on screen. */}
      {review && (phase === 'reviewed' || phase === 'approving') && (
        <div className="p-4 bg-card flex justify-end gap-3 flex-wrap">
          <button
            onClick={() => void cancel()}
            className="px-5 py-2.5 text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 rounded-full transition-colors"
          >
            {intl.formatMessage(commonActions.cancel)}
          </button>
          <button
            onClick={() => void approve()}
            aria-disabled={phase === 'approving'}
            className="flex items-center gap-2 px-6 py-2.5 text-sm font-bold text-white bg-brand hover:bg-brand-hover rounded-full transition-all shadow-glow-btn-strong aria-disabled:opacity-50"
          >
            <Check size={18} strokeWidth={2.5} />
            {intl.formatMessage(phase === 'approving' ? m.approving : m.approve)}
          </button>
        </div>
      )}
    </div>
  );
}
