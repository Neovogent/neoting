import type { BankTransaction } from './types';

/**
 * The Transactions tab's refinement filters — everything beyond the evidence
 * chips and the free-text search: a date range, an amount range, the money's
 * direction, and named suppliers. A plain serialisable object, owned by
 * BankView as one piece of state and edited by the lazy `BankFilterPanel`, so
 * the panel's whole UI stays off the route chunk.
 *
 * Dates are ISO `yyyy-mm-dd` — the dialect `<input type="date">` speaks —
 * compared lexicographically against the row's display date re-read through
 * `displayDateToIso`. Amounts are the input's own string, parsed here and
 * compared against the ABSOLUTE display amount: this is display-tier
 * arithmetic like the rest of the screen (`unexplained` sums the same
 * `Math.abs`), never money that travels.
 */
export interface BankTxnFilters {
  dateFrom: string;
  dateTo: string;
  amountMin: string;
  amountMax: string;
  /** `in` is a credit/refund (the emerald rows); `out` an ordinary payment. */
  direction: 'all' | 'out' | 'in';
  /** Exact `description` values; empty means every supplier. */
  suppliers: string[];
}

export const EMPTY_BANK_FILTERS: BankTxnFilters = {
  dateFrom: '',
  dateTo: '',
  amountMin: '',
  amountMax: '',
  direction: 'all',
  suppliers: [],
};

/** How many refinements are on — the figure the Filters button wears. */
export function activeFilterCount(f: BankTxnFilters): number {
  return (
    (f.dateFrom || f.dateTo ? 1 : 0) +
    (f.amountMin || f.amountMax ? 1 : 0) +
    (f.direction === 'all' ? 0 : 1) +
    (f.suppliers.length ? 1 : 0)
  );
}

const MONTH_NUM: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/**
 * "10 Aug 2026" — the shape every screen renders (`fromIsoDate`) and the seeds
 * mint (`dateIn`) — back to "2026-08-10". `''` when unreadable, and the
 * predicate treats an unreadable date as OUTSIDE any requested range: a row
 * that cannot be placed must not pass a filter that asked about placement.
 */
export function displayDateToIso(display: string): string {
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(display.trim());
  if (!m) return '';
  const month = MONTH_NUM[m[2]!];
  if (!month) return '';
  return `${m[3]}-${month}-${m[1]!.padStart(2, '0')}`;
}

export function matchesBankFilters(t: BankTransaction, f: BankTxnFilters): boolean {
  if (f.direction === 'in' && !t.isCredit) return false;
  if (f.direction === 'out' && t.isCredit) return false;
  if (f.suppliers.length > 0 && !f.suppliers.includes(t.description)) return false;

  if (f.dateFrom || f.dateTo) {
    const iso = displayDateToIso(t.date);
    if (!iso) return false;
    if (f.dateFrom && iso < f.dateFrom) return false;
    if (f.dateTo && iso > f.dateTo) return false;
  }

  const abs = Math.abs(t.amount);
  const min = Number.parseFloat(f.amountMin);
  const max = Number.parseFloat(f.amountMax);
  if (!Number.isNaN(min) && abs < min) return false;
  if (!Number.isNaN(max) && abs > max) return false;
  return true;
}
