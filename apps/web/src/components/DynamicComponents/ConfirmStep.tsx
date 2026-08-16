import { AlertTriangle, Check, X } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';

/**
 * Every other label on this dialog arrives as a prop, because only the caller
 * knows what is being confirmed. "Cancel" is the exception — the way out of a
 * confirmation is the same sentence whatever the question was — so it is the
 * one string the component owns, and therefore the one it must put in the
 * catalogue itself.
 */
const m = defineMessages({
  cancel: { id: 'shell.confirmStep.cancel', defaultMessage: 'Cancel' },
});

/**
 * The "are you sure" that sits in front of an approval step.
 *
 * Approving is not reversible in any way the person can see — the item moves
 * on, and at the final stage it locks and publishes to the ledger — so the
 * confirmation names what is about to happen rather than asking a generic
 * question. "Are you sure?" on its own tells nobody anything; "This is the
 * last stage — approving locks it and publishes to Xero" does.
 */
export function ConfirmStep({ title, detail, consequence, confirmLabel, altLabel, tone = 'brand', onConfirm, onCancel, onAlt }: {
  title: string;
  detail: string;
  /** The part that cannot be undone, if there is one. */
  consequence?: string;
  confirmLabel: string;
  /** The third option, when the question has one. */
  altLabel?: string;
  tone?: 'brand' | 'red';
  onConfirm: () => void;
  onCancel: () => void;
  onAlt?: () => void;
}) {
  const intl = useIntl();

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/75 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md border border-white/10 rounded-[28px] bg-card shadow-2xl overflow-hidden"
      >
        <div className="p-6 flex flex-col gap-3">
          <div className="flex items-start gap-3.5">
            <span
              className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 border ${
                tone === 'red'
                  ? 'bg-red-500/10 border-red-400/25 text-red-400'
                  : 'bg-brand/10 border-brand/25 text-brand'
              }`}
            >
              {tone === 'red' ? <AlertTriangle size={18} /> : <Check size={18} strokeWidth={3} />}
            </span>
            <div className="min-w-0">
              <h3 className="font-sans font-bold text-lg text-white tracking-tight leading-snug">{title}</h3>
              <p className="text-[13px] text-zinc-400 mt-1.5 leading-relaxed">{detail}</p>
            </div>
          </div>

          {consequence && (
            <p className="text-[12.5px] text-amber-400 font-semibold leading-relaxed pl-[54px]">{consequence}</p>
          )}
        </div>

        <div className="p-4 bg-raised/50 flex items-center gap-3 justify-end">
          <button
            onClick={onCancel}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
          >
            <X size={14} />
            {intl.formatMessage(m.cancel)}
          </button>
          {/* The third way out sits apart from the primary, so discarding
              work is never the button under the thumb. */}
          {altLabel && onAlt && (
            <button
              onClick={onAlt}
              className="px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-300 bg-card border border-white/10 hover:bg-white/5 transition-colors"
            >
              {altLabel}
            </button>
          )}
          <button
            autoFocus
            onClick={onConfirm}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-full text-[13px] font-bold text-white transition-colors ${
              tone === 'red'
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-brand hover:bg-brand-hover shadow-[0_0_15px_rgba(20,227,196,0.25)]'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
