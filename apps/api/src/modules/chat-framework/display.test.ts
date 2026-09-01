import { describe, expect, test } from 'vitest';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { composeDisplay } from './display.js';

/**
 * The display composer — §9.4 applied to pictures. What is pinned is the
 * safety split: every cell/count comes from the rows the (stubbed, RLS-scoped)
 * client returned, money travels as integer pence in a string for the web's
 * one boundary to render, unknowns are empty strings rather than zeros, and an
 * empty subject is NO block rather than an empty table claiming "nothing
 * exists" with more confidence than an absence deserves.
 */

const db = (rows: { documents?: unknown[]; transactions?: unknown[]; chases?: unknown[] }) =>
  ({
    document: { findMany: async () => rows.documents ?? [] },
    bankTransaction: { findMany: async () => rows.transactions ?? [] },
    chase: { findMany: async () => rows.chases ?? [] },
  }) as unknown as ScopedClient;

const DOCS = [
  {
    supplierName: 'Bidfood',
    totalPence: 128450,
    documentDate: new Date('2026-08-29T00:00:00Z'),
    state: 'READY',
    categoryCode: 'COS-FOOD',
  },
  { supplierName: null, totalPence: null, documentDate: null, state: 'PROCESSING', categoryCode: null },
  {
    supplierName: 'Shell',
    totalPence: 7840,
    documentDate: new Date('2026-08-30T00:00:00Z'),
    state: 'READY',
    categoryCode: 'TRAVEL',
  },
];

describe('composeDisplay — tables', () => {
  test('a documents table carries pence as digits and unknowns as empty strings, never zeros', async () => {
    const block = await composeDisplay(db({ documents: DOCS }), 'biz_1', { kind: 'table', subject: 'documents' });

    expect(block).not.toBeNull();
    expect(block!.kind).toBe('table');
    expect(block!.columns!.map((c) => c.cellType)).toEqual(['text', 'date', 'pence', 'text', 'text']);
    expect(block!.rows![0]).toEqual(['Bidfood', '2026-08-29', '128450', 'READY', 'COS-FOOD']);
    // The unknown row: empty strings, not '0' — a zero here would be a fact
    // nobody read.
    expect(block!.rows![1]).toEqual(['', '', '', 'PROCESSING', '']);
  });

  test('a signed transaction amount survives as signed pence', async () => {
    const block = await composeDisplay(
      db({
        transactions: [
          {
            descriptionRaw: 'JUST EAT PAYOUT',
            merchantName: null,
            amountPence: 284155,
            bookedAt: new Date('2026-08-25T00:00:00Z'),
            matchState: 'UNMATCHED',
          },
        ],
      }),
      'biz_1',
      { kind: 'table', subject: 'bankTransactions' },
    );

    expect(block!.rows![0]).toEqual(['JUST EAT PAYOUT', '2026-08-25', '284155', 'UNMATCHED']);
  });
});

describe('composeDisplay — bar charts', () => {
  test('bars are COUNTS by state, insertion-ordered and stable', async () => {
    const block = await composeDisplay(db({ documents: DOCS }), 'biz_1', { kind: 'barChart', subject: 'documents' });

    expect(block!.kind).toBe('barChart');
    expect(block!.bars).toEqual([
      { label: 'READY', count: 2 },
      { label: 'PROCESSING', count: 1 },
    ]);
    // No money anywhere on a chart — §9.4's financial-statement fence.
    expect(JSON.stringify(block)).not.toContain('128450');
  });

  test('chases tally by state', async () => {
    const block = await composeDisplay(
      db({
        chases: [
          { state: 'OPEN', createdAt: new Date('2026-08-20T00:00:00Z'), detectionEngine: 'deterministic' },
          { state: 'CLOSED', createdAt: new Date('2026-08-21T00:00:00Z'), detectionEngine: 'deterministic' },
          { state: 'OPEN', createdAt: new Date('2026-08-22T00:00:00Z'), detectionEngine: 'deterministic' },
        ],
      }),
      'biz_1',
      { kind: 'barChart', subject: 'chases' },
    );

    expect(block!.bars).toEqual([
      { label: 'OPEN', count: 2 },
      { label: 'CLOSED', count: 1 },
    ]);
  });
});

describe('composeDisplay — the empty subject', () => {
  test('no rows is NO block, not an empty table', async () => {
    expect(await composeDisplay(db({}), 'biz_1', { kind: 'table', subject: 'documents' })).toBeNull();
    expect(await composeDisplay(db({}), 'biz_1', { kind: 'barChart', subject: 'bankTransactions' })).toBeNull();
    expect(await composeDisplay(db({}), 'biz_1', { kind: 'table', subject: 'chases' })).toBeNull();
  });
});
