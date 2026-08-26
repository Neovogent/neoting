import { AlertTriangle, Check, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useIntl } from 'react-intl';
import { commonActions } from '../../i18n/common';
import { useEscape } from '../../lib/useEscape';

/**
 * Every other label on this dialog arrives as a prop, because only the caller
 * knows what is being confirmed. "Cancel" is the exception — the way out of a
 * confirmation is the same sentence whatever the question was — so it comes
 * from the common catalogue; the component owns no strings of its own.
 */

/**
 * The "are you sure" that sits in front of an approval step.
 *
 * Approving is not reversible in any way the person can see — the item moves
 * on, and at the final stage it locks and is released for export — so the
 * confirmation names what is about to happen rather than asking a generic
 * question. "Are you sure?" on its own tells nobody anything; "This is the
 * last stage — approving locks it and releases it for export" does.
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
  // Escape is Cancel — the safe exit from a confirmation, never the confirm.
  // useEscape stacks, so when this sits over another dialog (DuplicateModal
  // opens it), Escape dismisses this one first.
  useEscape(onCancel);

  return (
    // The backdrop is not a button — role="presentation" says so; the keyboard
    // dismissal is Escape above.
    <div
      className="fixed inset-0 z-[60] bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6"
      onClick={onCancel}
      role="presentation"
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
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

        <div className="p-4 bg-raised/50 flex items-center gap-2 sm:gap-3 justify-end flex-wrap [&>button]:flex-1 [&>button]:basis-[8rem] sm:[&>button]:flex-none sm:[&>button]:basis-auto [&>button]:justify-center">
          <button
            onClick={onCancel}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
          >
            <X size={14} />
            {intl.formatMessage(commonActions.cancel)}
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
            // A modal owns focus while it is open: landing it on the primary
            // action on open is the dialog pattern, not a focus theft — the
            // rule's concern — and Escape (above) is the guarded way back out.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onClick={onConfirm}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-full text-[13px] font-bold text-white transition-colors ${
              tone === 'red'
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-brand hover:bg-brand-hover shadow-glow-btn'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
