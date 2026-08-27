import { expect, test } from 'vitest';

import type { CanonicalSourceLink } from '../canonical/canonical-row.js';

import { documentToCanonicalRow, type ExportableDocumentRow } from './document-to-canonical.js';

const LINK: CanonicalSourceLink = { code: 'K7QM2XZ4', url: 'https://neoacc.neovogent.com/d/K7QM2XZ4' };

const BASE: ExportableDocumentRow = {
  id: 'doc_1',
  businessId: 'biz_1',
  inbox: 'COSTS',
  docType: 'INVOICE',
  supplierName: 'Bidfood Ltd',
  customerName: null,
  documentDate: new Date('2026-01-14T00:00:00.000Z'),
  totalPence: 12_000,
  taxPence: 2_000,
  reference: 'INV-4471',
  categoryCode: 'Cost of sales: Purchases',
};

function row(over: Partial<ExportableDocumentRow> = {}): ExportableDocumentRow {
  return { ...BASE, ...over };
}

function built(over: Partial<ExportableDocumentRow> = {}, link: CanonicalSourceLink | null = LINK) {
  const result = documentToCanonicalRow(row(over), link);
  if (!result.ok) throw new Error(`expected a row, got refusal ${result.code}: ${result.message}`);
  if (result.row.family !== 'TRANSACTION_DOCUMENT') throw new Error('expected a transaction document');
  return result.row;
}

function refusal(over: Partial<ExportableDocumentRow>) {
  const result = documentToCanonicalRow(row(over), LINK);
  if (result.ok) throw new Error('expected a refusal');
  return result;
}

test('a supplier invoice becomes a supplier transaction document with the link attached', () => {
  const canonical = built();

  expect(canonical.party).toBe('SUPPLIER');
  expect(canonical.instrument).toBe('INVOICE');
  expect(canonical.primaryAccount).toBe('Bidfood Ltd');
  expect(canonical.reference).toBe('INV-4471');
  expect(canonical.sourceLink).toEqual(LINK);
  expect(canonical.analysis).toEqual([
    { analysisAccount: 'Cost of sales: Purchases', netPence: 10_000, vatPence: 2_000 },
  ]);
});

test('money stays integer pence and gross is net + VAT', () => {
  const canonical = built({ totalPence: 4_207, taxPence: 701 });

  expect(canonical.grossPence).toBe(4_207);
  expect(canonical.vatPence).toBe(701);
  expect(canonical.netPence).toBe(3_506);
  // The whole point of the invariant: nothing here is ever a float.
  for (const value of [canonical.grossPence, canonical.netPence, canonical.vatPence]) {
    expect(Number.isInteger(value)).toBe(true);
  }
});

test('a zero-VAT document nets to its gross', () => {
  const canonical = built({ taxPence: null });

  expect(canonical.vatPence).toBe(0);
  expect(canonical.netPence).toBe(canonical.grossPence);
});

test('a credit note is negative, and the sign comes from the instrument not the column', () => {
  // Stored positive (what the paper says) and stored negative (what a tidier
  // extractor might write) must produce the SAME canonical row. Trusting the
  // column would doubly negate the second one, and VT drops the sign again — so
  // the error would be invisible in the file and wrong only in the manifest.
  const fromPositive = built({ docType: 'CREDIT_NOTE', totalPence: 12_000, taxPence: 2_000 });
  const fromNegative = built({ docType: 'CREDIT_NOTE', totalPence: -12_000, taxPence: -2_000 });

  expect(fromPositive.instrument).toBe('CREDIT_NOTE');
  expect(fromPositive.grossPence).toBe(-12_000);
  expect(fromPositive.vatPence).toBe(-2_000);
  expect(fromPositive.netPence).toBe(-10_000);
  expect(fromNegative).toEqual(fromPositive);
});

test('a SALES inbox document is a customer document, coded against the customer name', () => {
  const canonical = built({ inbox: 'SALES', customerName: 'Ananda Group', supplierName: null });

  expect(canonical.party).toBe('CUSTOMER');
  expect(canonical.primaryAccount).toBe('Ananda Group');
});

test('a RECEIPT is an invoice-shaped document — only a credit note reverses', () => {
  expect(built({ docType: 'RECEIPT' }).instrument).toBe('INVOICE');
  expect(built({ docType: null }).instrument).toBe('INVOICE');
  expect(built({ docType: 'STATEMENT' }).instrument).toBe('INVOICE');
});

test('the date is read in UTC, so a summer document keeps its own day', () => {
  // The bug this pins: `new Date('2026-08-04')` is midnight UTC, and one
  // careless Europe/London formatter later it is 3 August in the file.
  const canonical = built({ documentDate: new Date('2026-08-04T00:00:00.000Z') });
  expect(canonical.date).toBe('2026-08-04');
});

test('the supplier name is passed through byte-for-byte apart from surrounding space', () => {
  // VT's Converter saves the supplier mapping against this exact string.
  const canonical = built({ supplierName: '  Épicerie Dubois, S.à r.l.  ' });
  expect(canonical.primaryAccount).toBe('Épicerie Dubois, S.à r.l.');
});

test('a document with no link still builds a row — the emitter is what warns', () => {
  // D43 failure has to be reported, not prevented by refusing the row: the
  // export must still carry the transaction, with `source-link-missing` beside
  // it. Substituting a placeholder link is what would make the warning stop.
  const canonical = built({}, null);
  expect(canonical.sourceLink).toBeNull();
});

test('every missing prerequisite is a named refusal, never a silently dropped row', () => {
  expect(refusal({ businessId: null }).code).toBe('document-unrouted');
  expect(refusal({ documentDate: null }).code).toBe('document-missing-date');
  expect(refusal({ totalPence: null }).code).toBe('document-missing-total');
  expect(refusal({ supplierName: null, customerName: null }).code).toBe('document-missing-counterparty');
  expect(refusal({ supplierName: '   ' }).code).toBe('document-missing-counterparty');
  expect(refusal({ categoryCode: null }).code).toBe('document-missing-category');
  expect(refusal({ categoryCode: '  ' }).code).toBe('document-missing-category');
});

test('every refusal message is written for an accountant, not a stack trace', () => {
  for (const over of [{ documentDate: null }, { totalPence: null }, { categoryCode: null }]) {
    const message = refusal(over).message;
    expect(message.length).toBeGreaterThan(20);
    expect(message).toMatch(/[a-z]\.$/);
  }
});

test('VAT larger than the total is refused rather than exported with a flipped net', () => {
  // Mixed signs are "a parsing accident, not a transaction" — the canonical
  // schema says so, and this is the path that turns that refusal into one
  // warning instead of a 500 over a month's export.
  const result = refusal({ totalPence: 1_000, taxPence: 4_000 });
  expect(result.code).toBe('document-not-representable');
  expect(result.message).toMatch(/do not add up/);
});

test('a zero-total document is exportable — 0 is a real total, null is not', () => {
  const canonical = built({ totalPence: 0, taxPence: 0 });
  expect(canonical.grossPence).toBe(0);
  expect(canonical.netPence).toBe(0);
});
