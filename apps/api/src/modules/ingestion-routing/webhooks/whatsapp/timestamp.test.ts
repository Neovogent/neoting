import { expect, test } from 'vitest';

import { withinTolerance } from './timestamp.js';

const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;

test('accepts a fresh timestamp', () => {
  expect(withinTolerance(NOW_S, NOW_MS)).toBe(true);
  expect(withinTolerance(NOW_S - 60, NOW_MS)).toBe(true); // 1 minute ago
});

test('rejects a timestamp older than the 5-minute window', () => {
  expect(withinTolerance(NOW_S - 6 * 60, NOW_MS)).toBe(false);
});

test('rejects a future timestamp beyond tolerance', () => {
  expect(withinTolerance(NOW_S + 6 * 60, NOW_MS)).toBe(false);
});

test('rejects a non-finite timestamp', () => {
  expect(withinTolerance(Number.NaN, NOW_MS)).toBe(false);
});
