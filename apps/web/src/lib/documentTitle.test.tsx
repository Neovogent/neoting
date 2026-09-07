import { expect, test } from 'vitest';

import { documentTitle, documentTitleClass } from './documentTitle';

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
