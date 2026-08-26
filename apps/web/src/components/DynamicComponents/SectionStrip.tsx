import { useEffect, useRef, type ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';

/**
 * A row of section pills that scrolls sideways instead of wrapping, for the
 * places a side list or a wide tab row used to be. The active pill is brought
 * into view whenever it changes, so a deep link never lands on a strip whose
 * selected item is off-screen.
 *
 * `label` is REQUIRED, unlike the frame this was ported from, which rendered
 * `item.label ?? item.key` and so leaked a raw machine key ('vat-returns')
 * into the UI the moment a caller forgot one — untranslated, and untranslatable
 * because nothing would ever flag it. `key` is identity; `label` is copy, and
 * every call site passes `intl.formatMessage(...)`.
 */
export interface StripItem {
  /** Stable identity. Never rendered — see the note above. */
  key: string;
  label: string;
  icon?: ComponentType<LucideProps>;
  count?: number;
}

interface SectionStripProps {
  items: StripItem[];
  active: string;
  onSelect: (key: string) => void;
  className?: string;
  /** data-tour key for the demo tour. */
  tourKey?: string;
}

export function SectionStrip({ items, active, onSelect, className = '', tourKey }: SectionStripProps) {
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [active]);

  return (
    <div
      {...(tourKey === undefined ? {} : { 'data-tour': tourKey })}
      className={`scroll-x flex items-center gap-2 px-4 pb-3 ${className}`}
      role="tablist"
    >
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            ref={isActive ? activeRef : undefined}
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(item.key)}
            className={`shrink-0 flex items-center gap-2 px-3.5 py-2 rounded-full text-[13px] font-semibold whitespace-nowrap border transition-colors ${
              isActive
                ? 'bg-card text-white border-white/10'
                : 'text-zinc-400 border-transparent hover:text-white hover:bg-card/50'
            }`}
          >
            {item.icon && <item.icon size={14} className={isActive ? 'text-brand' : ''} />}
            {item.label}
            {typeof item.count === 'number' && (
              <span className="text-[11px] font-bold text-zinc-500">{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
