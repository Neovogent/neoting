import { expect, test } from 'vitest';

import { documentDate, documentTitle, documentTitleClass, documentTotal } from './documentTitle';

test('an extracted party is the title, and is not a fallback', () => {
  const t = documentTitle({ supplier: 'Bidfood (UK) Ltd', displayTitle: 'Bidfood (UK) Ltd' });
  expect(t).toEqual({ text: 'Bidfood (UK) Ltd', isFallback: false });
  expect(documentTitleClass(t.isFallback)).toContain('text-white');
});

test('an unread document falls back to the file name AND says so', () => {
  // 7 Sep 2026: the blurred photo listed as supplier "5b-blurred-restaurant",
  // styled exactly like the real party on the row above it.
  const t = documentTitle({ supplier: 'Unknown', displayTitle: '5b-blurred-restaurant' });
  expect(t).toEqual({ text: '5b-blurred-restaurant', isFallback: true });
  expect(documentTitleClass(t.isFallback)).not.toContain('text-white');
});

test('no display title at all falls through to the sentinel', () => {
  expect(documentTitle({ supplier: 'Unknown', displayTitle: undefined })).toEqual({
    text: 'Unknown',
    isFallback: true,
  });
});

test('a total nobody could read is a dash, never £0.00', () => {
  // 8 Sep 2026: a handwritten receipt the extractor honestly refused
  // (`Total —`, 10% confident) was listed on the board as £0.00 — the board
  // asserting a figure the document's own detail said it did not have.
  expect(documentTotal({ total: 0, totalKnown: false, currency: 'GBP' })).toBeNull();
});

test('a genuine zero still prints as money', () => {
  // The predicate is whether the SERVER sent a total, not whether it is falsy.
  expect(documentTotal({ total: 0, totalKnown: true, currency: 'GBP' })).toBe('£0.00');
});

test('a synthetic row, which always carries a real number, is unaffected', () => {
  expect(documentTotal({ total: 217.5, totalKnown: undefined, currency: 'GBP' })).toBe('£217.50');
});

test('a date nobody has read is a dash, never today', () => {
  // 8 Sep 2026, found live: a document still in Processing printed TODAY in the
  // DATE column, because `toLocalDocument` falls back to `receivedAt` so every
  // list has something to sort by. Beside dates read off paper, an arrival date
  // is a fact about our server presented as a fact about the document.
  expect(documentDate({ date: '08 Sep 2026', dateKnown: false })).toBeNull();
});

test('a date the server did send is printed as it came', () => {
  expect(documentDate({ date: '03 Aug 2026', dateKnown: true })).toBe('03 Aug 2026');
});

test('a synthetic row, which always carries a real date, is unaffected', () => {
  expect(documentDate({ date: '20 Aug 2026', dateKnown: undefined })).toBe('20 Aug 2026');
});
