import { expect, test } from 'vitest';

import { foldCounts } from './businesses.service.js';

/**
 * The counts fold, offline. The integration suite proves the whole read
 * against real RLS; this pins the fold's own rules on machines with no
 * database configured — the contract's grouping is exactly three buckets,
 * and getting it wrong renders as a badge quietly lying on every screen.
 */

const row = (businessId: string | null, state: string, count: number) =>
  ({ businessId, state, _count: { _all: count } }) as Parameters<typeof foldCounts>[0][number];

test('REJECTED and FAILED fold into one `failed` — the contract says together', () => {
  const counts = foldCounts([row('b1', 'REJECTED', 2), row('b1', 'FAILED', 3)]);
  expect(counts.get('b1')).toEqual({ toReview: 0, ready: 0, failed: 5 });
});

test('each counted state lands in its own bucket, per business', () => {
  const counts = foldCounts([
    row('b1', 'TO_REVIEW', 4),
    row('b1', 'READY', 1),
    row('b2', 'READY', 7),
  ]);
  expect(counts.get('b1')).toEqual({ toReview: 4, ready: 1, failed: 0 });
  expect(counts.get('b2')).toEqual({ toReview: 0, ready: 7, failed: 0 });
});

test('an unrouted group (null businessId) is counted nowhere', () => {
  expect(foldCounts([row(null, 'TO_REVIEW', 9)]).size).toBe(0);
});

test('a state outside the three buckets never leaks into a badge', () => {
  // The where-clause already excludes these; the fold not trusting that is
  // what keeps a widened query from silently inflating `toReview`.
  expect(foldCounts([row('b1', 'RECEIVED', 5), row('b1', 'ARCHIVED', 5)]).size).toBe(0);
});
