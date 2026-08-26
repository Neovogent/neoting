import { expect, test } from 'vitest';

import { serialiseCsv } from './csv.js';

// The serialiser is hand-written rather than installed (no new dependency in
// the export lane), so its edge cases are pinned rather than assumed. Every
// case here is one a real supplier name produces.

test('a plain field is written unquoted', () => {
  expect(serialiseCsv([['PIN', 'Acme Ltd']])).toBe('PIN,Acme Ltd\r\n');
});

test('a field containing a comma is quoted', () => {
  expect(serialiseCsv([['Dubois, S.à r.l.']])).toBe('"Dubois, S.à r.l."\r\n');
});

test('a double quote is doubled, and the field is quoted', () => {
  expect(serialiseCsv([['The "Blue" Café']])).toBe('"The ""Blue"" Café"\r\n');
});

test('a comma AND an accent together survive — the case that breaks hand-rolled writers', () => {
  const [line] = serialiseCsv([['Épicerie Dubois, S.à r.l.', '120.00']]).split('\r\n');
  expect(line).toBe('"Épicerie Dubois, S.à r.l.",120.00');
});

test('an embedded newline is quoted rather than splitting the row', () => {
  expect(serialiseCsv([['line one\nline two']])).toBe('"line one\nline two"\r\n');
});

test('rows are separated by CRLF, because the consumer is a Windows desktop app', () => {
  expect(serialiseCsv([['a'], ['b']])).toBe('a\r\nb\r\n');
});

test('an empty field stays empty, and an empty file stays empty', () => {
  expect(serialiseCsv([['PIN', '', '04/08/2026']])).toBe('PIN,,04/08/2026\r\n');
  expect(serialiseCsv([])).toBe('');
});
