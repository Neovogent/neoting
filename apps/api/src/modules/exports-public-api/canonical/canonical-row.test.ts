import { describe, expect, test } from 'vitest';

import {
  CalendarDateSchema,
  CanonicalRowSchema,
  CanonicalSourceLinkSchema,
  type CanonicalTransactionDocument,
} from './canonical-row.js';

function invoice(
  overrides: Partial<CanonicalTransactionDocument> = {},
): CanonicalTransactionDocument {
  return {
    family: 'TRANSACTION_DOCUMENT',
    documentId: 'doc_1',
    businessId: 'biz_1',
    sourceLink: null,
    party: 'SUPPLIER',
    instrument: 'INVOICE',
    date: '2026-08-04',
    primaryAccount: 'Acme Ltd',
    reference: 'INV-1',
    grossPence: 12000,
    vatPence: 2000,
    netPence: 10000,
    analysis: [{ analysisAccount: 'Cost of sales: Purchases', netPence: 10000, vatPence: 2000 }],
    ...overrides,
  };
}

describe('money', () => {
  test('a well-formed document parses', () => {
    expect(CanonicalRowSchema.safeParse(invoice()).success).toBe(true);
  });

  test('gross that is not net + VAT is refused', () => {
    const result = CanonicalRowSchema.safeParse(invoice({ grossPence: 11999 }));
    expect(result.success).toBe(false);
  });

  test('analysis lines that do not sum to the document are refused', () => {
    const result = CanonicalRowSchema.safeParse(
      invoice({
        analysis: [{ analysisAccount: 'Cost of sales: Purchases', netPence: 9999, vatPence: 2000 }],
      }),
    );
    expect(result.success).toBe(false);
  });

  test('a float in a pence field is refused — money is integer pence (R5)', () => {
    // Computed rather than written as a literal, because the R5 lint rule
    // refuses a float literal in a `*Pence` slot — including in the test that
    // exists to prove the schema refuses one too. Two gates, same rule.
    const notAnInteger = 12050 / 8;
    const result = CanonicalRowSchema.safeParse(invoice({ grossPence: notAnInteger }));
    expect(result.success).toBe(false);
  });

  test('mixed signs are a parsing accident, not a transaction', () => {
    const result = CanonicalRowSchema.safeParse(
      invoice({
        grossPence: 8000,
        netPence: 10000,
        vatPence: -2000,
        analysis: [{ analysisAccount: 'Cost of sales: Purchases', netPence: 10000, vatPence: -2000 }],
      }),
    );
    expect(result.success).toBe(false);
  });

  test('a credit note is negative throughout, and that parses', () => {
    const result = CanonicalRowSchema.safeParse(
      invoice({
        instrument: 'CREDIT_NOTE',
        grossPence: -12000,
        netPence: -10000,
        vatPence: -2000,
        analysis: [
          { analysisAccount: 'Cost of sales: Purchases', netPence: -10000, vatPence: -2000 },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  test('a zero-VAT document parses — a zero is not a mixed sign', () => {
    const result = CanonicalRowSchema.safeParse(
      invoice({
        grossPence: 10000,
        netPence: 10000,
        vatPence: 0,
        analysis: [{ analysisAccount: 'Cost of sales: Purchases', netPence: 10000, vatPence: 0 }],
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe('calendar dates', () => {
  test('accepts a real date in transport order', () => {
    expect(CalendarDateSchema.safeParse('2026-08-04').success).toBe(true);
    expect(CalendarDateSchema.safeParse('2024-02-29').success).toBe(true); // leap year
  });

  test('refuses what is not a date, including a UK-rendered one', () => {
    for (const value of ['04/08/2026', '2026-13-01', '2026-02-30', '2023-02-29', '2026-8-4', '']) {
      expect(CalendarDateSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('the A8 seam — the source link', () => {
  test('a code with a letter is accepted', () => {
    expect(
      CanonicalSourceLinkSchema.safeParse({ code: 'A7K2M9', url: 'https://x.test/d/A7K2M9' })
        .success,
    ).toBe(true);
  });

  test('an all-digit code is refused here as well as at the emitter', () => {
    // VT coerces numeric-looking strings in Entry details into 2-decimal
    // numbers. Two locks on the same door, because the failure is silent and
    // lands in the accountant's software rather than ours.
    expect(
      CanonicalSourceLinkSchema.safeParse({ code: '123456', url: 'https://x.test/d/123456' })
        .success,
    ).toBe(false);
  });

  test('a code over 20 characters is refused — reference fields truncate silently', () => {
    expect(
      CanonicalSourceLinkSchema.safeParse({ code: `A${'1'.repeat(20)}`, url: 'https://x.test/' })
        .success,
    ).toBe(false);
  });

  test('a document may carry no link yet — A8 has not merged', () => {
    expect(CanonicalRowSchema.safeParse(invoice({ sourceLink: null })).success).toBe(true);
  });
});

describe('the two record families', () => {
  test('a bank statement line parses on its own shape', () => {
    const result = CanonicalRowSchema.safeParse({
      family: 'BANK_STATEMENT_LINE',
      documentId: 'doc_2',
      businessId: 'biz_1',
      sourceLink: null,
      movement: 'PAYMENT',
      instrument: 'CHEQUE',
      date: '2026-08-05',
      bankAccount: 'Current account',
      contraAccount: 'Expenses: Motor expenses',
      description: 'Cheque 000123',
      grossPence: 5000,
      vatPence: 0,
      netPence: 5000,
    });
    expect(result.success).toBe(true);
  });

  test('a received cheque is refused — a cheque is a payment', () => {
    const result = CanonicalRowSchema.safeParse({
      family: 'BANK_STATEMENT_LINE',
      documentId: 'doc_3',
      businessId: 'biz_1',
      sourceLink: null,
      movement: 'RECEIPT',
      instrument: 'CHEQUE',
      date: '2026-08-05',
      bankAccount: 'Current account',
      contraAccount: 'Income: Sales',
      description: 'Cheque in',
      grossPence: 5000,
      vatPence: 0,
      netPence: 5000,
    });
    expect(result.success).toBe(false);
  });

  test('a document with no analysis line at all is refused', () => {
    expect(CanonicalRowSchema.safeParse(invoice({ analysis: [] })).success).toBe(false);
  });
});
