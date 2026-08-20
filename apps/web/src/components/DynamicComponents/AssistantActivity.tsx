import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowDownRight } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { motion } from 'motion/react';
import type { AssistantMeta } from '../../lib/types';

/**
 * The two halves of "something is happening" in the transcript: the wait, and
 * what answered.
 *
 * ## Why there is no "thinking" narration here
 *
 * The obvious thing to build is a stream of reasoning steps. This surface
 * deliberately does not, because it would be fiction. The chat runtime calls
 * the model with thinking OFF — `temperature: 0` plus a forced tool call,
 * chosen for determinism, the output-schema guarantee and reproducible evals —
 * so no chain of thought is produced and none comes back. A UI that showed
 * "Analysing your request… Checking the ledger…" would be animating a script
 * written by a frontend developer and presenting it as the model's reasoning.
 *
 * In a product whose entire argument is that a human approves what a machine
 * proposes, inventing the machine's reasoning is the worst available lie. So
 * the wait says only what is true: that a request is in flight, and — when a
 * client is attached — that the server is reading that client's records, which
 * is exactly what it does.
 */

const m = defineMessages({
  readingRecords: {
    id: 'shell.assistantActivity.readingRecords',
    defaultMessage: "Reading {client}'s records…",
  },
  working: { id: 'shell.assistantActivity.working', defaultMessage: 'Working on it…' },
  stillWorking: {
    id: 'shell.assistantActivity.stillWorking',
    defaultMessage: 'Still going — a long one sometimes takes a few seconds.',
  },
  answeredBy: {
    id: 'shell.assistantActivity.answeredBy',
    defaultMessage: '{model} · {seconds}s',
  },
  degraded: {
    id: 'shell.assistantActivity.degraded',
    defaultMessage: 'Answered by a fallback model',
  },
  budgetWarning: {
    id: 'shell.assistantActivity.budgetWarning',
    defaultMessage: "Most of today's AI allowance is used",
  },
  busy: { id: 'shell.assistantActivity.busy', defaultMessage: 'The assistant is answering' },
});

/** After this long, say so — silence past a few seconds reads as broken. */
const STILL_WORKING_AFTER_MS = 6000;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * The pending bubble. `aria-live="polite"` because the frontend ten require it
 * on chat updates — a screen-reader user is otherwise told nothing at all
 * between sending and receiving, which is the same gap this component exists
 * to close, just less visible.
 */
export function AssistantPending({ businessName }: { businessName: string | null }) {
  const intl = useIntl();
  const reduced = usePrefersReducedMotion();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), STILL_WORKING_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  const label =
    businessName === null
      ? intl.formatMessage(m.working)
      : intl.formatMessage(m.readingRecords, { client: businessName });

  return (
    <div className="flex flex-col gap-2" role="status" aria-live="polite" aria-label={intl.formatMessage(m.busy)}>
      <div className="flex items-center gap-3">
        <Dots reduced={reduced} />
        <span className="text-[15px] leading-relaxed text-zinc-400">{label}</span>
      </div>
      {slow && <span className="text-[12px] text-zinc-500">{intl.formatMessage(m.stillWorking)}</span>}
    </div>
  );
}

function Dots({ reduced }: { reduced: boolean }) {
  // Reduced motion gets a static row rather than nothing: the dots are the
  // affordance, the bouncing is the decoration.
  if (reduced) {
    return (
      <span className="flex gap-1" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
        ))}
      </span>
    );
  }

  return (
    <span className="flex gap-1" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-zinc-400"
          animate={{ opacity: [0.25, 1, 0.25], y: [0, -3, 0] }}
          transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut', delay: i * 0.16 }}
        />
      ))}
    </span>
  );
}

/**
 * What answered, under the reply it answered with.
 *
 * This is provenance, not decoration. SoT §13.3 makes the provenance of an
 * extracted value visible by default; the same reasoning applies to a sentence
 * a model wrote — an accountant reading advice should be able to see, without
 * asking, that a model produced it and which one. It also makes two conditions
 * visible that were previously silent: a degrade to a lower tier, and the
 * daily budget running out.
 *
 * Rendered only when `meta` exists, so a synthetic reply stays unlabelled
 * rather than borrowing a model's authority.
 */
export function AssistantMetaLine({ meta }: { meta: AssistantMeta }) {
  const intl = useIntl();

  // `anthropic.claude-opus-4-6-v1` → `claude-opus-4-6-v1`. The vendor prefix is
  // a Bedrock routing detail; the model is the fact worth showing. Trimmed
  // rather than prettified — a made-up display name would be a second name for
  // the same thing, and the two could disagree.
  const model = meta.model.replace(/^[a-z]+\./, '');
  const seconds = (meta.latencyMs / 1000).toFixed(1);

  return (
    <div className="flex flex-wrap items-center gap-2 mt-3">
      <span className="text-[11px] font-medium text-zinc-600 tabular-nums">
        {intl.formatMessage(m.answeredBy, { model, seconds })}
      </span>

      {meta.degraded && (
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400/90">
          <ArrowDownRight size={11} />
          {intl.formatMessage(m.degraded)}
        </span>
      )}

      {meta.budgetWarning && (
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-400/90">
          <AlertTriangle size={11} />
          {intl.formatMessage(m.budgetWarning)}
        </span>
      )}
    </div>
  );
}
