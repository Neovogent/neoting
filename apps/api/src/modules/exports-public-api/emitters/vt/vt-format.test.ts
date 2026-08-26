import { expect, test } from 'vitest';

import { formatVtAmount, formatVtDate } from './vt-format.js';
import { VtEmitterError } from './vt-safety.js';

// The emitter boundary in the sense rule 1 means it: the one place pence stop
// being an integer. Everything above this is integers; everything below is a
// string. There is no float in between, which is what these tests pin.

test('pence become pounds with exactly two decimals', () => {
  expect(formatVtAmount(0)).toBe('0.00');
  expect(formatVtAmount(1)).toBe('0.01');
  expect(formatVtAmount(10)).toBe('0.10');
  expect(formatVtAmount(100)).toBe('1.00');
  expect(formatVtAmount(12345)).toBe('123.45');
  expect(formatVtAmount(100000000)).toBe('1000000.00');
});

test('the sign is dropped — VT derives debit and credit from Type', () => {
  expect(formatVtAmount(-12345)).toBe('123.45');
  expect(formatVtAmount(-1)).toBe('0.01');
});

test('the values floating-point division gets wrong come out right', () => {
  // 1665 / 100 is 16.650000000000002 in IEEE 754. Integer division and a
  // remainder are not approximately right, they are right.
  expect(formatVtAmount(1665)).toBe('16.65');
  expect(formatVtAmount(70007)).toBe('700.07');
  expect(formatVtAmount(8158)).toBe('81.58');
  expect(formatVtAmount(2029)).toBe('20.29');
});

test('a float reaching the boundary is a bug, and it throws rather than rounding quietly', () => {
  expect(() => formatVtAmount(12.5)).toThrow(VtEmitterError);
  expect(() => formatVtAmount(0.1 + 0.2)).toThrow(/integer pence/);
});

test('a calendar date becomes UK d/m/y with no Date object in between', () => {
  // Rule 8: `04/08/2026` is 4 August. Constructing a Date here is how it
  // becomes 3 August in a UTC container.
  expect(formatVtDate('2026-08-04')).toBe('04/08/2026');
  expect(formatVtDate('2026-01-01')).toBe('01/01/2026');
  expect(formatVtDate('2026-12-31')).toBe('31/12/2026');
});

test('a malformed date is refused, not guessed at', () => {
  expect(() => formatVtDate('04/08/2026')).toThrow(VtEmitterError);
  expect(() => formatVtDate('2026-8-4')).toThrow(VtEmitterError);
});
