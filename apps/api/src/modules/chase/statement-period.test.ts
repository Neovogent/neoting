import { expect, test } from 'vitest';

import { isStatementPeriod, periodWindow, statementItemRef, statementPeriodOf } from './statement-request.js';
import { formatPeriod } from './sms-copy.js';

/**
 * The statement period, both shapes (review item 16 — the owner chose "start
 * and end date" on 8 Sep 2026).
 *
 * The month shape is not legacy and is not going anywhere: every chase raised
 * before that date carries one, the detection engine raises one for a period
 * gap, and it is what a client says out loud. These tests hold both.
 */

test('a whole month is still a period, and still a month-long window', () => {
  expect(isStatementPeriod('2026-08')).toBe(true);
  expect(periodWindow('2026-08')).toEqual({
    start: new Date('2026-08-01T00:00:00.000Z'),
    end: new Date('2026-09-01T00:00:00.000Z'),
  });
});

test('a range is inclusive at BOTH ends — the day named is in the period', () => {
  expect(isStatementPeriod('2026-08-01..2026-08-15')).toBe(true);
  // 15 August was asked for, so the half-open window has to reach the 16th.
  expect(periodWindow('2026-08-01..2026-08-15')).toEqual({
    start: new Date('2026-08-01T00:00:00.000Z'),
    end: new Date('2026-08-16T00:00:00.000Z'),
  });
});

test('a single day is a range of one, and does not collapse to nothing', () => {
  const { start, end } = periodWindow('2026-08-07..2026-08-07');
  expect(start).toEqual(new Date('2026-08-07T00:00:00.000Z'));
  expect(end).toEqual(new Date('2026-08-08T00:00:00.000Z'));
  expect(end.getTime()).toBeGreaterThan(start.getTime());
});

test('a range crossing a month and a year end still spans correctly', () => {
  expect(periodWindow('2025-12-30..2026-01-05')).toEqual({
    start: new Date('2025-12-30T00:00:00.000Z'),
    end: new Date('2026-01-06T00:00:00.000Z'),
  });
});

test('a backwards range is a typo, not a period', () => {
  expect(isStatementPeriod('2026-08-15..2026-08-01')).toBe(false);
  expect(statementPeriodOf([statementItemRef('2026-08-15..2026-08-01')])).toBeNull();
});

test('nonsense is refused rather than guessed at', () => {
  for (const bad of ['2026-13', '2026-08-32..2026-08-31', '2026-08-01..', '..2026-08-31', 'august', '']) {
    expect(isStatementPeriod(bad)).toBe(false);
  }
});

test('an itemRefs tag round-trips for both shapes', () => {
  expect(statementPeriodOf([statementItemRef('2026-08')])).toBe('2026-08');
  expect(statementPeriodOf([statementItemRef('2026-08-01..2026-08-15')])).toBe('2026-08-01..2026-08-15');
  expect(statementPeriodOf(['txn_1', 'txn_2'])).toBeNull();
});

/**
 * The words a client reads on a phone. Every repeated month or year is one
 * more thing to read past to find the two numbers that actually differ, so the
 * shared parts collapse.
 */
test('the period reads the way a person would say it', () => {
  expect(formatPeriod('2026-07')).toBe('July 2026');
  expect(formatPeriod('2026-08-01..2026-08-15')).toBe('1 to 15 August 2026');
  expect(formatPeriod('2026-07-26..2026-08-03')).toBe('26 July to 3 August 2026');
  expect(formatPeriod('2025-12-30..2026-01-05')).toBe('30 December 2025 to 5 January 2026');
  expect(formatPeriod('2026-08-07..2026-08-07')).toBe('7 August 2026');
});

test('an unparseable period is echoed, never rendered as a plausible wrong date', () => {
  // A client reading an ISO string knows something is off. A client reading a
  // confident wrong date does not.
  expect(formatPeriod('2026-99-01..2026-99-02')).toBe('2026-99-01 to 2026-99-02');
});
