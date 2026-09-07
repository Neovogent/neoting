/**
 * A task's due date is a CALENDAR date, not a moment.
 *
 * ⚠ **The whole file exists because of one bug.** `new Date('2026-03-01')`
 * parses as UTC midnight, but `getMonth()`/`getDate()` read it in the SERVER's
 * timezone — so west of Greenwich the 1st reads back as the 28th of February,
 * and a VAT deadline files into the wrong month. Every function here reads and
 * writes UTC components only. It is the same trap `UkDateField` documents on
 * the web side, and the same answer: no date library, because the whole job is
 * two conversions and one addition, and a library that shifts the date it was
 * handed is worse than the arithmetic it replaced.
 *
 * `tasks.due_at` is a `timestamp` column (it predates this feature), so the
 * storage convention is UTC midnight on the intended day and the contract
 * carries `YYYY-MM-DD` at both ends.
 */

/** `YYYY-MM-DD` → UTC midnight on that day. */
export function utcMidnight(isoDate: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  // The contract's `format: date` is advisory in Zod, so a malformed string can
  // arrive. `Date` on the raw value is the honest fallback — an invalid date
  // fails the column rather than being silently coerced to today.
  if (match === null) return new Date(isoDate);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/** UTC midnight → `YYYY-MM-DD`, read in UTC. `toISOString().slice(0, 10)` by hand. */
export function isoDateFromUtc(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Roll a due date forward by one cadence period.
 *
 * ⚠ **Month-end is clamped, not overflowed.** `Date.UTC(2026, 1, 31)` is 3
 * March, so a task due 31 January would come round on the 3rd of March and then
 * drift further every cycle. Clamping to the last day of the target month keeps
 * "the 31st" meaning month-end, which is what an accounting deadline is.
 * Non-month-end days are unaffected.
 */
export function advanceDueDate(from: Date, cadence: string | null): Date {
  const months = cadence === 'quarterly' ? 3 : 1;
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + months;
  const day = from.getUTCDate();
  // Day 0 of the following month is the last day of the target month.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
}
