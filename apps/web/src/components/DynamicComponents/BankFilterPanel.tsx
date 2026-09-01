import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { Modal } from './Modal';
import {
  EMPTY_BANK_FILTERS,
  activeFilterCount,
  matchesBankFilters,
  type BankTxnFilters,
} from '../../lib/bankFilters';
import type { BankTransaction } from '../../lib/types';

/**
 * The Transactions tab's filter drawer — date range, amount range, direction,
 * suppliers — opened from the Filters button beside the evidence chips. It
 * EDITS the view's own filter state live (no Apply step: the table behind the
 * scrim is already answering, which is the honest preview), and it is a lazy
 * chunk on purpose: BankView rides the worst route in the app, whose budget
 * headroom is measured in hundreds of bytes, so everything here — the inputs,
 * the supplier tally, this prose — must stay off it until the button is
 * pressed.
 *
 * The supplier list is tallied from the CLIENT-scoped rows, not the filtered
 * ones — a list that hid suppliers your current filters exclude would make
 * those suppliers unreachable, when unreaching them is exactly what the list
 * is for. The count shown beside each name answers "how many rows is this",
 * with the match count previewing what the whole filter set leaves.
 */

const m = defineMessages({
  title: { id: 'bank.filterPanel.title', defaultMessage: 'Filter transactions' },
  matchCount: {
    id: 'bank.filterPanel.matchCount',
    defaultMessage: '{count, plural, one {# transaction matches} other {# transactions match}} the current filters.',
  },
  dateHeading: { id: 'bank.filterPanel.dateHeading', defaultMessage: 'Date' },
  dateFrom: { id: 'bank.filterPanel.dateFrom', defaultMessage: 'From' },
  dateTo: { id: 'bank.filterPanel.dateTo', defaultMessage: 'To' },
  amountHeading: { id: 'bank.filterPanel.amountHeading', defaultMessage: 'Amount (£)' },
  amountMin: { id: 'bank.filterPanel.amountMin', defaultMessage: 'Minimum' },
  amountMax: { id: 'bank.filterPanel.amountMax', defaultMessage: 'Maximum' },
  // A placeholder, not punctuation: the digits and the decimal separator are
  // locale facts, so it lives in the catalogue like any other string.
  amountPlaceholder: { id: 'bank.filterPanel.amountPlaceholder', defaultMessage: '0.00' },
  directionHeading: { id: 'bank.filterPanel.directionHeading', defaultMessage: 'Direction' },
  directionAll: { id: 'bank.filterPanel.directionAll', defaultMessage: 'All' },
  directionOut: { id: 'bank.filterPanel.directionOut', defaultMessage: 'Money out' },
  directionIn: { id: 'bank.filterPanel.directionIn', defaultMessage: 'Money in' },
  supplierHeading: { id: 'bank.filterPanel.supplierHeading', defaultMessage: 'Supplier' },
  supplierSearch: { id: 'bank.filterPanel.supplierSearch', defaultMessage: 'Search suppliers…' },
  supplierSearchLabel: { id: 'bank.filterPanel.supplierSearchLabel', defaultMessage: 'Search suppliers' },
  supplierNoMatch: {
    id: 'bank.filterPanel.supplierNoMatch',
    defaultMessage: 'No supplier matches “{query}”.',
  },
  clearAll: { id: 'bank.filterPanel.clearAll', defaultMessage: 'Clear all' },
  done: { id: 'bank.filterPanel.done', defaultMessage: 'Done' },
});

const LABEL_CLASS = 'block text-[11px] font-bold uppercase tracking-wider text-zinc-500 mb-2';
const FIELD_CLASS =
  'w-full px-4 py-2.5 rounded-2xl bg-raised border border-white/10 text-[13px] font-semibold text-white ' +
  'focus:outline-none focus:border-brand/50 placeholder:text-zinc-600';

/**
 * What the panel hands BankView: the filters (to re-open with), a compiled
 * predicate for `scopedTxns`, and the active count for the button. Compiled
 * HERE so the view never imports `lib/bankFilters` — the worst route's budget
 * is why (see the header comment).
 */
export interface BankRefinement {
  filters: BankTxnFilters;
  predicate: (t: BankTransaction) => boolean;
  active: number;
}

export default function BankFilterPanel({
  rows,
  current,
  onChange,
  onClose,
}: {
  /** The client-scoped transactions — the universe the filters refine. */
  rows: BankTransaction[];
  current: BankRefinement | null;
  onChange: (next: BankRefinement | null) => void;
  onClose: () => void;
}) {
  const intl = useIntl();
  const [supplierQuery, setSupplierQuery] = useState('');
  const filters = current?.filters ?? EMPTY_BANK_FILTERS;

  const suppliers = useMemo(() => {
    const tally = new Map<string, number>();
    for (const t of rows) tally.set(t.description, (tally.get(t.description) ?? 0) + 1);
    return [...tally.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  }, [rows]);

  const q = supplierQuery.trim().toLowerCase();
  const visibleSuppliers = q ? suppliers.filter((s) => s.name.toLowerCase().includes(q)) : suppliers;

  const matchCount = useMemo(() => rows.filter((t) => matchesBankFilters(t, filters)).length, [rows, filters]);

  const set = (patch: Partial<BankTxnFilters>) => {
    const next = { ...filters, ...patch };
    onChange({ filters: next, predicate: (t) => matchesBankFilters(t, next), active: activeFilterCount(next) });
  };
  const toggleSupplier = (name: string) =>
    set({
      suppliers: filters.suppliers.includes(name)
        ? filters.suppliers.filter((s) => s !== name)
        : [...filters.suppliers, name],
    });

  return (
    <Modal onClose={onClose} width="max-w-lg" label={intl.formatMessage(m.title)}>
      <div className="w-full bg-card border border-white/10 rounded-[28px] p-6 shadow-2xl">
        <h3 className="text-base font-bold text-white mb-1">{intl.formatMessage(m.title)}</h3>
        {/* The live answer — edits apply as they are made, and this line says
            what the table behind the scrim is already showing. */}
        <p className="text-[13px] text-zinc-500 leading-relaxed mb-5" aria-live="polite">
          {intl.formatMessage(m.matchCount, { count: matchCount })}
        </p>

        <div className="grid grid-cols-2 gap-4 mb-5">
          <div>
            <label className={LABEL_CLASS} htmlFor="bank-filter-from">
              {intl.formatMessage(m.dateHeading)} · {intl.formatMessage(m.dateFrom)}
            </label>
            <input
              id="bank-filter-from"
              type="date"
              className={FIELD_CLASS}
              value={filters.dateFrom}
              onChange={(e) => set({ dateFrom: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL_CLASS} htmlFor="bank-filter-to">
              {intl.formatMessage(m.dateHeading)} · {intl.formatMessage(m.dateTo)}
            </label>
            <input
              id="bank-filter-to"
              type="date"
              className={FIELD_CLASS}
              value={filters.dateTo}
              onChange={(e) => set({ dateTo: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL_CLASS} htmlFor="bank-filter-min">
              {intl.formatMessage(m.amountHeading)} · {intl.formatMessage(m.amountMin)}
            </label>
            <input
              id="bank-filter-min"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              placeholder={intl.formatMessage(m.amountPlaceholder)}
              className={FIELD_CLASS}
              value={filters.amountMin}
              onChange={(e) => set({ amountMin: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL_CLASS} htmlFor="bank-filter-max">
              {intl.formatMessage(m.amountHeading)} · {intl.formatMessage(m.amountMax)}
            </label>
            <input
              id="bank-filter-max"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              placeholder={intl.formatMessage(m.amountPlaceholder)}
              className={FIELD_CLASS}
              value={filters.amountMax}
              onChange={(e) => set({ amountMax: e.target.value })}
            />
          </div>
        </div>

        <div className="mb-5">
          <span className={LABEL_CLASS}>{intl.formatMessage(m.directionHeading)}</span>
          <div className="flex gap-2">
            {(['all', 'out', 'in'] as const).map((d) => (
              <button
                key={d}
                onClick={() => set({ direction: d })}
                aria-pressed={filters.direction === d}
                className={`px-4 py-2 rounded-full text-[13px] font-bold transition-all border ${
                  filters.direction === d
                    ? 'bg-brand text-white border-brand'
                    : 'bg-raised text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
                }`}
              >
                {intl.formatMessage(d === 'all' ? m.directionAll : d === 'out' ? m.directionOut : m.directionIn)}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-5">
          <span className={LABEL_CLASS}>{intl.formatMessage(m.supplierHeading)}</span>
          <div className="relative mb-2">
            <Search size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={supplierQuery}
              onChange={(e) => setSupplierQuery(e.target.value)}
              placeholder={intl.formatMessage(m.supplierSearch)}
              aria-label={intl.formatMessage(m.supplierSearchLabel)}
              className={`${FIELD_CLASS} pl-9`}
            />
          </div>
          <div className="max-h-[26dvh] overflow-y-auto flex flex-col gap-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {visibleSuppliers.map((s) => {
              const on = filters.suppliers.includes(s.name);
              return (
                <button
                  key={s.name}
                  onClick={() => toggleSupplier(s.name)}
                  aria-pressed={on}
                  className="w-full px-3 py-2 rounded-xl flex items-center justify-between gap-3 text-sm text-left hover:bg-white/5 transition-colors"
                >
                  <span className="flex items-center gap-3 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${on ? 'bg-brand' : 'bg-zinc-700'}`} />
                    <span className={`truncate ${on ? 'text-white' : 'text-zinc-300'}`}>{s.name}</span>
                  </span>
                  <span className="text-[11px] font-bold text-zinc-600 shrink-0">{s.count}</span>
                </button>
              );
            })}
            {visibleSuppliers.length === 0 && (
              <p className="px-3 py-2 text-[13px] text-zinc-500 leading-relaxed">
                {intl.formatMessage(m.supplierNoMatch, { query: supplierQuery.trim() })}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <button
            onClick={() => onChange(null)}
            disabled={activeFilterCount(filters) === 0}
            className="px-4 py-2 rounded-full text-sm font-medium text-zinc-400 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {intl.formatMessage(m.clearAll)}
          </button>
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-full text-sm font-bold bg-brand text-white hover:opacity-90 transition-opacity"
          >
            {intl.formatMessage(m.done)}
          </button>
        </div>
      </div>
    </Modal>
  );
}
