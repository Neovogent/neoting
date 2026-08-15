import { useEffect, useRef, useState } from 'react';
import type { Suggestion } from '../../lib/promptSuggestions';

/**
 * The placeholder types itself, and you can take what it offers.
 *
 * A static "Type something to generate…" asks someone to invent the product's
 * vocabulary before it has shown them any. These sentences are read off the
 * real backlog, so the box is both an example of how to ask and a statement of
 * what is actually outstanding — the first suggestion on a bad morning is the
 * thing most worth doing.
 *
 * It is a real control, not decoration: clicking anywhere on the line accepts
 * the whole sentence, and Tab does the same from the keyboard. Nothing is sent
 * — it lands in the box as text to edit, because a suggestion that submits
 * itself is a suggestion you cannot decline.
 */

const TYPE_MS = 26;
const DELETE_MS = 12;
const HOLD_MS = 2600;

export function TypedPlaceholder({ suggestions, onAccept, paused }: {
  suggestions: Suggestion[];
  onAccept: (text: string) => void;
  /** Held still while the user is typing or dictating. */
  paused?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState('');
  const [phase, setPhase] = useState<'typing' | 'holding' | 'deleting'>('typing');
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced.current && suggestions[0]) setShown(suggestions[0].text);
  }, [suggestions]);

  const current = suggestions[index % Math.max(1, suggestions.length)];

  useEffect(() => {
    if (paused || !current || reduced.current) return;

    if (phase === 'typing') {
      if (shown.length < current.text.length) {
        const t = window.setTimeout(() => setShown(current.text.slice(0, shown.length + 1)), TYPE_MS);
        return () => window.clearTimeout(t);
      }
      const t = window.setTimeout(() => setPhase('holding'), 0);
      return () => window.clearTimeout(t);
    }

    if (phase === 'holding') {
      // Long enough to read the whole line and decide to take it. Cycling
      // faster than someone can read defeats the point of the suggestion.
      const t = window.setTimeout(() => setPhase(suggestions.length > 1 ? 'deleting' : 'holding'), HOLD_MS);
      return () => window.clearTimeout(t);
    }

    if (shown.length > 0) {
      const t = window.setTimeout(() => setShown(shown.slice(0, -1)), DELETE_MS);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => {
      setIndex((i) => (i + 1) % suggestions.length);
      setPhase('typing');
    }, 180);
    return () => window.clearTimeout(t);
  }, [shown, phase, current, paused, suggestions.length]);

  if (!current) return null;

  const complete = shown === current.text;

  return (
    <button
      type="button"
      onClick={() => onAccept(current.text)}
      // Not in the tab order ahead of the textarea: someone tabbing into the
      // composer wants the box, and Tab from inside it accepts instead.
      tabIndex={-1}
      aria-hidden="true"
      className="absolute left-6 right-6 top-6 text-left group cursor-text"
    >
      <span className="block text-[16px] font-medium text-zinc-400 leading-snug">
        {shown}
        <span className="inline-block w-[2px] h-[1.05em] -mb-[0.15em] ml-[1px] bg-zinc-400 animate-pulse" />
      </span>

      {/* The offer only appears once the sentence is whole — half a sentence
          is not something anyone can decide about. */}
      <span
        className={`mt-2 inline-flex items-center gap-2 text-[11.5px] font-bold transition-opacity duration-300 ${
          complete ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <span className="px-2 py-1 rounded-full bg-[#14e3c4]/15 text-[#00806d]">Tab or click to use this</span>
        <span className="text-zinc-400 font-semibold normal-case">{current.because}</span>
      </span>
    </button>
  );
}
