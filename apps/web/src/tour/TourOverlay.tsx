import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Check, MessageSquare, X } from 'lucide-react';
import { FormattedMessage, defineMessages, useIntl } from 'react-intl';
import { useViewport } from '../lib/useViewport';
import type { TourStep } from './steps';

/**
 * The visible half of the tour: a spotlight ring around the target and the
 * explanation box.
 *
 * ⚠ WHAT IS AND IS NOT BLOCKED WHILE THE TOUR IS ON. The overlay lets pointer
 * events through — `pointer-events-none` on the root, re-enabled only on the
 * box — so the page underneath still scrolls, hovers AND RESPONDS TO CLICKS.
 * Nothing swallows them. The only guard is `lockNavigation` in `lib/router.ts`,
 * and it is narrower than it sounds: a tab, a row or a deep-link button still
 * runs its handler and still changes local state, it just cannot move the
 * ADDRESS, so the tour keeps the screen it is describing. Keystrokes are not
 * swallowed either — TourProvider adds arrow/Enter/Escape handlers on top of
 * whatever the page already listens for, and skips them while a field has
 * focus. (This paragraph replaces one that claimed the opposite. Read the
 * router before trusting a comment about what the tour blocks.)
 *
 * Desktop: the box floats beside the target — right, left, below, above,
 * whichever has room. Phone: the box is a sheet at the bottom, and moves to
 * the top when the target sits in the lower half, so it never covers what it
 * is talking about. Before measuring, the target is scrolled clear of the
 * band the box will occupy.
 *
 * The step's own words arrive from `steps.ts` as PLAIN ENGLISH STRINGS and are
 * rendered as variables — `{step.title}`, never a literal, which is why
 * `neoting/no-literal-string-in-jsx` has nothing to say about them. The tour's
 * own chrome below is a different thing and keeps its `defineMessages`: those
 * are buttons and a counter, ordinary UI copy, and un-wrapping them would be a
 * lint error as well as a regression. See the header of `steps.ts` for the
 * decision that split the two.
 */

const m = defineMessages({
  leave: { id: 'tour.overlay.leave', defaultMessage: 'Leave the tour' },
  orJustAsk: { id: 'tour.overlay.orJustAsk', defaultMessage: 'Or just ask: ' },
  askQuoted: {
    id: 'tour.overlay.askQuoted',
    defaultMessage: '“{ask}”',
    description: 'The suggested prompt, in quotation marks. Use the quotation marks of the target locale.',
  },
  missingTarget: {
    id: 'tour.overlay.missingTarget',
    defaultMessage: 'This part is not on screen in the current layout — carry on, the rest of the tour still works.',
  },
  progress: {
    id: 'tour.overlay.progress',
    defaultMessage: '{current} / {total}',
    description: 'Step counter, e.g. 12 / 63.',
  },
  back: { id: 'tour.overlay.back', defaultMessage: 'Back' },
  next: { id: 'tour.overlay.next', defaultMessage: 'Next' },
  finish: { id: 'tour.overlay.finish', defaultMessage: 'Finish' },
});

interface Rect { top: number; left: number; width: number; height: number }

const PAD = 8;          // spotlight breathing room around the target
const GAP = 16;         // box distance from target / viewport edges
const BOX_W = 340;      // desktop box width
const FIND_TIMEOUT = 3000;

function findTarget(key: string): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${key}"]`));
  // Two layouts can share a key (rail / bottom bar, table / cards); the last
  // visible one wins — it is also the newest chat card.
  const visible = all.filter((el) => el.getClientRects().length > 0 && el.offsetWidth > 0 && el.offsetHeight > 0);
  return visible[visible.length - 1] ?? null;
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

/** Scroll so the element sits inside [topPad, viewportHeight - bottomPad]. */
function nudgeIntoBand(el: HTMLElement, topPad: number, bottomPad: number) {
  const parent = scrollParent(el);
  if (!parent) return;
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const room = vh - topPad - bottomPad;
  let delta = 0;
  if (r.height >= room) delta = r.top - topPad;            // too tall: align its top
  else if (r.top < topPad) delta = r.top - topPad;
  else if (r.bottom > vh - bottomPad) delta = r.bottom - (vh - bottomPad);
  if (Math.abs(delta) > 1) parent.scrollBy({ top: delta, behavior: 'auto' });
}

export function TourOverlay({
  step, index, total, onNext, onPrev, onStop,
}: {
  step: TourStep;
  index: number;
  total: number;
  onNext: () => void;
  onPrev: () => void;
  onStop: () => void;
}) {
  const intl = useIntl();
  const { phone } = useViewport();
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);
  const [boxSize, setBoxSize] = useState({ w: BOX_W, h: 220 });
  // The find/nudge effect reads the height through a ref so a resize of the
  // box never restarts the search for the target.
  const boxSizeRef = useRef(boxSize);
  const boxRef = useRef<HTMLDivElement>(null);
  const nudgedRef = useRef(false);

  // Measure the box whenever its content changes — placement needs its height.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const apply = () => {
      const next = { w: el.offsetWidth, h: el.offsetHeight };
      boxSizeRef.current = next;
      setBoxSize(next);
    };
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    apply();
    return () => ro.disconnect();
  }, [step.id]);

  // Find the target (views animate in), bring it into view, then keep the
  // spotlight glued to it while the step is open.
  const target = step.target;
  const settleMs = step.settle ?? 0;
  useEffect(() => {
    setRect(null);
    setMissing(false);
    nudgedRef.current = false;
    if (!target) return;

    let raf = 0;
    let cancelled = false;
    const started = performance.now();

    const tick = () => {
      if (cancelled) return;
      const el = findTarget(target);
      if (!el) {
        if (performance.now() - started > FIND_TIMEOUT + settleMs) setMissing(true);
        raf = requestAnimationFrame(tick);
        return;
      }
      if (performance.now() - started < settleMs) {
        raf = requestAnimationFrame(tick);
        return;
      }
      if (!nudgedRef.current) {
        nudgedRef.current = true;
        // Reserve the band the box will sit in. On a phone that is the bottom
        // (or the top, decided below once we know where the target is).
        const reserve = phone ? boxSizeRef.current.h + GAP * 2 : 0;
        const r0 = el.getBoundingClientRect();
        const lowerHalf = r0.top + r0.height / 2 > window.innerHeight / 2;
        nudgeIntoBand(el, GAP + (phone && lowerHalf ? reserve : 0), GAP + (phone && !lowerHalf ? reserve : 0));
      }
      const r = el.getBoundingClientRect();
      setRect((prev) => {
        if (prev && Math.abs(prev.top - r.top) < 0.5 && Math.abs(prev.left - r.left) < 0.5 && Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5) return prev;
        return { top: r.top, left: r.left, width: r.width, height: r.height };
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [step.id, target, settleMs, phone]);

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const spot = rect
    ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }
    : null;

  // ----- box placement -----
  let boxStyle: CSSProperties;
  if (phone) {
    const lowerHalf = spot ? spot.top + spot.height / 2 > vh / 2 : false;
    boxStyle = lowerHalf
      ? { top: GAP, left: GAP, right: GAP }
      : { bottom: GAP, left: GAP, right: GAP };
  } else if (!spot) {
    const W = Math.min(BOX_W + 60, vw - GAP * 2);
    boxStyle = { top: Math.max(GAP, (vh - (boxSize.h || 220)) / 2), left: Math.max(GAP, (vw - W) / 2), width: W };
  } else {
    const W = boxSize.w || BOX_W;
    const H = boxSize.h || 220;
    const clampY = (y: number) => Math.max(GAP, Math.min(y, vh - H - GAP));
    const clampX = (x: number) => Math.max(GAP, Math.min(x, vw - W - GAP));
    const centreY = spot.top + spot.height / 2 - H / 2;
    const centreX = spot.left + spot.width / 2 - W / 2;
    if (spot.left + spot.width + GAP + W <= vw - GAP) {
      boxStyle = { top: clampY(centreY), left: spot.left + spot.width + GAP, width: W };
    } else if (spot.left - GAP - W >= GAP) {
      boxStyle = { top: clampY(centreY), left: spot.left - GAP - W, width: W };
    } else if (spot.top + spot.height + GAP + H <= vh - GAP) {
      boxStyle = { top: spot.top + spot.height + GAP, left: clampX(centreX), width: W };
    } else if (spot.top - GAP - H >= GAP) {
      boxStyle = { top: spot.top - GAP - H, left: clampX(centreX), width: W };
    } else {
      boxStyle = { bottom: GAP, left: clampX(centreX), width: W };
    }
  }

  const last = index === total - 1;

  return createPortal(
    <div className="tour-root fixed inset-0 z-[500] pointer-events-none" aria-live="polite">
      {/* Spotlight — or a plain dim when the step has nothing to point at. */}
      {spot ? (
        <div
          className="tour-spot absolute rounded-2xl"
          style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/65 transition-opacity" />
      )}

      {/* The explanation box. */}
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        className={`tour-box pointer-events-auto absolute rounded-[24px] border border-white/10 bg-card shadow-2xl text-white ${phone ? 'pb-safe' : ''}`}
        style={boxStyle}
      >
        <div className="p-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-bold uppercase tracking-widest text-brand">{step.section}</div>
              <h2 id="tour-title" className="font-sans text-[17px] font-bold tracking-tight text-white mt-1 leading-snug">{step.title}</h2>
            </div>
            <button
              onClick={onStop}
              aria-label={intl.formatMessage(m.leave)}
              title={intl.formatMessage(m.leave)}
              className="shrink-0 p-2 -m-2 rounded-full text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
          <p className="text-[13.5px] leading-relaxed text-zinc-400 mt-2.5">{step.body}</p>
          {step.ask && (
            <div className="mt-3 flex items-start gap-2 rounded-xl bg-ground/60 border border-white/5 px-3 py-2">
              <MessageSquare size={13} className="text-brand mt-0.5 shrink-0" />
              <div className="min-w-0 text-[12.5px] leading-snug">
                <span className="text-zinc-500 font-semibold"><FormattedMessage {...m.orJustAsk} /></span>
                <span className="text-zinc-200 font-medium">
                  <FormattedMessage {...m.askQuoted} values={{ ask: step.ask }} />
                </span>
              </div>
            </div>
          )}
          {missing && !rect && (
            <p className="mt-3 text-[12px] text-amber-400 font-semibold"><FormattedMessage {...m.missingTarget} /></p>
          )}
        </div>
        <div className="px-5 pb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-1 w-16 rounded-full bg-white/10 overflow-hidden shrink-0">
              <div className="h-full bg-brand rounded-full transition-[width] duration-300" style={{ width: `${((index + 1) / total) * 100}%` }} />
            </div>
            <span className="text-[11px] font-bold text-zinc-500 tabular-nums whitespace-nowrap">
              <FormattedMessage {...m.progress} values={{ current: index + 1, total }} />
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onPrev}
              disabled={index === 0}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ArrowLeft size={14} />
              <FormattedMessage {...m.back} />
            </button>
            <button
              onClick={onNext}
              className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-btn"
            >
              <FormattedMessage {...(last ? m.finish : m.next)} />
              {last ? <Check size={14} strokeWidth={3} /> : <ArrowRight size={14} />}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
