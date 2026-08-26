import { describe, expect, test } from 'vitest';

import type {
  CanonicalBankStatementLine,
  CanonicalTransactionDocument,
} from '../../canonical/canonical-row.js';

import {
  VT_CSV_INCLUDE_HEADER,
  VT_PROVENANCE_TAG,
  VT_UIS_COLUMNS,
  vtTransactionPlusEmitter,
} from './vt-transaction-plus-emitter.js';
import {
  assertVtEntryDetailsSafe,
  containsLongNumericToken,
  VtEmitterError,
} from './vt-safety.js';

/**
 * These tests are the closest thing this repo has to importing a file into VT.
 * They are written against the *file*, not the internals, because the file is
 * the only artefact the accountant ever sees.
 */

// ---------------------------------------------------------------------------
// Fixtures and a minimal CSV reader
// ---------------------------------------------------------------------------

function supplierInvoice(
  overrides: Partial<CanonicalTransactionDocument> = {},
): CanonicalTransactionDocument {
  return {
    family: 'TRANSACTION_DOCUMENT',
    documentId: 'doc_1',
    businessId: 'biz_1',
    sourceLink: { code: 'A7K2M9', url: 'https://neoacc.neovogent.com/d/A7K2M9' },
    party: 'SUPPLIER',
    instrument: 'INVOICE',
    date: '2026-08-04',
    primaryAccount: 'Café Noir, Ltd',
    reference: 'INV-1042',
    grossPence: 12000,
    vatPence: 2000,
    netPence: 10000,
    analysis: [{ analysisAccount: 'Cost of sales: Purchases', netPence: 10000, vatPence: 2000 }],
    ...overrides,
  };
}

function bankPayment(
  overrides: Partial<CanonicalBankStatementLine> = {},
): CanonicalBankStatementLine {
  return {
    family: 'BANK_STATEMENT_LINE',
    documentId: 'doc_bank_1',
    businessId: 'biz_1',
    sourceLink: null,
    movement: 'PAYMENT',
    instrument: 'BANK',
    date: '2026-08-05',
    bankAccount: 'Current account',
    contraAccount: 'Expenses: Motor expenses',
    description: 'ESSO GARAGE',
    grossPence: 5000,
    vatPence: 0,
    netPence: 5000,
    ...overrides,
  };
}

/**
 * The BOM the default encoding writes (`csv/encoding.ts`). Stripped by code
 * point rather than by a literal, so the character stays visible in this file.
 */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

function stripByteOrderMark(text: string): string {
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
}

/** Enough of RFC 4180 to read back what we wrote, and no more. */
function readCsv(bytes: Buffer): string[][] {
  const text = stripByteOrderMark(bytes.toString('utf8'));
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\r' && text[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
    } else field += character;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function dataRows(bytes: Buffer): string[][] {
  const rows = readCsv(bytes);
  return VT_CSV_INCLUDE_HEADER ? rows.slice(1) : rows;
}

const COLUMN = Object.fromEntries(VT_UIS_COLUMNS.map((name, index) => [name, index])) as Record<
  (typeof VT_UIS_COLUMNS)[number],
  number
>;

// ---------------------------------------------------------------------------
// THE TWO LANDMINES, proved end to end through the emitter
// ---------------------------------------------------------------------------

describe('LANDMINE 1 — no emitted cell carries a numeric token over 16 digits', () => {
  test('a 25-digit invoice reference is broken, reported, and never reaches the file intact', () => {
    const reference = '9'.repeat(25);
    const emitted = vtTransactionPlusEmitter.emit([
      supplierInvoice({
        reference,
        sourceLink: { code: 'A7K2M9', url: `https://neoacc.neovogent.com/d/A7K2M9?r=${reference}` },
      }),
    ]);

    // The whole file, every cell, header included: not one crashing token.
    for (const row of readCsv(emitted.bytes)) {
      for (const cell of row) {
        expect(containsLongNumericToken(cell)).toBe(false);
      }
    }

    // And the accountant is told, per document, rather than left with a
    // silently altered reference.
    expect(emitted.warnings.map((warning) => warning.code)).toContain('long-numeric-token-broken');
    expect(emitted.warnings.every((warning) => warning.documentId === 'doc_1')).toBe(true);
  });

  test('the guard reaches inside a URL in Transaction notes', () => {
    const emitted = vtTransactionPlusEmitter.emit([
      supplierInvoice({
        reference: 'INV-1042',
        sourceLink: { code: 'A7K2M9', url: `https://neoacc.neovogent.com/d/${'3'.repeat(19)}A` },
      }),
    ]);

    const notes = dataRows(emitted.bytes)[0]?.[COLUMN['Transaction notes']] ?? '';
    expect(notes).toContain('neoacc.neovogent.com');
    expect(containsLongNumericToken(notes)).toBe(false);
  });

  test('a document with no long token produces no such warning', () => {
    const emitted = vtTransactionPlusEmitter.emit([supplierInvoice()]);
    expect(emitted.warnings.map((warning) => warning.code)).not.toContain(
      'long-numeric-token-broken',
    );
  });
});

describe('LANDMINE 2 — Entry details never holds a numeric-looking string', () => {
  test('a capability code with a letter is written to Entry details unchanged', () => {
    const emitted = vtTransactionPlusEmitter.emit([supplierInvoice()]);
    expect(dataRows(emitted.bytes)[0]?.[COLUMN['Entry details']]).toBe('A7K2M9');
  });

  test('an all-digit code is refused loudly rather than silently coerced to 123456.00', () => {
    // Two locks on this door, and this asserts that at least one always holds:
    // the canonical schema refuses the code first, and `assertVtEntryDetailsSafe`
    // (unit-tested in `vt-safety.test.ts`) refuses it again at the cell. Both say
    // "letter", so the assertion does not care which one fired — only that no
    // file was ever written.
    expect(() =>
      vtTransactionPlusEmitter.emit([
        supplierInvoice({
          sourceLink: { code: '123456', url: 'https://neoacc.neovogent.com/d/123456' },
        }),
      ]),
    ).toThrow(/letter/);
  });

  test('the emitter itself refuses it even when the schema is bypassed', () => {
    // The last line of defence, exercised directly: a future caller that
    // assembles rows without parsing them must still not be able to write a
    // numeric-looking Entry details.
    expect(() => assertVtEntryDetailsSafe('123456')).toThrow(VtEmitterError);
  });

  test('every Entry details cell in a file contains a letter or is empty', () => {
    const emitted = vtTransactionPlusEmitter.emit([supplierInvoice(), bankPayment()]);
    for (const row of dataRows(emitted.bytes)) {
      const cell = row[COLUMN['Entry details']] ?? '';
      expect(cell === '' || /[A-Za-z]/.test(cell)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The format itself
// ---------------------------------------------------------------------------

describe('the Universal Input Sheet layout', () => {
  test("the columns are in VT's on-screen order", () => {
    expect([...VT_UIS_COLUMNS]).toStrictEqual([
      'Type',
      'Ref no',
      'Date',
      'Primary account',
      'Details',
      'Total',
      'VAT',
      'Analysis',
      'Analysis account',
      'Entry details',
      'Transaction notes',
    ]);
  });

  test('a supplier invoice becomes one PIN row with gross, VAT and net in that order', () => {
    const emitted = vtTransactionPlusEmitter.emit([supplierInvoice()]);
    const row = dataRows(emitted.bytes)[0] ?? [];

    expect(row[COLUMN.Type]).toBe('PIN');
    expect(row[COLUMN['Ref no']]).toBe(''); // VT assigns its own at post time.
    expect(row[COLUMN.Date]).toBe('04/08/2026'); // UK d/m/y: 4 August.
    expect(row[COLUMN['Primary account']]).toBe('Café Noir, Ltd'); // Name only, no prefix.
    expect(row[COLUMN.Details]).toBe('INV-1042');
    expect(row[COLUMN.Total]).toBe('120.00'); // gross
    expect(row[COLUMN.VAT]).toBe('20.00');
    expect(row[COLUMN.Analysis]).toBe('100.00'); // net
    expect(row[COLUMN['Analysis account']]).toBe('Cost of sales: Purchases'); // WITH prefix.
    expect(emitted.rowCount).toBe(1);
  });

  test('amounts are always positive — VT derives debit and credit from Type', () => {
    const creditNote = supplierInvoice({
      documentId: 'doc_2',
      instrument: 'CREDIT_NOTE',
      grossPence: -12000,
      vatPence: -2000,
      netPence: -10000,
      analysis: [{ analysisAccount: 'Cost of sales: Purchases', netPence: -10000, vatPence: -2000 }],
    });

    const row = dataRows(vtTransactionPlusEmitter.emit([creditNote]).bytes)[0] ?? [];

    expect(row[COLUMN.Type]).toBe('PCR');
    expect(row[COLUMN.Total]).toBe('120.00');
    expect(row[COLUMN.VAT]).toBe('20.00');
    expect(row[COLUMN.Analysis]).toBe('100.00');
    // Not one signed amount anywhere in the file — the sign lives in `Type`.
    for (const amountColumn of ['Total', 'VAT', 'Analysis'] as const) {
      for (const emittedRow of dataRows(vtTransactionPlusEmitter.emit([creditNote]).bytes)) {
        expect(emittedRow[COLUMN[amountColumn]]).not.toMatch(/-/);
      }
    }
  });

  test('every Type code VT knows, and no code it does not', () => {
    const types = [
      supplierInvoice({ party: 'SUPPLIER', instrument: 'INVOICE' }),
      supplierInvoice({ documentId: 'doc_2', party: 'SUPPLIER', instrument: 'CREDIT_NOTE' }),
      supplierInvoice({ documentId: 'doc_3', party: 'CUSTOMER', instrument: 'INVOICE' }),
      supplierInvoice({ documentId: 'doc_4', party: 'CUSTOMER', instrument: 'CREDIT_NOTE' }),
      bankPayment({ movement: 'PAYMENT', instrument: 'BANK' }),
      bankPayment({ documentId: 'doc_bank_2', movement: 'PAYMENT', instrument: 'CHEQUE' }),
      bankPayment({ documentId: 'doc_bank_3', movement: 'RECEIPT', instrument: 'BANK' }),
    ];

    const emitted = vtTransactionPlusEmitter.emit(types);
    expect(dataRows(emitted.bytes).map((row) => row[COLUMN.Type])).toStrictEqual([
      'PIN',
      'PCR',
      'SIN',
      'SCR',
      'PAY',
      'CHQ',
      'REC',
    ]);
  });

  test('a zero-VAT line emits 0.00 rather than an empty cell', () => {
    const zeroRated = supplierInvoice({
      grossPence: 10000,
      vatPence: 0,
      netPence: 10000,
      analysis: [{ analysisAccount: 'Cost of sales: Purchases', netPence: 10000, vatPence: 0 }],
    });
    const row = dataRows(vtTransactionPlusEmitter.emit([zeroRated]).bytes)[0] ?? [];

    expect(row[COLUMN.VAT]).toBe('0.00');
    expect(row[COLUMN.Total]).toBe('100.00');
  });

  test('a supplier name with a comma AND an accent survives the round trip', () => {
    // The one case that breaks hand-rolled serialisers, and the case A10 is
    // told to put in front of a real VT.
    const emitted = vtTransactionPlusEmitter.emit([
      supplierInvoice({ primaryAccount: 'Épicerie Dubois, S.à r.l.' }),
    ]);

    expect(dataRows(emitted.bytes)[0]?.[COLUMN['Primary account']]).toBe(
      'Épicerie Dubois, S.à r.l.',
    );
    // Quoted because of the comma, and quoted exactly once.
    expect(emitted.bytes.toString('utf8')).toContain('"Épicerie Dubois, S.à r.l."');
  });
});

// ---------------------------------------------------------------------------
// What did not travel
// ---------------------------------------------------------------------------

describe('warnings — the alternative to silent flattening (§24.3.4)', () => {
  test('a document spanning two nominals collapses to one row and says so', () => {
    const twoNominals = supplierInvoice({
      grossPence: 12000,
      vatPence: 2000,
      netPence: 10000,
      analysis: [
        { analysisAccount: 'Cost of sales: Purchases', netPence: 3000, vatPence: 600 },
        { analysisAccount: 'Expenses: Motor expenses', netPence: 7000, vatPence: 1400 },
      ],
    });

    const emitted = vtTransactionPlusEmitter.emit([twoNominals]);
    const rows = dataRows(emitted.bytes);

    // ONE row: splitting would make VT create two supplier transactions where
    // the accountant has one invoice.
    expect(rows).toHaveLength(1);
    // The total still reconciles against the supplier statement.
    expect(rows[0]?.[COLUMN.Total]).toBe('120.00');
    expect(rows[0]?.[COLUMN.Analysis]).toBe('100.00');
    // Against the largest line's nominal...
    expect(rows[0]?.[COLUMN['Analysis account']]).toBe('Expenses: Motor expenses');
    // ...and the smaller one is named, not lost.
    const collapsed = emitted.warnings.find((warning) => warning.code === 'analysis-collapsed');
    expect(collapsed?.documentId).toBe('doc_1');
    expect(collapsed?.message).toContain('Cost of sales: Purchases');
  });

  test('an unprefixed analysis account is flagged — VT wants "Ledger: Account"', () => {
    const emitted = vtTransactionPlusEmitter.emit([
      supplierInvoice({
        analysis: [{ analysisAccount: 'Purchases', netPence: 10000, vatPence: 2000 }],
      }),
    ]);
    expect(emitted.warnings.map((warning) => warning.code)).toContain(
      'analysis-account-unprefixed',
    );
  });

  test('a row with no source link is exported blank and reported, never silently linkless', () => {
    const emitted = vtTransactionPlusEmitter.emit([supplierInvoice({ sourceLink: null })]);

    expect(dataRows(emitted.bytes)[0]?.[COLUMN['Entry details']]).toBe('');
    expect(emitted.warnings.map((warning) => warning.code)).toContain('source-link-missing');
  });
});

// ---------------------------------------------------------------------------
// D43 rung 3, and rule 9
// ---------------------------------------------------------------------------

describe('Transaction notes', () => {
  test('carries the code, the full URL and the provenance tag', () => {
    const notes =
      dataRows(vtTransactionPlusEmitter.emit([supplierInvoice()]).bytes)[0]?.[
        COLUMN['Transaction notes']
      ] ?? '';

    expect(notes).toContain('A7K2M9');
    expect(notes).toContain('https://neoacc.neovogent.com/d/A7K2M9');
    expect(notes).toContain(VT_PROVENANCE_TAG);
  });

  test('says "Imported from", never anything implying a ledger was written to (D42, rule 9)', () => {
    const file = vtTransactionPlusEmitter.emit([supplierInvoice()]).bytes.toString('utf8');

    expect(VT_PROVENANCE_TAG).toBe('Imported from Neo Accounting');
    for (const forbidden of ['Sent to', 'Published to', 'Posted to', 'Synced']) {
      expect(file).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

describe('the emitter boundary', () => {
  test('parses its input rather than trusting it (rule 4)', () => {
    // Gross that is not net + VAT is a wrong number on its way into a ledger.
    expect(() =>
      vtTransactionPlusEmitter.emit([supplierInvoice({ grossPence: 99999 })]),
    ).toThrow();
  });

  test('an empty export is an empty file, not a crash', () => {
    const emitted = vtTransactionPlusEmitter.emit([]);
    expect(emitted.rowCount).toBe(0);
    expect(emitted.warnings).toStrictEqual([]);
    expect(dataRows(emitted.bytes)).toStrictEqual([]);
  });

  test('declares itself as the VT target with a CSV file', () => {
    expect(vtTransactionPlusEmitter.target).toBe('VT_TRANSACTION_PLUS');
    expect(vtTransactionPlusEmitter.fileExtension).toBe('csv');
    expect(vtTransactionPlusEmitter.contentType).toBe('text/csv');
  });
});
