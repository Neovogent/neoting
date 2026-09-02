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
 * ⚠ THE CARD IS BOUNDED AND SCROLLS ITSELF (`max-h-full` + the inner
 * `overflow-y-auto`), and both halves are load-bearing. Before this the frame
 * had neither: a dialog taller than the window — a document detail on a short
 * viewport, which is most of them — ran off the bottom edge, and on the phone
 * branch the sheet is anchored with `items-end` + `mt-auto`, where an
 * overflowing item is aligned by rules nobody should have to reason about and
 * the scrim's own scrollbar is hidden by the two `[scrollbar-width]` utilities
 * below. The reported symptom was a Path-to-Ready panel whose last action
 * button was cut off with no way to reach it. A bounded card cannot do that
 * whatever the branch: the overflow is inside a real scroll box, keyboard
 * focus scrolls its own control into view, and `overscroll-contain` stops the
 * page behind taking over the gesture at the ends.
 *
 * ⚠ `[&>*]:w-full` is the other half, and it is a frame rule rather than a
 * caller's. The wrapper centres its child, so a child that forgets `w-full`
 * shrink-wraps to its own content and reads as a stray pill floating on the
 * scrim rather than as a dialog — silent, and invisible to every lint we have.
 * The child's own `max-w-*` still decides how wide it actually gets.
 *
 * The trade is that the scroll box clips what paints outside the card's box —
 * a card's `shadow-2xl` at the left and right edges. Content that cannot be
 * reached is the worse of the two, and the close button is deliberately a
 * sibling of the scroll box so it neither scrolls away nor gets clipped.
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
        className={`relative w-full ${width} flex flex-col max-h-full mt-auto sm:mt-0 pt-12 sm:pt-0 pb-safe sm:pb-0`}
      >
        <button
          onClick={onClose}
          aria-label={intl.formatMessage(m.close)}
          className="absolute top-1 right-1 sm:-top-3 sm:-right-3 z-10 p-2.5 sm:p-2 bg-card hover:bg-raised text-zinc-400 hover:text-white rounded-full border border-white/10 transition-colors shadow-lg"
        >
          <X size={18} />
        </button>
        <div className="min-h-0 overflow-y-auto overscroll-contain flex flex-col items-center [&>*]:w-full">
          {children}
        </div>
      </motion.div>
    </motion.div>
  );
}
