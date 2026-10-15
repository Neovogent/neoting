import { describe, expect, test } from 'vitest';

import { financialYearOf, findDates, HeuristicVaultClassifier } from './vault-classifier.js';
import { imageBasename, mapRows, parsePence, parseUkDate } from './import-mapping.js';

describe('parsePence', () => {
  test.each([
    ['£1,234.56', 123456],
    ['12', 1200],
    ['12.5', 1250],
    ['-3.07', -307],
    ['(10.00)', -1000],
    ['GBP 0.99', 99],
    ['', null],
    ['12.345', null],
    ['abc', null],
  ])('%s → %s', (raw, pence) => expect(parsePence(raw)).toBe(pence));
});

describe('parseUkDate', () => {
  test.each([
    ['03/04/2026', '2026-04-03'],
    ['3-4-26', '2026-04-03'],
    ['2026-04-03', '2026-04-03'],
    ['12 Mar 2026', '2026-03-12'],
    ['31/02/2026', null],
    ['nonsense', null],
  ])('%s → %s', (raw, iso) => expect(parseUkDate(raw)).toBe(iso));
});

test('imageBasename strips paths and URL queries', () => {
  expect(imageBasename('https://x.example/a/b/receipt-1.jpg?sig=1')).toBe('receipt-1.jpg');
  expect(imageBasename('images\\R2.PDF')).toBe('R2.PDF');
});

test('maps a Dext-shaped export', () => {
  const grid = [
    ['Date', 'Supplier', 'Category', 'Description', 'Currency', 'Total Amount', 'Tax Amount', 'Net Amount', 'Payment Method', 'Image'],
    ['14/08/2026', 'Bidfood', '5000', 'Stock', 'gbp', '£120.00', '20.00', '100.00', 'Card', 'r1.jpg'],
    ['', '', '', '', '', '', '', '', '', ''],
    ['15/08/2026', 'Currys', '', '', 'GBP', '1,299.00', '', '', 'Card', ''],
  ];
  const result = mapRows(grid);
  expect(result.mapping).toMatchObject({ date: 'Date', supplier: 'Supplier', total: 'Total Amount', vat: 'Tax Amount', net: 'Net Amount', category: 'Category', image: 'Image' });
  expect(result.rows).toHaveLength(2);
  expect(result.rows[0]).toMatchObject({ rowNumber: 2, supplierName: 'Bidfood', documentDate: '2026-08-14', totalPence: 12000, taxPence: 2000, netPence: 10000, currency: 'GBP', imageFilename: 'r1.jpg' });
  expect(result.rows[1]).toMatchObject({ rowNumber: 4, totalPence: 129900, taxPence: null, imageFilename: null });
  expect(result.warnings.join(' ')).toContain('Payment Method');
});

test('maps AutoEntry headers and derives the total from net + VAT', () => {
  const result = mapRows([
    ['Date', 'Supplier', 'Ref', 'Net', 'VAT', 'Category', 'Image Filename'],
    ['01/05/2026', 'BT', 'INV-9', '50.00', '10.00', 'Telephone', 'bt.pdf'],
  ]);
  expect(result.rows[0]).toMatchObject({ reference: 'INV-9', netPence: 5000, taxPence: 1000, totalPence: 6000, imageFilename: 'bt.pdf' });
});

test('a manual mapping overrides an unknown header', () => {
  const result = mapRows([['When', 'Who', 'How much'], ['02/01/2026', 'Tesco', '9.99']], { date: 'When', supplier: 'Who', total: 'how much' });
  expect(result.rows[0]).toMatchObject({ documentDate: '2026-01-02', supplierName: 'Tesco', totalPence: 999 });
});

test('the heuristic vault classifier finds category and expiry', async () => {
  const analysis = await new HeuristicVaultClassifier().classify({
    filename: 'van-insurance-2026.pdf',
    mimeType: 'application/pdf',
    text: 'Policy schedule issued 01/03/2026. Cover valid until 28/02/2027.',
    practiceId: 'p',
    businessId: 'b',
  });
  expect(analysis.category).toBe('insurance');
  expect(analysis.expiryDate).toBe('2027-02-28');
  expect(analysis.documentDate).toBe('2026-03-01');
  expect(findDates('on 1/2/26')[0]?.date).toBe('2026-02-01');
});

test('financialYearOf follows the UK tax year', () => {
  expect(financialYearOf('2026-04-05')).toBe('2025-26');
  expect(financialYearOf('2026-04-06')).toBe('2026-27');
  expect(financialYearOf('2099-12-31')).toBe('2099-00');
});
