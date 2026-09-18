import { describe, expect, it, test } from 'vitest';

import {
  LedgerMoneyError,
  penceFromDecimalString,
  penceFromWire,
  penceToDecimalString,
  penceToWireNumber,
} from './ledger-money.js';
import { documentRateBasisPoints, matchTaxRate } from './reference-sync.js';

describe('outbound — pence to the wire', () => {
  it('writes two decimal places, always', () => {
    expect(penceToDecimalString(1234)).toBe('12.34');
    expect(penceToDecimalString(100)).toBe('1.00');
    expect(penceToDecimalString(5)).toBe('0.05');
    expect(penceToDecimalString(0)).toBe('0.00');
  });

  it('keeps the sign — a credit note is negative', () => {
    expect(penceToDecimalString(-1234)).toBe('-12.34');
    expect(penceToWireNumber(-1234)).toBe(-12.34);
  });

  it('refuses a float before it can reach a vendor', () => {
    expect(() => penceToDecimalString(12.34)).toThrow(LedgerMoneyError);
  });

  it('does not lose the pounds on a large amount', () => {
    // 1999999999p = £19,999,999.99. Division would have been fine here; the
    // point is that nothing in the path ever divides.
    expect(penceToDecimalString(1_999_999_999)).toBe('19999999.99');
  });
});

describe('inbound — the wire to pence', () => {
  it('reads a JSON number exactly, including the ones doubles get wrong', () => {
    // 0.1 + 0.2 territory: every one of these has a double representation that
    // is NOT the decimal, and multiplying by 100 shows it.
    expect(penceFromWire(12.34, 'total')).toBe(1234);
    expect(penceFromWire(0.1, 'total')).toBe(10);
    expect(penceFromWire(0.29, 'total')).toBe(29);
    expect(penceFromWire(8.61, 'total')).toBe(861);
    expect(penceFromWire(-12.34, 'total')).toBe(-1234);
  });

  it('reads a decimal string as text and never as a double', () => {
    expect(penceFromDecimalString('100.0', 'total')).toBe(10_000);
    expect(penceFromDecimalString('12.34', 'total')).toBe(1234);
    expect(penceFromDecimalString('0.1', 'total')).toBe(10);
    expect(penceFromDecimalString('-9', 'total')).toBe(-900);
    expect(penceFromDecimalString('100.000', 'total')).toBe(10_000);
  });

  it('accepts either shape, because Sage sends both', () => {
    expect(penceFromWire('12.34', 'total')).toBe(1234);
    expect(penceFromWire(12.34, 'total')).toBe(1234);
  });

  it('refuses something finer than a penny rather than rounding it into the books', () => {
    expect(() => penceFromDecimalString('12.345', 'unit price')).toThrow(/finer than a penny/);
    expect(() => penceFromWire(12.3456, 'unit price')).toThrow(/not a whole number of pence/);
    // Three decimal places is not a rounding question, it is a wrong field.
    expect(() => penceFromWire(1.005, 'unit price')).toThrow(/not a whole number of pence/);
  });

  it('refuses a missing amount, a thousands separator and anything that is not a number', () => {
    expect(() => penceFromWire(null, 'total')).toThrow(/rather than an amount/);
    expect(() => penceFromWire(undefined, 'total')).toThrow(/rather than an amount/);
    expect(() => penceFromDecimalString('1,234.56', 'total')).toThrow(/not a plain decimal amount/);
    expect(() => penceFromWire(Number.NaN, 'total')).toThrow(LedgerMoneyError);
  });

  it('round-trips every penny value from 0 to 10000 through the number path', () => {
    for (let pence = 0; pence <= 10_000; pence += 1) {
      expect(penceFromWire(penceToWireNumber(pence), 'total')).toBe(pence);
    }
  });
});

/**
 * ⚠ The VAT rate a document actually carries, and the code chosen for it.
 *
 * The first real post to QuickBooks was refused — "All items need a tax rate" —
 * because the line named no code at all. What replaced it must derive the rate
 * from the paper rather than assume the standard one: most of a UK food
 * wholesaler's delivery is zero-rated, and a plausible 20% written into a
 * client's books is the hardest kind of wrong to notice afterwards.
 */
describe('tax rate derivation', () => {
  test('derives the rate from gross and tax, in integers', () => {
    // £482.40 gross carrying £80.40 VAT is £402.00 net at 20%.
    expect(documentRateBasisPoints(48_240, 8_040)).toBe(2000);
    // A zero-rated delivery.
    expect(documentRateBasisPoints(21_750, 0)).toBe(0);
    // 5% reduced rate: £105.00 gross, £5.00 VAT on £100.00 net.
    expect(documentRateBasisPoints(10_500, 500)).toBe(500);
  });

  test('a zero or negative net is zero-rated, never a division nobody can defend', () => {
    expect(documentRateBasisPoints(0, 0)).toBe(0);
    expect(documentRateBasisPoints(500, 500)).toBe(0);
    expect(documentRateBasisPoints(-150, 0)).toBe(0);
  });

  const codes = [
    { id: '4', code: '4', name: '20.0% S', rateBasisPoints: 2000, active: true },
    { id: '5', code: '5', name: '0.0% Z', rateBasisPoints: 0, active: true },
    { id: '9', code: '9', name: 'Exempt', rateBasisPoints: 0, active: false },
    { id: '7', code: '7', name: 'Unreadable', rateBasisPoints: null, active: true },
  ];

  test('matches a code by rate, and never one whose rate could not be read', () => {
    expect(matchTaxRate(codes, 2000)?.id).toBe('4');
    expect(matchTaxRate(codes, 0)?.id).toBe('5');
    // ⚠ The inactive Exempt code is not selected even though its rate matches.
    expect(matchTaxRate(codes.filter((c) => c.id !== '5'), 0)).toBeNull();
  });

  test('a rate the client has no code for REFUSES rather than falling back', () => {
    // 17.5% — a real historic UK rate, and not on this chart.
    expect(matchTaxRate(codes, 1750)).toBeNull();
  });

  test('absorbs rounding, but 17.5% is never 20%', () => {
    expect(matchTaxRate(codes, 2001)?.id).toBe('4');
    expect(matchTaxRate(codes, 1999)?.id).toBe('4');
    expect(matchTaxRate(codes, 1900)).toBeNull();
  });
});
