import { defineMessages, useIntl } from 'react-intl';
import { AlertTriangle } from 'lucide-react';
import { commonActions } from '../i18n/common';
import type { SliceStatus } from '../api/slices';

/**
 * The "this data could not be loaded" badge (launch M2, replacing METH
 * Stage 6's dev-only sample-data badge).
 *
 * A slice whose API fetch fails no longer degrades to the synthetic
 * generators — it says so, in EVERY build. The old badge rendered nothing in
 * production, which meant the one signal that would have told a paying
 * accountant "these rows are not real" was invisible in exactly the build
 * where it mattered. Now there are no fixture rows to disclaim; the badge
 * names the failure and, where the caller passes `onRetry`, offers the retry
 * the error state owes (frontend ten, item 5).
 *
 * Wired screens mount one per slice they read; the context header carries
 * them for the slices no single screen owns.
 */
const m = defineMessages({
  error: {
    id: 'shell.dataSourceBadge.error',
    defaultMessage: '{slice}: data could not be loaded',
  },
  truncated: {
    id: 'shell.dataSourceBadge.truncated',
    defaultMessage: '{slice}: showing the first {count, number} — there are more. Narrow the client or the period.',
  },
});

export function DataSourceBadge({
  slice,
  status,
  onRetry,
}: {
  slice: string;
  status: SliceStatus;
  onRetry?: () => void;
}) {
  const intl = useIntl();

  /**
   * ⚠ A SHORTENED list says so. It is not an error, and it is not silence.
   *
   * The bug this closes: `AppContext` asked for `{ limit: 100 }`, nothing read
   * `pageInfo`, and a client with 2,288 bank transactions saw 100 — with the
   * "unexplained" total, every footer count and the chase-candidate list all
   * reduced over that 4.4%, looking entirely normal. `api/paged.ts` now follows
   * the cursor to the end; this is what happens on the one path it cannot,
   * which is its own safety cap. Silently truncating a client's financial
   * records is not acceptable; a visible limit is.
   */
  if (status.source === 'api' && status.truncated === true) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-amber-500/20 bg-amber-500/10 text-[11px] font-bold text-amber-400 whitespace-nowrap">
        <AlertTriangle size={12} className="shrink-0" />
        {intl.formatMessage(m.truncated, { slice, count: status.loaded ?? 0 })}
      </span>
    );
  }

  if (status.source !== 'error') return null;

  return (
    <span
      title={status.error ?? undefined}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-amber-500/20 bg-amber-500/10 text-[11px] font-bold text-amber-400 whitespace-nowrap"
    >
      <AlertTriangle size={12} className="shrink-0" />
      {intl.formatMessage(m.error, { slice })}
      {onRetry && (
        <button
          onClick={onRetry}
          className="ml-1 px-2 py-0.5 rounded-full border border-amber-500/30 hover:bg-amber-500/20 text-amber-300 transition-colors"
        >
          {intl.formatMessage(commonActions.retry)}
        </button>
      )}
    </span>
  );
}

/**
 * The full-size version, for a surface whose whole live board failed to load.
 * These used to fall back to the synthetic boards; now the screen says what
 * happened and offers the way forward. `heading` arrives already formatted —
 * it is the view's own sentence about the view's own data.
 */
export function SliceLoadError({
  heading,
  error,
  onRetry,
}: {
  heading: string;
  error: string | null;
  onRetry: () => void;
}) {
  const intl = useIntl();
  return (
    <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border bg-red-500/10 border-red-500/20 text-red-300 text-[13px] font-semibold">
      <AlertTriangle size={15} className="shrink-0" />
      <span className="min-w-0">
        {heading}
        {error && <span className="block text-[12px] font-medium text-red-300/80 truncate">{error}</span>}
      </span>
      <button
        onClick={onRetry}
        className="ml-auto shrink-0 px-3.5 py-1.5 rounded-full text-[12px] font-bold border border-red-500/30 text-red-200 hover:bg-red-500/20 transition-colors"
      >
        {intl.formatMessage(commonActions.retry)}
      </button>
    </div>
  );
}
