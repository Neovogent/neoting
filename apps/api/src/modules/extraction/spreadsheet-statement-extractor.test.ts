import { expect, test } from 'vitest';

import { isSpreadsheetMime, SPREADSHEET_EXTRACTOR_KIND, spreadsheetStatementExtractor } from './spreadsheet-statement-extractor.js';

test('the two spreadsheet MIMEs route here; everything else goes to the configured extractor', () => {
  expect(isSpreadsheetMime('text/csv')).toBe(true);
  expect(isSpreadsheetMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true);
  // Parameters and case are the sender's noise, not a different type.
  expect(isSpreadsheetMime('text/csv; charset=utf-8')).toBe(true);
  expect(isSpreadsheetMime('Text/CSV')).toBe(true);

  expect(isSpreadsheetMime('application/pdf')).toBe(false);
  expect(isSpreadsheetMime('image/jpeg')).toBe(false);
  // The legacy Excel alias is a DECLARED type admitted at the door only; the
  // stored mime is the sniff's answer, which is one of the two above. By the
  // time extraction reads the row, this string cannot appear.
  expect(isSpreadsheetMime('application/vnd.ms-excel')).toBe(false);
  expect(isSpreadsheetMime(null)).toBe(false);
});

test('the classification is STATEMENT with every header field honestly null (→ TO_REVIEW)', async () => {
  const outcome = await spreadsheetStatementExtractor.extract({
    filename: 'statement.csv',
    byteHash: 'a'.repeat(64),
    s3Key: 'w/biz_1/documents/doc_1',
    mimeType: 'text/csv',
    practiceId: 'prc_1',
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.document.docType).toBe('STATEMENT');
  // Null, never '' or 0: a statement has no supplier and no single total, and
  // null is what resolveProcessedState reads as "left for a human".
  expect(outcome.document.supplierName).toBeNull();
  expect(outcome.document.totalPence).toBeNull();
  expect(outcome.document.categoryCode).toBeNull();
  expect(outcome.document.validatorFailed).toBe(false);
});

test('the audit columns name this branch, never a model', () => {
  expect(spreadsheetStatementExtractor.kind).toBe(SPREADSHEET_EXTRACTOR_KIND);
  expect(spreadsheetStatementExtractor.kind).not.toBe('bedrock');
  expect(spreadsheetStatementExtractor.kind).not.toBe('demo');
});
