import { describe, expect, test } from 'vitest';

import type {
  CanonicalBankStatementLine,
  CanonicalTransactionDocument,
} from '../../canonical/canonical-row.js';

import {
  HOW_TO_IMPORT_FILENAME,
  VT_CSV_INCLUDE_HEADER,
  VT_LIST_COLUMNS,
  VT_PROVENANCE_TAG,
  vtFileName,
  vtTransactionPlusEmitter,
} from './vt-transaction-plus-emitter.js';

/**
 * These tests are the closest thing this repo has to importing a file into VT,
 * and after A10 they are written against what a real VT was **observed** to do
 * rather than against published documentation, which was wrong about the route,
 * the columns and the split-analysis limit alike.
 *
 * They assert the *archive*, because the archive is the only artefact the
 * accountant ever sees.
 */

// ---------------------------------------------------------------------------
// Fixtures, and enough of a ZIP/CSV reader to read the emitter's output back
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

function bankPayment(overrides: Partial<CanonicalBankStatementLine> = {}): CanonicalBankStatementLine {
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

/** Reads the stored entries back out of the archive, the way an extractor does. */
function readZip(archive: Buffer): Map<string, Buffer> {
  const eocd = archive.length - 22;
  expect(archive.readUInt32LE(eocd)).toBe(0x0605_4b50);
  const entryCount = archive.readUInt16LE(eocd + 10);

  const files = new Map<string, Buffer>();
  let cursor = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const size = archive.readUInt32LE(cursor + 24);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('ascii');

    const dataStart =
      localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    files.set(name, archive.subarray(dataStart, dataStart + size));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** Minimal RFC 4180 reader — enough to prove quoting round-trips. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function csvIn(archive: Buffer, name: string): string[][] {
  const bytes = readZip(archive).get(name);
  expect(bytes, `${name} is in the archive`).toBeDefined();
  // The BOM is the encoding decision (`csv/encoding.ts`), not data.
  return parseCsv((bytes as Buffer).toString('utf8').replace(/^﻿/, ''));
}

// ---------------------------------------------------------------------------
// The shape A10 established
// ---------------------------------------------------------------------------

describe('the archive', () => {
  test('is a ZIP, declared as one, because one export produces many files', () => {
    expect(vtTransactionPlusEmitter.fileExtension).toBe('zip');
    expect(vtTransactionPlusEmitter.contentType).toBe('application/zip');
  });

  test('carries a how-to naming the route, the format and the date', () => {
    const emitted = vtTransactionPlusEmitter.emit([supplierInvoice()]);
    const howTo = readZip(emitted.bytes).get(HOW_TO_IMPORT_FILENAME);
    expect(howTo).toBeDefined();

    const text = (howTo as Buffer).toString('utf8');
    // The route A10 found, not the one the research described.
    expect(text).toContain('Transaction > Journal > Import...');
    expect(text).toContain('Payments list/purchase invoices list');
    // The date is the accountant's job, because no column carries it.
    expect(text).toContain('THE DATE IS NOT IN THE FILE');
    expect(text).toContain('2026-08-04');
  });
});

describe('⚠ no header row — the journal import is positional and reads row 1 as data', () => {
  test('the constant is false, and the first row is a transaction', () => {
    expect(VT_CSV_INCLUDE_HEADER).toBe(false);

    const emitted = vtTransactionPlusEmitter.emit([supplierInvoice()]);
    const rows = csvIn(emitted.bytes, vtFileName('2026-08-04', 'purchase-invoices'));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.[0]).toBe('Café Noir, Ltd');
    expect(rows[0]?.[0]).not.toBe(VT_LIST_COLUMNS[0]);
  });

  test('every row is exactly seven columns wide', () => {
    const emitted = vtTransactionPlusEmitter.emit([
      supplierInvoice(),
      bankPayment(),
      supplierInvoice({ documentId: 'doc_2', date: '2026-08-04', reference: 'INV-2' }),
    ]);
    for (const [name, bytes] of readZip(emitted.bytes)) {
      if (!name.endsWith('.csv')) continue;
      for (const row of parseCsv(bytes.toString('utf8').replace(/^﻿/, ''))) {
        expect(row, `${name} row width`).toHaveLength(VT_LIST_COLUMNS.length);
      }
    }
  });
});

describe('⚠ one file per date — VT applies one date to a whole journal', () => {
  test('two dates produce two files, each named for its day', () => {
    const emitted = vtTransactionPlusEmitter.emit([
      supplierInvoice({ documentId: 'a', date: '2026-08-04' }),
      supplierInvoice({ documentId: 'b', date: '2026-08-11', reference: 'INV-2' }),
    ]);

    const names = [...readZip(emitted.bytes).keys()].filter((name) => name.endsWith('.csv'));
    expect(names).toEqual([
      vtFileName('2026-08-04', 'purchase-invoices'),
      vtFileName('2026-08-11', 'purchase-invoices'),
    ]);
  });

  test('same date, same file', () => {
    const emitted = vtTransactionPlusEmitter.emit([
      supplierInvoice({ documentId: 'a' }),
      supplierInvoice({ documentId: 'b', reference: 'INV-2' }),
    ]);
    expect(csvIn(emitted.bytes, vtFileName('2026-08-04', 'purchase-invoices'))).toHaveLength(2);
  });
});

describe('⚠ one file per direction — there is no type column, so the format chooses', () => {
  test('purchases, sales and bank never share a file', () => {
    const emitted = vtTransactionPlusEmitter.emit([
      supplierInvoice({ documentId: 'p', date: '2026-08-04' }),
      supplierInvoice({ documentId: 's', date: '2026-08-04', party: 'CUSTOMER', reference: 'SI-1' }),
      bankPayment({ date: '2026-08-04' }),
    ]);

    const names = [...readZip(emitted.bytes).keys()].filter((name) => name.endsWith('.csv'));
    expect(names).toContain(vtFileName('2026-08-04', 'purchase-invoices'));
    expect(names).toContain(vtFileName('2026-08-04', 'sales-invoices'));
    expect(names).toContain(vtFileName('2026-08-04', 'bank'));
    expect(names).toHaveLength(3);
  });

  test('a credit note goes to its own file and says the direction is unverified', () => {
    const emitted = vtTransactionPlusEmitter.emit([
      supplierInvoice({ documentId: 'cn', instrument: 'CREDIT_NOTE' }),
    ]);

    expect([...readZip(emitted.bytes).keys()]).toContain(
      vtFileName('2026-08-04', 'purchase-credit-notes'),
    );
    expect(emitted.warnings.map((warning) => warning.code)).toContain(
      'credit-note-direction-unverified',
    );
  });
});

describe('⚠ split analysis — VT supports it, so nothing collapses any more', () => {
  const split = supplierInvoice({
    grossPence: 24000,
    vatPence: 4000,
    netPence: 20000,
    analysis: [
      { analysisAccount: 'Cost of sales: Purchases', netPence: 15000, vatPence: 3000 },
      { analysisAccount: 'Expenses: Cleaning', netPence: 5000, vatPence: 1000 },
    ],
  });

  test('two nominals become two rows, both nominals present', () => {
    const rows = csvIn(
      vtTransactionPlusEmitter.emit([split]).bytes,
      vtFileName('2026-08-04', 'purchase-invoices'),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.[6]).toBe('Cost of sales: Purchases');
    expect(rows[1]?.[6]).toBe('Expenses: Cleaning');
    // The whole net travels. This is what collapseAnalysis() used to destroy.
    expect(rows[0]?.[4]).toBe('150.00');
    expect(rows[1]?.[4]).toBe('50.00');
  });

  test('gross and VAT ride the first row only — VT reads the rest as continuation', () => {
    const rows = csvIn(
      vtTransactionPlusEmitter.emit([split]).bytes,
      vtFileName('2026-08-04', 'purchase-invoices'),
    );

    expect(rows[0]?.[2]).toBe('240.00');
    expect(rows[0]?.[3]).toBe('40.00');
    expect(rows[1]?.[2]).toBe('');
    expect(rows[1]?.[3]).toBe('');
  });

  test('the continuation row repeats the supplier — blank makes VT refuse the import', () => {
    const rows = csvIn(
      vtTransactionPlusEmitter.emit([split]).bytes,
      vtFileName('2026-08-04', 'purchase-invoices'),
    );
    expect(rows[1]?.[0]).toBe('Café Noir, Ltd');
    expect(rows[1]?.[0]).not.toBe('');
  });

  test('the £0.00 line VT will show is reported rather than left as a surprise', () => {
    const warnings = vtTransactionPlusEmitter.emit([split]).warnings;
    const warning = warnings.find((entry) => entry.code === 'split-analysis-zero-line');
    expect(warning?.message).toContain('£0.00');
    expect(warning?.message).toContain('Café Noir, Ltd');
  });

  test('rowCount counts CSV rows, so a split reads higher than the document count', () => {
    expect(vtTransactionPlusEmitter.emit([split]).rowCount).toBe(2);
  });
});

describe('the D43 link, in the one free-text column there is', () => {
  test('reference, code, URL and provenance all travel in Column B', () => {
    const rows = csvIn(
      vtTransactionPlusEmitter.emit([supplierInvoice()]).bytes,
      vtFileName('2026-08-04', 'purchase-invoices'),
    );

    const details = rows[0]?.[1] ?? '';
    expect(details).toContain('INV-1042');
    expect(details).toContain('A7K2M9');
    expect(details).toContain('https://neoacc.neovogent.com/d/A7K2M9');
    expect(details).toContain(VT_PROVENANCE_TAG);
  });

  test('a missing link is reported, never silently blank', () => {
    const emitted = vtTransactionPlusEmitter.emit([supplierInvoice({ sourceLink: null })]);
    expect(emitted.warnings.map((warning) => warning.code)).toContain('source-link-missing');
  });

  test('a letterless code is refused — VT would render it as a number', () => {
    // Refused twice over, and the first refusal wins: `CanonicalSourceLinkSchema`
    // already requires a letter in the code, so the row never reaches the
    // emitter. `assertVtEntryDetailsSafe` stays as defence in depth for a
    // caller that ever bypasses the schema — which is why this asserts *that*
    // it throws rather than which of the two threw.
    expect(() =>
      vtTransactionPlusEmitter.emit([
        supplierInvoice({ sourceLink: { code: '123456', url: 'https://x.test/d/123456' } }),
      ]),
    ).toThrow();
  });
});

describe('the two columns that decide where money lands', () => {
  test('Column A keeps the supplier name byte-for-byte, comma and accent included', () => {
    const rows = csvIn(
      vtTransactionPlusEmitter.emit([supplierInvoice()]).bytes,
      vtFileName('2026-08-04', 'purchase-invoices'),
    );
    expect(rows[0]?.[0]).toBe('Café Noir, Ltd');
  });

  test('an unprefixed analysis account is reported — VT reads a bare code as a number', () => {
    const emitted = vtTransactionPlusEmitter.emit([
      supplierInvoice({
        analysis: [{ analysisAccount: '5001', netPence: 10000, vatPence: 2000 }],
      }),
    ]);
    const warning = emitted.warnings.find((entry) => entry.code === 'analysis-account-unprefixed');
    expect(warning?.message).toContain('5001');
  });

  test('a prefixed analysis account passes without comment', () => {
    const emitted = vtTransactionPlusEmitter.emit([supplierInvoice()]);
    expect(emitted.warnings.map((warning) => warning.code)).not.toContain(
      'analysis-account-unprefixed',
    );
  });
});

describe('landmine 1 — digit runs that crash VT builds older than May 2025', () => {
  test('a long run is broken up, and the repair is reported', () => {
    const emitted = vtTransactionPlusEmitter.emit([
      supplierInvoice({ primaryAccount: 'Acme 12345678901234567890 Ltd' }),
    ]);

    const rows = csvIn(emitted.bytes, vtFileName('2026-08-04', 'purchase-invoices'));
    expect(rows[0]?.[0]).not.toContain('12345678901234567890');
    expect(emitted.warnings.map((warning) => warning.code)).toContain('long-numeric-token-broken');
  });
});

describe('amounts', () => {
  test('are pounds with two decimals, and money stays integer pence until the cell', () => {
    const rows = csvIn(
      vtTransactionPlusEmitter.emit([supplierInvoice()]).bytes,
      vtFileName('2026-08-04', 'purchase-invoices'),
    );
    expect(rows[0]?.[2]).toBe('120.00');
    expect(rows[0]?.[3]).toBe('20.00');
    expect(rows[0]?.[4]).toBe('100.00');
  });

  test('a zero-VAT line still carries its net into the VAT-purposes column', () => {
    const rows = csvIn(
      vtTransactionPlusEmitter.emit([
        supplierInvoice({
          grossPence: 5000,
          vatPence: 0,
          netPence: 5000,
          analysis: [{ analysisAccount: 'Expenses: Postage and carriage', netPence: 5000, vatPence: 0 }],
        }),
      ]).bytes,
      vtFileName('2026-08-04', 'purchase-invoices'),
    );
    expect(rows[0]?.[3]).toBe('0.00');
    expect(rows[0]?.[4]).toBe('50.00');
    expect(rows[0]?.[5]).toBe('50.00');
  });
});
