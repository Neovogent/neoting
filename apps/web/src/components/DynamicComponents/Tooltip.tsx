import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A small explanation on hover.
 *
 * The native `title` attribute waits about a second, cannot be styled, and
 * disappears on touch — which makes it useless for the one place it matters
 * most here: a column of unlabelled icons where the icon *is* the information.
 * This appears immediately, is readable, and stays inside the app's own
 * palette.
 *
 * It renders in a portal against the viewport rather than beside the thing it
 * describes. Absolutely positioning it inside the row looked correct until it
 * was used in a table: the scroll container clips anything crossing its edge,
 * so a tooltip on the top row lost its first two lines to the header. No
 * amount of width or wrapping fixes that — the box has to leave the container,
 * which means fixed coordinates measured from the trigger.
 *
 * Deliberately a hover/focus affordance and nothing more: anything that needs
 * a click belongs in a button.
 */

/** Breathing room between the tooltip and the icon, and from the window edge. */
const GAP = 8;
const MARGIN = 8;
const WIDTH = 224;

export function Tooltip({ label, detail, children, side = 'top' }: {
  /** The short line. Keep it to a few words. */
  label: string;
  /** One extra sentence, when the label alone leaves a question. */
  detail?: string;
  children: ReactNode;
  /** Preferred side. Flipped automatically when there is no room. */
  side?: 'top' | 'bottom';
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Measured after the box exists but before paint, so it never shows in the
  // wrong place first.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const anchor = anchorRef.current?.getBoundingClientRect();
    const box = boxRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const height = box?.height ?? 64;

    const roomAbove = anchor.top;
    const roomBelow = window.innerHeight - anchor.bottom;
    // Keep the preferred side unless it genuinely does not fit and the other
    // one does — flipping on every near-miss makes the thing feel jumpy.
    const below = side === 'bottom'
      ? roomBelow >= height + GAP + MARGIN || roomBelow >= roomAbove
      : roomAbove < height + GAP + MARGIN && roomBelow > roomAbove;

    const top = below ? anchor.bottom + GAP : anchor.top - height - GAP;
    const left = Math.min(
      Math.max(MARGIN, anchor.left + anchor.width / 2 - WIDTH / 2),
      window.innerWidth - WIDTH - MARGIN,
    );
    setPos({ top: Math.max(MARGIN, top), left });
  }, [open, side, label, detail]);

  // Fixed coordinates are measured once, so a scroll underneath would leave
  // the box floating away from its icon. Closing is the honest response —
  // the pointer has left the thing it was describing anyway.
  useLayoutEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <>
      <span
        ref={anchorRef}
        className="relative inline-flex"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {children}
      </span>

      {open &&
        createPortal(
          <div
            ref={boxRef}
            role="tooltip"
            style={{
              position: 'fixed',
              width: WIDTH,
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              // Hidden for the single frame before it has been measured,
              // rather than flashing at the top-left of the window.
              visibility: pos ? 'visible' : 'hidden',
            }}
            className="pointer-events-none z-[100] px-3 py-2 rounded-xl border border-white/10 bg-[#202026] shadow-2xl text-left whitespace-normal break-words"
          >
            <span className="block text-[12px] font-bold text-white leading-snug">{label}</span>
            {detail && <span className="block text-[11.5px] text-zinc-400 leading-snug mt-1">{detail}</span>}
          </div>,
          document.body,
        )}
    </>
  );
}
