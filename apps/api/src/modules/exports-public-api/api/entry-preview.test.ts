import { expect, test } from 'vitest';

import { analysisAccountChart } from './analysis-account-chart.js';
import type { ExportableDocumentRow } from './document-to-canonical.js';
import { previewExportEntries } from './entry-preview.js';

/**
 * The publish review card's half of the nominal fix.
 *
 * The export resolves `documents.category_code` against the client's chart of
 * accounts. A preview that did not would show the accountant a bare
 * `SOFTWARE_AND_SUBSCRIPTIONS` and an `analysis-account-unprefixed` warning for
 * a document the file will carry as `Expenses: Software and subscriptions` with
 * no warning at all — a card raising an alarm about a defect that no longer
 * exists, which is how a reviewer learns to skip the warnings that matter.
 *
 * ⚠ `sourceLink` stays the ONLY column this preview is honestly ignorant of
 * (the D43 code is minted by the export, later). The nominal is not on that
 * list, and these tests are what keep it off.
 */

const CHART = analysisAccountChart([
  { code: 'COS_PURCHASES', name: 'Cost of sales: Purchases' },
  { code: 'SOFTWARE_AND_SUBSCRIPTIONS', name: 'Expenses: Software and subscriptions' },
]);

/** Column G — `Analysis account` — is the last of the VT list columns. */
function analysisAccountOf(preview: { documents: readonly { rows: readonly (readonly string[])[] }[] }): string {
  const row = preview.documents[0]?.rows[0] ?? [];
  return row[row.length - 1] ?? '';
}

function document(over: Partial<ExportableDocumentRow> = {}): ExportableDocumentRow {
  return {
    id: 'doc_1',
    businessId: 'biz_1',
    inbox: 'COSTS',
    docType: 'INVOICE',
    supplierName: 'Adobe Systems',
    customerName: null,
    documentDate: new Date('2026-08-04T00:00:00.000Z'),
    totalPence: 6_199,
    taxPence: 1_033,
    reference: 'INV-1042',
    categoryCode: 'SOFTWARE_AND_SUBSCRIPTIONS',
    ...over,
  };
}

test('the previewed nominal is the ledger-prefixed one the file will carry', () => {
  const preview = previewExportEntries('VT_TRANSACTION_PLUS', [document()], CHART);

  expect(analysisAccountOf(preview)).toBe('Expenses: Software and subscriptions');
  expect(preview.documents[0]?.warnings.map((warning) => warning.code)).not.toContain(
    'analysis-account-unprefixed',
  );
});

test('an off-chart code reaches the reviewer as a warning BEFORE the release', () => {
  // The whole point of showing the entry: this is discovered on the review card,
  // not inside VT after the import. The cell is the bare code — never a ledger
  // nobody chose.
  const preview = previewExportEntries('VT_TRANSACTION_PLUS', [document({ categoryCode: 'SUBSCRIPTIONS' })], CHART);

  expect(analysisAccountOf(preview)).toBe('SUBSCRIPTIONS');
  const warning = preview.documents[0]?.warnings.find((entry) => entry.code === 'analysis-account-unprefixed');
  expect(warning?.message).toContain('SUBSCRIPTIONS');
  expect(warning?.message).toContain('no ledger prefix');
});

test('no chart is accepted and previews exactly as it always did — absence is not a failure', () => {
  // A proposal composed without a chart reader must still be previewable, and a
  // chart that cannot be read must not refuse a release.
  const preview = previewExportEntries('VT_TRANSACTION_PLUS', [document()], null);

  expect(analysisAccountOf(preview)).toBe('SOFTWARE_AND_SUBSCRIPTIONS');
  expect(preview.documents[0]?.warnings.map((warning) => warning.code)).toContain('analysis-account-unprefixed');
});

test('a document that cannot become a row is still a named refusal, chart or no chart', () => {
  const preview = previewExportEntries('VT_TRANSACTION_PLUS', [document({ categoryCode: null })], CHART);

  expect(preview.documents).toHaveLength(0);
  expect(preview.refusals?.[0]?.code).toBe('document-missing-category');
});
