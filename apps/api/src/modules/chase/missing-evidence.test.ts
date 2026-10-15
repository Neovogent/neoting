import { expect, test } from 'vitest';

import { detectRecurringGaps } from './missing-evidence.js';
import { DEFAULT_CLIENT_SUPPRESSION_KEYWORDS, isSuppressedForClient, supplierKey } from './suppression.js';

const doc = (supplierName: string, iso: string, id = iso) => ({ documentId: id, supplierName, documentDate: new Date(iso) });

test('engine (e): a monthly supplier that misses a month is flagged once, after the grace period', () => {
  const docs = [doc('British Gas', '2026-06-03'), doc('BRITISH GAS 4411', '2026-07-02'), doc('British Gas', '2026-08-04')];
  // September is not over (plus 10 days) yet on 5 Oct — nothing.
  expect(detectRecurringGaps(docs, new Date('2026-10-05T00:00:00Z'))).toEqual([]);
  // On 15 Oct September is late.
  expect(detectRecurringGaps(docs, new Date('2026-10-15T00:00:00Z'))).toEqual([
    { supplierKey: 'british gas', supplierName: 'British Gas', period: '2026-09', cadence: 'monthly' },
  ]);
  // A year later the relationship has ended — stop asking.
  expect(detectRecurringGaps(docs, new Date('2027-08-15T00:00:00Z'))).toEqual([]);
});

test('engine (e): quarterly cadence, and no cadence from irregular history', () => {
  const quarterly = [doc('Water Co', '2026-01-10'), doc('Water Co', '2026-04-10'), doc('Water Co', '2026-07-10')];
  expect(detectRecurringGaps(quarterly, new Date('2026-11-15T00:00:00Z'))[0]).toMatchObject({ period: '2026-10', cadence: 'quarterly' });
  const irregular = [doc('Currys', '2026-01-10'), doc('Currys', '2026-02-10'), doc('Currys', '2026-06-10')];
  expect(detectRecurringGaps(irregular, new Date('2026-11-15T00:00:00Z'))).toEqual([]);
});

test('per-client suppression: keywords, learned suppliers and the default list', () => {
  expect(supplierKey('CURRYS PC WORLD 1234')).toBe('currys pc world');
  const s = { keywords: DEFAULT_CLIENT_SUPPRESSION_KEYWORDS, noReceiptSuppliers: ['costa'], isDefault: true };
  expect(isSuppressedForClient(s, { descriptionRaw: 'TRANSFER TO SAVINGS' })).toBe(true);
  expect(isSuppressedForClient(s, { descriptionRaw: 'CARD COSTA 5531', supplierLabel: null })).toBe(true);
  expect(isSuppressedForClient(s, { descriptionRaw: 'CURRYS 1234', supplierLabel: 'Currys' })).toBe(false);
  // Whole-word containment: "costa" never suppresses "costain".
  expect(isSuppressedForClient(s, { supplierLabel: 'Costain Ltd' })).toBe(false);
});
