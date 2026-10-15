import { expect, test } from 'vitest';

import { snippetParts } from './practiceVault';

test('search snippets split on the server markers into text and hits, never HTML', () => {
  expect(snippetParts('paid «Bidfood» invoice for «food» <b>x</b>')).toEqual([
    { text: 'paid ', hit: false },
    { text: 'Bidfood', hit: true },
    { text: ' invoice for ', hit: false },
    { text: 'food', hit: true },
    { text: ' <b>x</b>', hit: false },
  ]);
  expect(snippetParts('no markers')).toEqual([{ text: 'no markers', hit: false }]);
  expect(snippetParts('')).toEqual([]);
});
