import { expect, test } from 'vitest';

import { advanceDueDate, isoDateFromUtc, utcMidnight } from './due-date.js';

/**
 * The two bugs this file exists to prevent, both of which produce a date that
 * is silently one out — the worst kind, because "1 March" and "28 February"
 * both look like a plausible answer on a screen.
 */

test('a due date survives the round trip on the same calendar day', () => {
  // The one that bites west of Greenwich: `new Date('2026-03-01').getDate()` is
  // 28 on a US-Eastern box. Reading UTC components at both ends is the fix.
  for (const iso of ['2026-01-01', '2026-03-01', '2026-12-31', '2026-02-28']) {
    expect(isoDateFromUtc(utcMidnight(iso))).toBe(iso);
  }
});

test('monthly and quarterly advance by one and three months', () => {
  expect(isoDateFromUtc(advanceDueDate(utcMidnight('2026-01-15'), 'monthly'))).toBe('2026-02-15');
  expect(isoDateFromUtc(advanceDueDate(utcMidnight('2026-01-15'), 'quarterly'))).toBe('2026-04-15');
  // Year rollover, both cadences.
  expect(isoDateFromUtc(advanceDueDate(utcMidnight('2026-12-10'), 'monthly'))).toBe('2027-01-10');
  expect(isoDateFromUtc(advanceDueDate(utcMidnight('2026-11-10'), 'quarterly'))).toBe('2027-02-10');
});

test('⚠ month-end CLAMPS instead of overflowing into the next month', () => {
  // `Date.UTC(2026, 1, 31)` is 3 March. Without the clamp a task due the 31st
  // lands on the 3rd, then the 3rd of every month after — the whole series
  // drifts off month-end after one cycle, which for an accounting deadline is
  // the one thing it must not do.
  expect(isoDateFromUtc(advanceDueDate(utcMidnight('2026-01-31'), 'monthly'))).toBe('2026-02-28');
  expect(isoDateFromUtc(advanceDueDate(utcMidnight('2026-03-31'), 'monthly'))).toBe('2026-04-30');
  // A leap year still gets its 29th.
  expect(isoDateFromUtc(advanceDueDate(utcMidnight('2028-01-31'), 'monthly'))).toBe('2028-02-29');
  // And a clamped date does not drag the series short: the next roll is from
  // the stored 28th, so the answer is the 28th and not month-end again. Stated
  // because it is the behaviour, not an accident — a series that re-expands to
  // month-end would need the ORIGINAL day carried, which is a column.
  expect(isoDateFromUtc(advanceDueDate(utcMidnight('2026-02-28'), 'monthly'))).toBe('2026-03-28');
});

test('an unrecognised cadence advances by a month rather than throwing', () => {
  // `tasks.cadence` is a free `String?` column that predates this feature, so a
  // value from outside the enum can exist. A checklist item that comes round a
  // month later is a wrong-ish answer; a 500 on the tick is a broken button.
  expect(isoDateFromUtc(advanceDueDate(utcMidnight('2026-01-15'), 'fortnightly'))).toBe('2026-02-15');
});
