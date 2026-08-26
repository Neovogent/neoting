import { expect, test } from 'vitest';

import type { Export as ExportRow } from '@prisma/client';

import { readExportFilters, startOfNextUtcDay, startOfUtcDay, toExport } from './export-record.js';

const ROW: ExportRow = {
  id: 'exp_1',
  businessId: 'biz_1',
  kind: 'documents',
  format: 'csv',
  target: 'VT_TRANSACTION_PLUS',
  periodStart: new Date('2026-01-01T00:00:00.000Z'),
  periodEnd: new Date('2026-01-31T00:00:00.000Z'),
  rowCount: 12,
  filters: {
    documentIds: null,
    documentCount: 11,
    bundleS3Key: 'w/biz_1/documents/zip',
    warnings: [{ documentId: 'doc_9', code: 'analysis-collapsed', message: 'Reallocate in VT after posting.' }],
  },
  s3Key: 'w/biz_1/documents/csv',
  state: 'succeeded',
  virusScanned: false,
  createdByUserId: 'usr_1',
  createdAt: new Date('2026-02-01T09:30:00.000Z'),
  completedAt: new Date('2026-02-01T09:30:02.000Z'),
  expiresAt: null,
} as unknown as ExportRow;

function row(over: Partial<ExportRow> = {}): ExportRow {
  return { ...ROW, ...over } as ExportRow;
}

test('a row projects onto the contract shape, dates as calendar dates and instants as UTC ISO', () => {
  const projected = toExport(row());

  expect(projected).toMatchObject({
    id: 'exp_1',
    businessId: 'biz_1',
    target: 'VT_TRANSACTION_PLUS',
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    rowCount: 12,
    documentCount: 11,
    state: 'succeeded',
    createdAt: '2026-02-01T09:30:00.000Z',
    completedAt: '2026-02-01T09:30:02.000Z',
  });
  expect(projected.warnings).toHaveLength(1);
});

test('nothing that never leaves the server leaks into the projection', () => {
  // The failure mode of a `...row` spread is silent over-exposure that
  // typechecks, so the key set is pinned rather than eyeballed. `s3Key`,
  // `createdByUserId`, `kind`, `format` and `virusScanned` are all absent from
  // the contract's `Export` and none may appear on the wire.
  expect(Object.keys(toExport(row())).sort()).toEqual([
    'bundle',
    'businessId',
    'completedAt',
    'createdAt',
    'documentCount',
    'file',
    'id',
    'periodEnd',
    'periodStart',
    'rowCount',
    'state',
    'target',
    'warnings',
  ]);
});

test('history carries no download URLs, because the signed ones are minutes long', () => {
  const projected = toExport(row());
  expect(projected.file).toBeNull();
  expect(projected.bundle).toBeNull();
});

test('the create path passes the two URLs it has just signed', () => {
  const access = {
    url: 'https://storage.test/x',
    expiresAt: '2026-02-01T09:40:00.000Z',
    mimeType: 'text/csv',
    byteSize: 400,
    filename: 'vt-transaction-plus-2026-01-01-to-2026-01-31.csv',
  };
  const projected = toExport(row(), { file: access, bundle: { ...access, mimeType: 'application/zip' } });

  expect(projected.file).toEqual(access);
  expect(projected.bundle?.mimeType).toBe('application/zip');
});

test('a null period is projected as null, not as an invented date', () => {
  const projected = toExport(row({ periodStart: null, periodEnd: null, completedAt: null, rowCount: null }));

  expect(projected.periodStart).toBeNull();
  expect(projected.periodEnd).toBeNull();
  expect(projected.completedAt).toBeNull();
  expect(projected.rowCount).toBeNull();
});

test('an unparseable filters blob degrades to "nothing recorded" rather than felling the page', () => {
  const projected = toExport(row({ filters: { documentCount: 'eleven' } as never }));

  expect(projected.documentCount).toBeNull();
  expect(projected.warnings).toEqual([]);
  // The columns are still true. That is the point of degrading rather than throwing.
  expect(projected.rowCount).toBe(12);
});

test('a legacy row with no target reads as the generic CSV it would have been', () => {
  expect(toExport(row({ target: null })).target).toBe('GENERIC_CSV');
});

test('readExportFilters defaults every member, so a partial record is still usable', () => {
  expect(readExportFilters({ bundleS3Key: 'k' })).toEqual({
    documentIds: null,
    documentCount: null,
    bundleS3Key: 'k',
    warnings: [],
  });
  expect(readExportFilters(null)).toEqual({
    documentIds: null,
    documentCount: null,
    bundleS3Key: null,
    warnings: [],
  });
});

test('the period boundaries are UTC midnights, and the end is EXCLUSIVE of the next day', () => {
  // `document_date` is a timestamptz that may carry a time, and the period is
  // inclusive at both ends. `lte` the last day's midnight silently drops every
  // document dated on it — a short file that looks complete.
  expect(startOfUtcDay('2026-01-01').toISOString()).toBe('2026-01-01T00:00:00.000Z');
  expect(startOfNextUtcDay('2026-01-31').toISOString()).toBe('2026-02-01T00:00:00.000Z');
  // Across a BST boundary and across a leap day, because both are where an
  // hour-arithmetic mistake shows up.
  expect(startOfNextUtcDay('2026-03-29').toISOString()).toBe('2026-03-30T00:00:00.000Z');
  expect(startOfNextUtcDay('2028-02-28').toISOString()).toBe('2028-02-29T00:00:00.000Z');
});
