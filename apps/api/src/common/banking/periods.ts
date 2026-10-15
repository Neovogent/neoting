/**
 * Calendar months for period close (rush/matching, SoT §4 Stage 7).
 *
 * A period is a UTC calendar month written `YYYY-MM`. Bank lines and document
 * dates are stored as UTC instants (statement dates land at UTC midnight), so
 * UTC month boundaries are the honest ones — "UTC in storage" — and rendering
 * the label in Europe/London never moves a date across a month edge for a
 * midnight-stored date.
 */

export interface PeriodWindow {
  readonly periodStart: Date;
  /** Exclusive. */
  readonly periodEnd: Date;
}

const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `[start, end)` for a `YYYY-MM` period. Throws on a malformed period. */
export function monthBounds(period: string): { start: Date; end: Date } {
  const match = PERIOD_PATTERN.exec(period);
  if (match === null) throw new Error(`not a YYYY-MM period: ${period}`);
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  return { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)) };
}

/** The `YYYY-MM` period an instant falls in (UTC). */
export function periodOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** "August 2026" — for refusals and review cards. */
export function periodLabel(period: string): string {
  const { start } = monthBounds(period);
  return start.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The closed window a date falls inside, or null. A null date is never inside one. */
export function closedPeriodContaining(locks: readonly PeriodWindow[], date: Date | null | undefined): PeriodWindow | null {
  if (date === null || date === undefined) return null;
  const t = date.getTime();
  return locks.find((lock) => t >= lock.periodStart.getTime() && t < lock.periodEnd.getTime()) ?? null;
}
