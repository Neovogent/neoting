import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { NtProblemError } from '@neoting/contracts';
import { createProposal } from '../../api/proposals';
import { commonActions } from '../../i18n/common';
import { useEscape } from '../../lib/useEscape';

const m = defineMessages({
  title: { id: 'proposals.offboardDialog.title', defaultMessage: 'Remove {name}?' },
  detail: {
    id: 'proposals.offboardDialog.detail',
    defaultMessage:
      'Removing a client goes through Review → Approve: confirming queues a removal proposal, and {name} disappears from the client list only after it is approved.',
  },
  retained: {
    id: 'proposals.offboardDialog.retained',
    defaultMessage: 'Documents, books and the audit trail are retained — nothing is deleted.',
  },
  reasonLabel: { id: 'proposals.offboardDialog.reasonLabel', defaultMessage: 'Reason (optional)' },
  reasonPlaceholder: {
    id: 'proposals.offboardDialog.reasonPlaceholder',
    defaultMessage: 'Client moved to another practice',
  },
  confirmAction: { id: 'proposals.offboardDialog.confirmAction', defaultMessage: 'Yes, queue the removal' },
  queuing: { id: 'proposals.offboardDialog.queuing', defaultMessage: 'Queuing…' },
  errorWithCode: { id: 'proposals.offboardDialog.errorWithCode', defaultMessage: '{message} ({code})' },
  requestFailed: { id: 'proposals.offboardDialog.requestFailed', defaultMessage: 'The request failed' },
});

/**
 * The "ask first" a client removal is behind — the ConfirmStep chrome (red
 * tone, Escape cancels, backdrop is presentation) plus the one thing
 * ConfirmStep cannot hold: the optional reason, which travels on the proposal
 * payload and is rendered back at Review. Confirming creates the
 * `business.offboard` proposal and STOPS — review and approval are the
 * Approvals queue's moves, made by a person (the createProposal contract's
 * own rule).
 *
 * Opened from the client's Settings tab (ClientDetailView) — deliberately NOT
 * from the Clients board: "to delete, the accountant firm needs to go to the
 * client and the Settings tab, not the front card" (the user's decision,
 * 31 Aug 2026). Its opener must gate on the businesses slice being live; on
 * seed data there is no server to propose the removal to and nothing mutates
 * a business client-side.
 */
export function OffboardClientDialog({ client, onQueued, onCancel }: {
  /** A live-board row — the id is the server's own business id, unbridged. */
  client: { id: string; name: string };
  /** The proposal was created — nothing has been removed yet. */
  onQueued: () => void;
  onCancel: () => void;
}) {
  const intl = useIntl();
  const [reason, setReason] = useState('');
  const [queuing, setQueuing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Escape is Cancel — the safe exit, never the confirm (the ConfirmStep rule).
  useEscape(onCancel);

  const queue = async () => {
    if (queuing) return;
    setProblem(null);
    setQueuing(true);
    try {
      const trimmed = reason.trim();
      await createProposal({
        kind: 'business.offboard',
        businessId: client.id,
        // An unanswered optional is an omitted key (the intake rule): an empty
        // reason is nobody asserting anything, not an assertion of ''.
        payload: { businessId: client.id, ...(trimmed === '' ? {} : { reason: trimmed }) },
      });
      onQueued();
    } catch (error) {
      setQueuing(false);
      setProblem(
        error instanceof NtProblemError
          ? intl.formatMessage(m.errorWithCode, { message: error.detail ?? error.title, code: error.code })
          : error instanceof Error
            ? error.message
            : intl.formatMessage(m.requestFailed),
      );
    }
  };

  return (
    // The backdrop is not a button — role="presentation" says so; the keyboard
    // dismissal is Escape above.
    // Centred by the card's auto margins, not items-center: auto margins
    // collapse to zero when the card overflows, so a too-short viewport scrolls
    // the scrim instead of clipping the card at both ends (items 23+40).
    <div
      className="fixed inset-0 z-[60] bg-black/75 backdrop-blur-sm flex justify-center overflow-y-auto p-3 sm:p-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onClick={onCancel}
      role="presentation"
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={intl.formatMessage(m.title, { name: client.name })}
        className="w-full max-w-md my-auto border border-white/10 rounded-[28px] bg-card shadow-2xl overflow-hidden"
      >
        <div className="p-6 flex flex-col gap-4">
          <div className="flex items-start gap-3.5">
            <span className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 border bg-red-500/10 border-red-400/25 text-red-400">
              <AlertTriangle size={18} />
            </span>
            <div className="min-w-0">
              <h3 className="font-sans font-bold text-lg text-white tracking-tight leading-snug">
                {intl.formatMessage(m.title, { name: client.name })}
              </h3>
              <p className="text-[13px] text-zinc-400 mt-1.5 leading-relaxed">
                {intl.formatMessage(m.detail, { name: client.name })}
              </p>
              <p className="text-[12.5px] text-zinc-500 mt-1.5 leading-relaxed">
                {intl.formatMessage(m.retained)}
              </p>
            </div>
          </div>

          <label className="flex flex-col gap-1.5 pl-[54px]">
            <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
              {intl.formatMessage(m.reasonLabel)}
            </span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              // The contract's own cap on the payload field.
              maxLength={500}
              placeholder={intl.formatMessage(m.reasonPlaceholder)}
              className="w-full bg-ground border border-white/10 rounded-2xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand shadow-inner"
            />
          </label>

          {problem && (
            <p role="alert" className="pl-[54px] text-[12.5px] font-semibold text-red-400 leading-relaxed">
              {problem}
            </p>
          )}
        </div>

        <div className="p-4 bg-raised/50 flex items-center gap-2 sm:gap-3 justify-end flex-wrap [&>button]:flex-1 [&>button]:basis-[8rem] sm:[&>button]:flex-none sm:[&>button]:basis-auto [&>button]:justify-center">
          <button
            onClick={onCancel}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
          >
            <X size={14} />
            {intl.formatMessage(commonActions.cancel)}
          </button>
          <button
            // A modal owns focus while it is open: landing it on the primary
            // action on open is the dialog pattern, not a focus theft — the
            // rule's concern — and Escape (above) is the guarded way back out.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onClick={() => void queue()}
            aria-disabled={queuing}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-red-500 hover:bg-red-600 transition-colors aria-disabled:opacity-50"
          >
            {intl.formatMessage(queuing ? m.queuing : m.confirmAction)}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
