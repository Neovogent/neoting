import { X } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { commonActions } from '../../i18n/common';
import { ChaseComposer } from './ChaseComposer';

const m = defineMessages({
  dialogLabel: { id: 'shell.chaseModal.dialogLabel', defaultMessage: 'Compose chase' },
  gateNote: {
    id: 'shell.chaseModal.gateNote',
    defaultMessage: 'Nothing sends until you read the review and approve it.',
  },
  closeLabel: { id: 'shell.chaseModal.closeLabel', defaultMessage: 'Close the composer' },
});

/**
 * The chase composer, opened over whatever page asked for it.
 *
 * Chasing from a table is manual work: the person has already chosen who and
 * what, so there is nothing left for the agent to help decide, and sending
 * them to the chat costs them their place on the page. The composer itself is
 * the same component the chat renders, with the same Review → Approve gate —
 * only the route to it differs.
 */
export function ChaseModal({ clientIds, missingItemIds, note, onClose }: {
  clientIds: string[];
  /** Narrows to specific items; omit to take everything outstanding. */
  missingItemIds?: string[];
  /** Context for why this chase was raised, when the rows do not say it. */
  note?: string;
  onClose: () => void;
}) {
  const intl = useIntl();

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={intl.formatMessage(m.dialogLabel)}
    >
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl my-auto flex flex-col items-center gap-3"
      >
        <div className="w-full flex items-center justify-between gap-4 px-5 py-3 rounded-[20px] border border-white/5 bg-card shadow-2xl">
          <p className="text-[12px] text-zinc-500 min-w-0">
            {note ?? intl.formatMessage(m.gateNote)}
          </p>
          <button
            onClick={onClose}
            aria-label={intl.formatMessage(m.closeLabel)}
            className="shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-bold text-zinc-400 hover:text-white transition-colors"
          >
            <X size={14} />
            {intl.formatMessage(commonActions.close)}
          </button>
        </div>

        {/* Omitted rather than passed as undefined: absent means "everything
            outstanding", which is not the same request as an empty narrowing. */}
        <ChaseComposer clientIds={clientIds} {...(missingItemIds === undefined ? {} : { missingItemIds })} />
      </motion.div>
    </div>
  );
}
