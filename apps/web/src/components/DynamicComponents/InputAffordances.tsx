import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { FileText, Image as ImageIcon, FileSpreadsheet, FileType, Camera } from 'lucide-react';

/**
 * The two controls on the composer that say what they do before you press them.
 *
 * Voice and Documents were a microphone and a paperclip — correct icons, and
 * completely silent about what happens next. Hovering now answers the question
 * each one raises: is this thing listening, and what am I allowed to give it.
 */

/**
 * A microphone that emits.
 *
 * The arcs are part of the glyph, inside its own 24×24 box — an earlier
 * version hung animated bars off both sides of the button with `left-full` /
 * `right-full`, which pushed into the controls either side of it and made the
 * row jump. Sound coming out of a microphone is a property of the icon, not
 * furniture around it.
 *
 * Idle they sit faint and still, so the icon reads the same shape whether or
 * not anything is happening. Active, each pair fades outward from the capsule
 * in turn — the inner arc, then the outer — which is what makes it read as
 * beeping rather than glowing.
 *
 * The beep is seen, not heard. A hover that plays audio fires on a pointer
 * crossing the button on its way elsewhere, cannot be undone, and browsers
 * block it outright until the page has been clicked. Nothing is recorded
 * until the button is actually pressed.
 */
export function VoiceIcon({ active, size = 14 }: { active: boolean; size?: number }) {
  /**
   * Lucide's own Mic geometry, unchanged, in a wider box.
   *
   * Fitting the microphone and its arcs into a 24-unit square shrank the
   * microphone to make room, so the button read smaller than every other icon
   * in the row. The box is 40 units wide instead and the glyph keeps lucide's
   * exact coordinates (capsule x9–15 y2–15, cradle arc, stand), shifted 8 to
   * sit in the middle. `size` is the height, so `size={14}` renders a
   * microphone identical to `<Mic size={14} />` and the arcs use the space
   * either side of it rather than taking space from it.
   *
   * Stroke width stays at 2, which at this scale is the same weight lucide
   * draws — the arcs belong to the icon rather than sitting beside it.
   */
  const arcs = [
    { d: 'M10 8a5 5 0 0 0 0 8', delay: 0 },
    { d: 'M30 8a5 5 0 0 1 0 8', delay: 0 },
    { d: 'M5.5 5.5a9 9 0 0 0 0 13', delay: 0.22 },
    { d: 'M34.5 5.5a9 9 0 0 1 0 13', delay: 0.22 },
  ];

  return (
    <svg
      width={(size * 40) / 24}
      height={size}
      viewBox="0 0 40 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {/* lucide/mic, translated +8 on x. Identical at the same size. */}
      <rect x="17" y="2" width="6" height="13" rx="3" />
      <path d="M27 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M20 19v3" />

      {arcs.map((arc) => (
        <motion.path
          key={arc.d}
          d={arc.d}
          initial={false}
          animate={active ? { opacity: [0.12, 1, 0.12] } : { opacity: 0.22 }}
          transition={
            active
              ? { duration: 1.15, repeat: Infinity, ease: 'easeInOut', delay: arc.delay }
              : { duration: 0.2 }
          }
        />
      ))}
    </svg>
  );
}

/** What the ingest pipeline will actually take, newest format on top. */
const ACCEPTED = [
  { icon: FileText, label: 'PDF invoices and bills', tint: 'text-rose-500' },
  { icon: ImageIcon, label: 'Photos of receipts', tint: 'text-sky-500' },
  { icon: FileSpreadsheet, label: 'CSV and XLSX — read row by row', tint: 'text-emerald-600' },
  { icon: FileType, label: 'Word and rich text', tint: 'text-indigo-500' },
  { icon: Camera, label: 'HEIC straight off a phone', tint: 'text-amber-500' },
];

/**
 * The formats this accepts, one at a time, on a card that flips.
 *
 * It was a stack of five rows rising at once — accurate, and a wall of text
 * lifted over the composer that covered the heading behind it. One card
 * carrying one format is a smaller promise and an easier read: the eye lands
 * on a single line, and the next arrives before it has finished with the last.
 *
 * The card resizes to its content rather than sitting at the width of the
 * longest label, so nothing is padded out to fit a line that is not showing.
 * That is what `layout` does here, and why the flip and the width change are
 * one movement instead of two.
 */
export function DocumentFormats({ open, anchor }: {
  open: boolean;
  /** The trigger's viewport rectangle, measured when the hover starts. */
  anchor: DOMRect | null;
}) {
  const [index, setIndex] = useState(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    setReduced(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  useEffect(() => {
    if (!open) {
      // Back to the first format, so the next hover starts from the top of
      // the list rather than wherever the last one happened to stop.
      setIndex(0);
      return;
    }
    const t = window.setInterval(() => setIndex((i) => (i + 1) % ACCEPTED.length), 1500);
    return () => window.clearInterval(t);
  }, [open]);

  if (typeof document === 'undefined') return null;

  const GAP = 12;
  const MARGIN = 8;
  // `index` only ever advances modulo ACCEPTED.length, so it always lands on a
  // format; the guard is here because the array read cannot say so on its own.
  const item = ACCEPTED[index];
  if (!item) return null;

  return createPortal(
    <AnimatePresence>
      {open && anchor && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6, transition: { duration: 0.12 } }}
          style={{
            position: 'fixed',
            left: Math.max(MARGIN, anchor.left),
            bottom: window.innerHeight - anchor.top + GAP,
            /**
             * Width is bounded by the space actually left to the right of the
             * card, not by the viewport. Aligning to the button and capping at
             * the window width are not the same thing — a button near the
             * right edge would still push a full-width card off-screen.
             */
            maxWidth: `min(22rem, calc(100vw - ${Math.max(MARGIN, anchor.left) + MARGIN}px))`,
          }}
          className="z-[70] pointer-events-none"
          aria-hidden="true"
        >
          {/* The perspective lives on the parent: without it rotateX is a
              vertical squash rather than a card turning over. */}
          <div style={{ perspective: 600 }}>
            <motion.div
              layout
              transition={{ layout: { duration: 0.28, ease: [0.16, 1, 0.3, 1] } }}
              className="inline-flex items-center gap-2.5 pl-2 pr-3.5 py-1.5 rounded-2xl bg-white border border-zinc-200/80 shadow-[0_8px_20px_-8px_rgba(0,0,0,0.25)] overflow-hidden"
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={item.label}
                  initial={reduced ? { opacity: 0 } : { rotateX: -90, opacity: 0 }}
                  animate={reduced ? { opacity: 1 } : { rotateX: 0, opacity: 1 }}
                  exit={reduced ? { opacity: 0 } : { rotateX: 90, opacity: 0 }}
                  transition={{ duration: reduced ? 0.18 : 0.34, ease: [0.16, 1, 0.3, 1] }}
                  style={{ transformOrigin: 'center', transformStyle: 'preserve-3d' }}
                  className="flex items-center gap-2.5 min-w-0"
                >
                  <span className="w-7 h-7 rounded-xl bg-zinc-50 border border-zinc-200/70 flex items-center justify-center shrink-0">
                    <item.icon size={14} className={item.tint} />
                  </span>
                  {/* Truncates rather than wrapping: the card is one line by
                      design, and a two-line card changes height mid-flip. */}
                  <span className="text-[12px] font-bold text-zinc-600 whitespace-nowrap overflow-hidden text-ellipsis">
                    {item.label}
                  </span>
                </motion.span>
              </AnimatePresence>
            </motion.div>
          </div>

          {/* Which of the five is showing. Without it a card that keeps
              changing reads as indecision rather than a list. */}
          <div className="flex items-center gap-1 mt-2 pl-1">
            {ACCEPTED.map((f, i) => (
              <motion.span
                key={f.label}
                animate={{ opacity: i === index ? 1 : 0.28, scale: i === index ? 1 : 0.8 }}
                transition={{ duration: 0.2 }}
                className="block w-1.5 h-1.5 rounded-full bg-zinc-400"
              />
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
