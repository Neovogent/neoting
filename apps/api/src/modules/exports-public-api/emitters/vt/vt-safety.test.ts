import { describe, expect, test } from 'vitest';

import {
  assertVtEntryDetailsSafe,
  breakLongNumericTokens,
  containsLongNumericToken,
  MAX_VT_NUMERIC_TOKEN_DIGITS,
  VtEmitterError,
} from './vt-safety.js';

/**
 * The two landmines, tested at the unit. The same two are tested again through
 * the whole emitter in `vt-transaction-plus-emitter.test.ts`, because a guard
 * that exists and is not called is indistinguishable from no guard at all.
 */

describe('LANDMINE 1 — VT builds before May 2025 crash on a numeric token over 16 digits', () => {
  test('16 digits is the boundary and is allowed; 17 is not', () => {
    expect(MAX_VT_NUMERIC_TOKEN_DIGITS).toBe(16);
    expect(containsLongNumericToken('1'.repeat(16))).toBe(false);
    expect(containsLongNumericToken('1'.repeat(17))).toBe(true);
  });

  test('a long run is broken into 16-digit groups, losing no digit', () => {
    const reference = '9'.repeat(25);
    const guarded = breakLongNumericTokens(reference);

    expect(guarded.changed).toBe(true);
    expect(containsLongNumericToken(guarded.value)).toBe(false);
    // Every digit survives — the repair is a separator, never a truncation.
    expect(guarded.value.replaceAll(' ', '')).toBe(reference);
    expect(guarded.value).toBe(`${'9'.repeat(16)} ${'9'.repeat(9)}`);
  });

  test('digits inside a URL are guarded too — VT does not care that it was a link', () => {
    const note = `https://example.test/d/${'7'.repeat(20)}`;
    const guarded = breakLongNumericTokens(note);

    expect(guarded.changed).toBe(true);
    expect(containsLongNumericToken(guarded.value)).toBe(false);
  });

  test('digits separated by anything at all are separate tokens', () => {
    // A date, an amount and a reference on one line are three tokens, not one
    // 20-digit run — the guard must not repair something that was never broken.
    const safe = '04/08/2026 1234.56 INV-0009988';
    expect(containsLongNumericToken(safe)).toBe(false);
    expect(breakLongNumericTokens(safe).changed).toBe(false);
  });

  test('ordinary text is returned unchanged and unreported', () => {
    const guarded = breakLongNumericTokens('Café Noir Ltd, Invoice 10023');
    expect(guarded).toStrictEqual({ value: 'Café Noir Ltd, Invoice 10023', changed: false });
  });
});

describe('LANDMINE 2 — VT coerces numeric-looking strings in Entry details into 2dp numbers', () => {
  test('a code with a letter passes through byte-for-byte', () => {
    expect(assertVtEntryDetailsSafe('A7K2M9')).toBe('A7K2M9');
    expect(assertVtEntryDetailsSafe('7K2M9Z')).toBe('7K2M9Z');
  });

  test('an all-digit code throws rather than becoming 123456.00 inside VT', () => {
    expect(() => assertVtEntryDetailsSafe('123456')).toThrow(VtEmitterError);
    expect(() => assertVtEntryDetailsSafe('123456')).toThrow(/must contain a letter/);
  });

  test('digits with punctuation but no letter is still numeric-looking, and still throws', () => {
    // The failure mode is VT deciding the cell is a number. `-12.50` and
    // `1,234` are exactly the shapes it decides that about.
    expect(() => assertVtEntryDetailsSafe('-12.50')).toThrow(VtEmitterError);
    expect(() => assertVtEntryDetailsSafe('1,234')).toThrow(VtEmitterError);
    expect(() => assertVtEntryDetailsSafe('000-999')).toThrow(VtEmitterError);
  });

  test('an empty cell is allowed — there is nothing there to coerce', () => {
    expect(assertVtEntryDetailsSafe('')).toBe('');
  });
});
