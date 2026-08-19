import { defineMessages, useIntl } from 'react-intl';
import { AlertTriangle } from 'lucide-react';
import type { SliceStatus } from '../api/slices';

/**
 * The dev-only "this screen fell back to sample data" badge (METH Stage 6).
 *
 * A slice whose API fetch fails degrades to the synthetic generators rather
 * than to a blank screen — that is the standing fallback — but fixtures that
 * look like server truth are a trap for whoever is debugging, so in a dev
 * build the fallback wears this. Production builds render nothing: the
 * degradation itself is the designed behaviour there.
 *
 * Wired screens (Stages 7/11/12) mount one per slice they read; the context
 * header carries them for the slices no single screen owns.
 */
const m = defineMessages({
  fallback: {
    id: 'shell.dataSourceBadge.fallback',
    defaultMessage: '{slice}: sample data — the API fetch failed',
  },
});

export function DataSourceBadge({ slice, status }: { slice: string; status: SliceStatus }) {
  const intl = useIntl();
  if (!import.meta.env.DEV || status.source !== 'seed-fallback') return null;

  return (
    <span
      title={status.error ?? undefined}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-amber-500/20 bg-amber-500/10 text-[11px] font-bold text-amber-400 whitespace-nowrap"
    >
      <AlertTriangle size={12} className="shrink-0" />
      {intl.formatMessage(m.fallback, { slice })}
    </span>
  );
}
