import { useState } from 'react';
import { BarChart2 } from 'lucide-react';
import { seedAnalytics } from '../../lib/seed';

/**
 * Operational counts for the document pipeline (PRD section 11).
 * Deliberately not ledger analytics — no P&L, no balance sheet, no Data Health.
 *
 * Single series, single hue: no legend needed (the title names it), values live
 * in text ink rather than the series colour, and the axis stays recessive.
 */
export function PipelineStats({ scopeName }: { scopeName: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const data = seedAnalytics.processed;
  const max = Math.max(...data.map((d) => d.value));
  const peak = data.findIndex((d) => d.value === max);

  return (
    <div className="w-full max-w-3xl border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden flex flex-col">
      <div className="p-6 flex items-center gap-4 border-b border-white/5">
        <div className="w-12 h-12 rounded-2xl bg-[#202026] flex items-center justify-center text-white shrink-0 border border-white/5 shadow-inner">
          <BarChart2 size={22} />
        </div>
        <div className="min-w-0">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">Pipeline health</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider truncate">
            {scopeName} • last 7 days
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
          <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">Documents processed per day</span>
          <span className="text-[11px] font-semibold text-zinc-600 tabular-nums">
            {hover !== null ? `${data[hover].label} — ${data[hover].value}` : `peak ${max}`}
          </span>
        </div>

        <div className="flex items-end gap-[2px] h-40" onMouseLeave={() => setHover(null)}>
          {data.map((d, i) => (
            <button
              key={d.label}
              onMouseEnter={() => setHover(i)}
              className="flex-1 h-full flex flex-col justify-end group"
              aria-label={`${d.label}: ${d.value} documents`}
            >
              <div
                className={`w-full rounded-t transition-colors ${
                  hover === i || (hover === null && i === peak) ? 'bg-[#14e3c4]' : 'bg-[#14e3c4]/45 group-hover:bg-[#14e3c4]'
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

      <div className="bg-[#202026]/50 px-6 py-4 text-[12px] text-zinc-500 font-semibold leading-relaxed">
        Pipeline metrics only. Ledger reporting — P&amp;L, balance sheet, management accounts — is out of scope for this
        product.
      </div>
    </div>
  );
}
