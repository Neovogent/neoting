import { describe, expect, test } from 'vitest';
import { currency } from './resolver';

/**
 * Money on screen — `currency()`, which lives in **`resolver.ts`**, which is
 * why this file is named after it. It was `currency.test.ts`, beside a
 * `currency.ts` that does not exist, so the only way to find the function was
 * to open the test and read its import.
 *
 * This exists because of a real misstatement on the live inbox: a USD invoice
 * for 54,352.51 rendered as **£54,352.51**. `currency()` printed a pound sign
 * for every one of its ~99 call sites, and the amber "USD" pill beside the
 * figure was the only hint — a pill does not undo a wrong symbol on the number
 * an accountant is reading. What is pinned here is the fix and, just as
 * importantly, that the fix changed nothing for sterling.
 *
 * ## ⚠ Zero-decimal currencies are a KNOWN GAP, and are deliberately not pinned
 *
 * `currency()` always prints two decimal places, so a JPY figure comes out as
 * `JPY 1,234.00` — which is wrong as accounting, because the yen has no minor
 * unit. This file used to assert that string, which enshrined the error as the
 * intended answer; the case is gone rather than inverted, because **the display
 * helper is the wrong place to fix it.** The amount reaching it has already been
 * divided by 100 at the pence→pounds boundary (`api/documents.ts`), and for a
 * zero-decimal currency that division is itself the bug: 1,234 yen of minor
 * units arrives here as 12.34. Rendering `¥12` would be a confident wrong
 * answer where `JPY 1,234.00` is at least visibly odd.
 *
 * Closing it properly means teaching the whole money boundary the ISO 4217
 * exponent — the API's `formatGbp`, the pence→pounds conversions, and this
 * helper — and it is reported rather than half-done here. Nothing in the
 * product mints a zero-decimal figure today: `Business.baseCurrency` defaults
 * to GBP, and only an extracted supplier invoice could carry one.
 */

describe('currency()', () => {
  test('defaults to sterling, so every existing call site is unchanged', () => {
    expect(currency(1234.5)).toBe('£1,234.50');
    expect(currency(0)).toBe('£0.00');
    expect(currency(54352.51, 'GBP')).toBe('£54,352.51');
  });

  test('prints the document’s own symbol — the reported bug', () => {
    expect(currency(54352.51, 'USD')).toBe('$54,352.51');
    expect(currency(99.99, 'EUR')).toBe('€99.99');
  });

  test('a currency we cannot name is shown by its ISO code, never a borrowed symbol', () => {
    // Guessing "$" for AUD/CAD/SGD would be the same class of error as the £
    // this replaced, so an unknown code is stated rather than decorated.
    // Both examples are two-decimal currencies on purpose — see the
    // zero-decimal note in this file's header for why JPY is not one of them.
    expect(currency(1234, 'AUD')).toBe('AUD 1,234.00');
    expect(currency(99.5, 'CHF')).toBe('CHF 99.50');
  });

  test('negatives keep the true minus sign, ahead of the symbol', () => {
    // U+2212, not a hyphen — and the sign leads, so "−$12.00" reads as money
    // out rather than as a currency called "-$".
    expect(currency(-12, 'USD')).toBe('−$12.00');
    expect(currency(-2841.55)).toBe('−£2,841.55');
  });

  test('always two decimal places, grouped — the figures line up in a column', () => {
    expect(currency(7)).toBe('£7.00');
    expect(currency(1000000)).toBe('£1,000,000.00');
    // Rounds to the penny rather than showing a third digit.
    expect(currency(1.005)).toBe('£1.01');
  });
});
