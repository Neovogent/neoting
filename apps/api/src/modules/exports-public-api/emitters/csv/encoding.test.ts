import { expect, test } from 'vitest';

import { CSV_ENCODING, encodeCsv } from './encoding.js';

// A10 settles the encoding against a real VT on a real Windows machine. These
// tests do not pretend to know the answer; they prove all three branches work,
// so changing `CSV_ENCODING` is a one-line change with a green suite behind it.

test('the module has exactly one encoding decision, and it is this constant', () => {
  // If this fails, A10 has changed it — which is the intended workflow, not a
  // regression. Update the expectation and the file header table together.
  expect(CSV_ENCODING).toBe('utf-8-with-bom');
});

test('the default writes a UTF-8 BOM, then UTF-8', () => {
  const bytes = encodeCsv('Café');
  expect([...bytes.subarray(0, 3)]).toStrictEqual([0xef, 0xbb, 0xbf]);
  expect(bytes.subarray(3).toString('utf8')).toBe('Café');
});

test('plain utf-8 writes no BOM', () => {
  expect(encodeCsv('Café', 'utf-8').toString('utf8')).toBe('Café');
  expect(encodeCsv('Café', 'utf-8')[0]).not.toBe(0xef);
});

test('windows-1252 writes one byte per accented character, not two', () => {
  // The failure this branch exists for: a legacy reader shows `CafÃ©` because
  // it read two UTF-8 bytes as two ANSI characters.
  const bytes = encodeCsv('Café', 'windows-1252');
  expect(bytes).toHaveLength(4);
  expect(bytes[3]).toBe(0xe9); // é
});

test('windows-1252 covers the 0x80–0x9F block Latin-1 does not', () => {
  // A supplier name pasted out of Word contains exactly these.
  expect([...encodeCsv('€', 'windows-1252')]).toStrictEqual([0x80]);
  expect([...encodeCsv('’', 'windows-1252')]).toStrictEqual([0x92]); // right single quote
  expect([...encodeCsv('–', 'windows-1252')]).toStrictEqual([0x96]); // en dash
});

test('a character windows-1252 cannot hold becomes a visible ?, never a silent drop', () => {
  // A dropped character makes a supplier name that no longer matches its saved
  // VT Converter mapping. A `?` is the only version of that an accountant sees.
  expect(encodeCsv('日本', 'windows-1252').toString('latin1')).toBe('??');
});
