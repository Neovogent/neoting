import type { ReactNode } from 'react';

export interface SubTab {
  key: string;
  label: string;
  count?: number;
  /** Draws attention without shouting — used for failures. */
  alert?: boolean;
  badge?: ReactNode;
}

/**
 * Second-level navigation inside a client tab.
 *
 * Still the brand colour on the selected tab — it should look like the rest of
 * the app — but a different weight of it. The client tab rail above is
 * free-floating pills with a solid mint fill; this is a recessed track with a
 * tinted mint chip. Same colour, different shape, so two rows of tabs stacked
 * on one screen read as two levels rather than one long confusing list.
 */
export function SubTabs({ tabs, active, onChange }: {
  tabs: SubTab[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-2xl bg-ground border border-white/5 shadow-inner max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {tabs.map((t) => {
        const selected = t.key === active;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            aria-pressed={selected}
            className={`shrink-0 px-3.5 py-2 rounded-xl text-[12.5px] font-bold transition-colors flex items-center gap-2 whitespace-nowrap ${
              selected
                ? 'bg-brand/15 text-brand border border-brand/30 shadow-[0_0_10px_rgba(20,227,196,0.12)]'
                : 'text-zinc-500 hover:text-white border border-transparent'
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span
                className={`tabular-nums text-[11px] px-1.5 py-0.5 rounded-md ${
                  selected ? 'bg-brand/15 text-brand' : 'text-zinc-600'
                }`}
              >
                {t.count}
              </span>
            )}
            {/* A failure is worth a dot even when the tab is not selected. */}
            {t.alert && !selected && <span className="w-1.5 h-1.5 rounded-full bg-red-500" />}
            {t.badge}
          </button>
        );
      })}
    </div>
  );
}
