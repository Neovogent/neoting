import { useState } from 'react';
import { BarChart2 } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { seedAnalytics } from '../../lib/seed';

const m = defineMessages({
  heading: { id: 'shell.pipelineStats.heading', defaultMessage: 'Pipeline health' },
  scope: { id: 'shell.pipelineStats.scope', defaultMessage: '{scope} • last 7 days' },
  seriesTitle: { id: 'shell.pipelineStats.seriesTitle', defaultMessage: 'Documents processed per day' },
  hovered: { id: 'shell.pipelineStats.hovered', defaultMessage: '{label} — {value}' },
  peak: { id: 'shell.pipelineStats.peak', defaultMessage: 'peak {max}' },
  // Not a `plural` argument, deliberately: Sunday's value is 1 in the seed, so
  // an ICU plural here would render "1 document" where the DOM has always said
  // "1 documents". #65 extracts copy; it does not rewrite it. Worth fixing as
  // its own change.
  barLabel: { id: 'shell.pipelineStats.barLabel', defaultMessage: '{label}: {value} documents' },
  scopeNote: {
    id: 'shell.pipelineStats.scopeNote',
    defaultMessage:
      'Pipeline metrics only. Ledger reporting — P&L, balance sheet, management accounts — is out of scope for this product.',
  },
});

/**
 * Operational counts for the document pipeline (PRD section 11).
 * Deliberately not ledger analytics — no P&L, no balance sheet, no Data Health.
 *
 * Single series, single hue: no legend needed (the title names it), values live
 * in text ink rather than the series colour, and the axis stays recessive.
 */
export function PipelineStats({ scopeName }: { scopeName: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const intl = useIntl();
  const data = seedAnalytics.processed;
  const max = Math.max(...data.map((d) => d.value));
  const peak = data.findIndex((d) => d.value === max);
  // `hover` is only ever set from a bar's own index, so this resolves whenever
  // it is not null; naming the bar saves reaching back into the array to read it.
  const hovered = hover === null ? null : data[hover];

  return (
    <div className="w-full max-w-3xl border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col">
      <div className="p-6 flex items-center gap-4 border-b border-white/5">
        <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white shrink-0 border border-white/5 shadow-inner">
          <BarChart2 size={22} />
        </div>
        <div className="min-w-0">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">{intl.formatMessage(m.heading)}</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider truncate">
            {intl.formatMessage(m.scope, { scope: scopeName })}
          </p>
        </div>
      </div>

      {/* Stat tiles — the right form for a single headline number. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 divide-x divide-y divide-white/5 border-b border-white/5">
        {seedAnalytics.stats.map((s) => (
          <div key={s.label} className="p-5">
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">{s.label}</div>
            <div className="mt-2 text-2xl font-bold text-white tracking-tight tabular-nums">{s.value}</div>
            <div className="text-[11px] text-zinc-600 font-semibold mt-0.5">{s.sub}</div>
          </div>
        ))}
      </div>

      <div className="p-6">
        <div className="flex items-baseline justify-between mb-5">
          <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">{intl.formatMessage(m.seriesTitle)}</span>
          <span className="text-[11px] font-semibold text-zinc-600 tabular-nums">
            {hovered
              ? intl.formatMessage(m.hovered, { label: hovered.label, value: hovered.value })
              : intl.formatMessage(m.peak, { max })}
          </span>
        </div>

        <div className="flex items-end gap-[2px] h-40" onMouseLeave={() => setHover(null)}>
          {data.map((d, i) => (
            <button
              key={d.label}
              onMouseEnter={() => setHover(i)}
              className="flex-1 h-full flex flex-col justify-end group"
              aria-label={intl.formatMessage(m.barLabel, { label: d.label, value: d.value })}
            >
              <div
                className={`w-full rounded-t transition-colors ${
                  hover === i || (hover === null && i === peak) ? 'bg-brand' : 'bg-brand/45 group-hover:bg-brand'
                }`}
                style={{ height: `${(d.value / max) * 100}%` }}
              />
            </button>
          ))}
        </div>

        {/* Recessive axis: labels in muted ink, one hairline baseline, no gridlines. */}
        <div className="border-t border-white/10 mt-0 pt-2 flex gap-[2px]">
          {data.map((d, i) => (
            <span
              key={d.label}
              className={`flex-1 text-center text-[11px] font-semibold tabular-nums transition-colors ${
                hover === i ? 'text-zinc-300' : 'text-zinc-600'
              }`}
            >
              {d.label}
            </span>
          ))}
        </div>
      </div>

      <div className="bg-raised/50 px-6 py-4 text-[12px] text-zinc-500 font-semibold leading-relaxed">
        {intl.formatMessage(m.scopeNote)}
      </div>
    </div>
  );
}
