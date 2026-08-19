import { expect, test } from 'vitest';
import { listBusinessesResponse } from '@neoting/contracts/zod';

import { deriveBusinessSummaries } from './businesses';

/**
 * The businesses slice's synthetic half.
 *
 * The derived rows are what every consumer sees whenever the API is off or
 * has failed, so the two things pinned here are the counting rules and —
 * more importantly — that the derived shape still PARSES AS THE CONTRACT.
 * The whole point of the hydration architecture is that a screen reading the
 * slice cannot tell the worlds apart; a fallback row the contract schema
 * rejects would mean it could.
 */

const CLIENTS = [
  { id: '1', name: 'American Burger Ltd' },
  { id: '2', name: 'Glowout Salon' },
];

const DOCUMENTS = [
  { clientId: '1', status: 'review' },
  { clientId: '1', status: 'review' },
  { clientId: '1', status: 'ready' },
  { clientId: '1', status: 'rejected' },
  // Neither waiting nor failed — counted nowhere, like the contract's
  // aggregate, which groups only the three states the header badges.
  { clientId: '1', status: 'processing' },
  { clientId: '1', status: 'published' },
  // The other client's paperwork must not leak into the first one's counts.
  { clientId: '2', status: 'ready' },
];

test('counts follow the contract: toReview, ready, and rejected-as-failed, per client', () => {
  const rows = deriveBusinessSummaries(CLIENTS, DOCUMENTS);

  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    id: '1',
    name: 'American Burger Ltd',
    counts: { toReview: 2, ready: 1, failed: 1 },
  });
  expect(rows[1]).toMatchObject({ id: '2', counts: { toReview: 0, ready: 1, failed: 0 } });
});

test('a client with no documents still appears, with zero counts', () => {
  const rows = deriveBusinessSummaries([{ id: '9', name: 'Dormant Ltd' }], []);
  expect(rows).toEqual([{ id: '9', name: 'Dormant Ltd', tradingName: null, counts: { toReview: 0, ready: 0, failed: 0 } }]);
});

test('the synthetic shape parses as the contract — the fallback is indistinguishable on the wire', () => {
  const rows = deriveBusinessSummaries(CLIENTS, DOCUMENTS);
  const result = listBusinessesResponse.safeParse({
    data: rows,
    pageInfo: { nextCursor: null, hasMore: false },
  });
  expect(result.success, result.success ? '' : result.error.message).toBe(true);
});
