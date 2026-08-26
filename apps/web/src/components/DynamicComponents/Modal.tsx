import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useEscape } from '../../lib/useEscape';

const m = defineMessages({
  close: { id: 'shell.modal.close', defaultMessage: 'Close' },
});

/**
 * The one dialog frame. Children supply their own card; this supplies the
 * scrim, the close button, Escape, and the placement:
 *
 *   phone   a sheet anchored to the bottom edge, full width, safe-area aware,
 *           close button inside the card where a thumb can reach it
 *   ≥ 640   the card floats near the top, as before
 *
 * Render inside an AnimatePresence so the exit animation plays.
 *
 * Two deliberate departures from the frame this was ported from:
 *
 *   · Escape is `useEscape`, not a bare `window` listener. The hook is a
 *     stack, so a ConfirmStep opened on top of a Modal owns the key while it
 *     is up — Escape mid-confirm cancels the confirm, not the surface under
 *     it. Two naive listeners would fire outer-first and close the wrong one.
 *   · the scrim is `role="presentation"`, and `role="dialog"` sits on the
 *     card. A scrim carries the dismiss click, and announcing a click target
 *     as the dialog itself is a lie the a11y sweep already rejected once.
 *
 * It ADDS a frame; it replaces none of the modals that already draw their own.
 */
export function Modal({
  children,
  onClose,
  width = 'max-w-2xl',
  label,
}: {
  children: ReactNode;
  onClose: () => void;
  /** Tailwind max-width class for the wrapper. */
  width?: string;
  label?: string;
}) {
  const intl = useIntl();
  useEscape(onClose);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      role="presentation"
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-start justify-center overflow-y-auto p-0 sm:p-6 md:p-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 24, scale: 0.97 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        {...(label === undefined ? {} : { 'aria-label': label })}
        className={`relative w-full ${width} flex justify-center mt-auto sm:mt-0 pt-12 sm:pt-0 pb-safe sm:pb-0`}
      >
        <button
          onClick={onClose}
          aria-label={intl.formatMessage(m.close)}
          className="absolute top-1 right-1 sm:-top-3 sm:-right-3 z-10 p-2.5 sm:p-2 bg-card hover:bg-raised text-zinc-400 hover:text-white rounded-full border border-white/10 transition-colors shadow-lg"
        >
          <X size={18} />
        </button>
        {children}
      </motion.div>
    </motion.div>
  );
}
