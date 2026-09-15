import { describe, expect, it } from 'vitest';

import {
  LedgerMoneyError,
  penceFromDecimalString,
  penceFromWire,
  penceToDecimalString,
  penceToWireNumber,
} from './ledger-money.js';

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
