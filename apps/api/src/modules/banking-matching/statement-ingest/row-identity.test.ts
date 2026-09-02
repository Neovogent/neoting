import { describe, expect, test } from 'vitest';

import { identityGroupKey, importFingerprint, importFingerprintsFor, normaliseDescription } from './row-identity.js';
import type { ParsedRow } from './statement-parser.js';

/**
 * The identity that stops a re-uploaded statement doubling a client's ledger —
 * and, in the same breath, does NOT stop a business buying the same coffee
 * twice.
 *
 * Those two are the whole test. A defence that collapsed identical-looking rows
 * would delete a real payment out of an accounting ledger, which is a worse
 * failure than showing two; a defence that kept everything is what put 2,288
 * rows in front of a client who had made 1,144 transactions.
 */

const ACCOUNT = 'acc_row_identity';

function row(over: Partial<ParsedRow> = {}): ParsedRow {
  return {
    bookedOn: '2026-04-02',
    description: 'PRET A MANGER 1187',
    amountPence: -320,
    balanceAfterPence: null,
    sourceLine: 1,
    ...over,
  };
}

describe('two genuinely identical transactions on one statement', () => {
  /**
   * ⚠ THE PROPERTY THIS FILE EXISTS FOR. A business really can buy the same
   * coffee twice in a day — same shop, same price, same description — and the
   * statement shows two lines because there were two payments. Nothing here may
   * ever collapse them.
   */
  test('both survive: identical rows get DIFFERENT fingerprints', () => {
    const rows = [row({ sourceLine: 5 }), row({ sourceLine: 6 })];
    const [first, second] = importFingerprintsFor(ACCOUNT, 'GBP', rows);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
    expect(new Set([first, second]).size).toBe(2);
  });

  test('three of them are three distinct identities', () => {
    const fingerprints = importFingerprintsFor(ACCOUNT, 'GBP', [row(), row(), row()]);
    expect(new Set(fingerprints).size).toBe(3);
  });

  test('the ordinal is the ONLY thing separating them', () => {
    // Stated directly, so the mechanism cannot be refactored away by accident:
    // the pair above differs in nothing except the occurrence number.
    const tuple = {
      accountId: ACCOUNT,
      bookedOn: '2026-04-02',
      currency: 'GBP',
      amountPence: -320,
      description: 'PRET A MANGER 1187',
    };
    expect(importFingerprint({ ...tuple, ordinal: 1 })).not.toBe(importFingerprint({ ...tuple, ordinal: 2 }));
  });
});

describe('the same statement, imported twice', () => {
  /**
   * The ordinal is a property of the FILE, never of the database — which is
   * exactly what makes a second import reproduce it. Counting rows already
   * stored would hand the second import ordinals 3 and 4 and double the data.
   */
  test('reproduces the identical fingerprints, in order', () => {
    const rows = [
      row({ description: 'BIDFOOD LTD', amountPence: -15_000, sourceLine: 5 }),
      row({ description: 'PRET A MANGER 1187', sourceLine: 6 }),
      row({ description: 'PRET A MANGER 1187', sourceLine: 7 }),
    ];
    expect(importFingerprintsFor(ACCOUNT, 'GBP', rows)).toEqual(importFingerprintsFor(ACCOUNT, 'GBP', rows));
  });

  test('a longer file that CONTAINS the same period agrees on the shared lines', () => {
    // August alone, then August + September. The August lines must hash the
    // same in both, so only September's are new.
    const august = [row({ bookedOn: '2026-08-03', description: 'BIDFOOD LTD', amountPence: -15_000 })];
    const augustAndSeptember = [
      ...august,
      row({ bookedOn: '2026-09-04', description: 'BRITISH GAS', amountPence: -5_000 }),
    ];

    const [shared] = importFingerprintsFor(ACCOUNT, 'GBP', august);
    const [alsoShared, september] = importFingerprintsFor(ACCOUNT, 'GBP', augustAndSeptember);

    expect(alsoShared).toBe(shared);
    expect(september).not.toBe(shared);
  });
});

describe('what changes the identity and what does not', () => {
  test('a different account is a different line', () => {
    expect(importFingerprintsFor('acc_a', 'GBP', [row()])[0]).not.toBe(
      importFingerprintsFor('acc_b', 'GBP', [row()])[0],
    );
  });

  test.each([
    ['date', row({ bookedOn: '2026-04-03' })],
    ['amount', row({ amountPence: -321 })],
    ['description', row({ description: 'PRET A MANGER 1188' })],
  ])('a different %s is a different line', (_what, changed) => {
    expect(importFingerprintsFor(ACCOUNT, 'GBP', [changed])[0]).not.toBe(
      importFingerprintsFor(ACCOUNT, 'GBP', [row()])[0],
    );
  });

  test('the running balance is NOT part of the identity', () => {
    // ⚠ Deliberate, and the reason is written in row-identity.ts: a statement
    // with no balance column is a supported class (D41 `reduced`). If the
    // balance were hashed, a client who sent a balance-less CSV and then a
    // proper PDF of the same month would double the entire period.
    expect(importFingerprintsFor(ACCOUNT, 'GBP', [row({ balanceAfterPence: 84_000 })])[0]).toBe(
      importFingerprintsFor(ACCOUNT, 'GBP', [row({ balanceAfterPence: null })])[0],
    );
  });

  test('the source line is NOT part of the identity', () => {
    // The same statement as a CSV and as a Textract grid has different preamble,
    // so one transaction sits on different lines. Identity survives the format.
    expect(importFingerprintsFor(ACCOUNT, 'GBP', [row({ sourceLine: 4 })])[0]).toBe(
      importFingerprintsFor(ACCOUNT, 'GBP', [row({ sourceLine: 41 })])[0],
    );
  });

  test('case and whitespace runs do not change it — those differ between formats', () => {
    expect(importFingerprintsFor(ACCOUNT, 'GBP', [row({ description: '  bidfood   ltd ' })])[0]).toBe(
      importFingerprintsFor(ACCOUNT, 'GBP', [row({ description: 'BIDFOOD LTD' })])[0],
    );
  });

  test('digits are NOT stripped — two card payments are two payments', () => {
    expect(normaliseDescription('CARD PAYMENT 1234')).not.toBe(normaliseDescription('CARD PAYMENT 5678'));
  });
});

describe('the value itself', () => {
  test('is a versioned sha256, so a future tuple change is legible in the database', () => {
    expect(importFingerprintsFor(ACCOUNT, 'GBP', [row()])[0]).toMatch(/^v1:[0-9a-f]{64}$/u);
  });

  test('the grouper normalises exactly as the fingerprint does', () => {
    // If these two ever disagree, the backfill hands two rows the same ordinal
    // and the second one dies on the unique index.
    expect(identityGroupKey(ACCOUNT, '2026-04-02', 'GBP', -320, 'bidfood  ltd')).toBe(
      identityGroupKey(ACCOUNT, '2026-04-02', 'GBP', -320, 'BIDFOOD LTD'),
    );
  });

  test('field boundaries cannot be forged by a description', () => {
    // Two different tuples must never serialise to one string. A description
    // that looks like the next field over is the classic way that happens.
    expect(importFingerprint({ accountId: 'a', bookedOn: '2026-04-02', currency: 'GBP', amountPence: -1, description: 'X', ordinal: 1 })).not.toBe(
      importFingerprint({ accountId: 'a', bookedOn: '2026-04-02', currency: 'GBP', amountPence: -1, description: 'X1', ordinal: 1 }),
    );
  });
});
