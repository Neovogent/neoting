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

const db = (rows: { documents?: unknown[]; transactions?: unknown[]; chases?: unknown[]; statements?: unknown[] }) =>
  ({
    document: { findMany: async () => rows.documents ?? [] },
    bankTransaction: { findMany: async () => rows.transactions ?? [] },
    chase: { findMany: async () => rows.chases ?? [] },
    statement: { findMany: async () => rows.statements ?? [] },
  }) as unknown as ScopedClient;

/**
 * Three statements, three verdicts (D41) — and the third is the trap: a
 * `gapAnalysis` an older build wrote that nothing can read. It must come out
 * as "could not be checked", never as "proven".
 */
const STATEMENTS = [
  {
    periodStart: new Date('2026-08-01T00:00:00Z'),
    periodEnd: new Date('2026-08-31T00:00:00Z'),
    rowCount: 128,
    gapAnalysis: { assurance: 'complete', provenBy: 'balanceContinuity', findings: [] },
  },
  {
    periodStart: new Date('2026-07-01T00:00:00Z'),
    periodEnd: new Date('2026-07-31T00:00:00Z'),
    rowCount: 96,
    gapAnalysis: { assurance: 'incomplete', findings: [{ kind: 'dateGap', detail: '3 days missing' }] },
  },
  { periodStart: null, periodEnd: null, rowCount: null, gapAnalysis: 'garbage-from-an-older-build' },
];

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

/**
 * ⚠ **Trash is not in a display block** (soft delete, `documents.deleted_at`,
 * 2 Sep 2026).
 *
 * It matters more in a CHART than the row count suggests. A table at least
 * shows the reader a row they could question; "Documents by state" is a
 * **tally**, so a deleted document does not appear as anything — it silently
 * inflates a bar, and the picture disagrees with the documents list on the same
 * screen with nothing visible to explain the difference.
 *
 * The double records the `where` rather than applying it, the discipline the
 * rest of this file uses: the rows are the (RLS-scoped) client's answer, and
 * what this layer decides is only what it asked for.
 */
describe('composeDisplay — Trash', () => {
  const recordingDb = (calls: unknown[]) =>
    ({
      document: {
        findMany: async (args: { where: unknown }) => {
          calls.push(args.where);
          return DOCS;
        },
      },
      bankTransaction: { findMany: async () => [] },
      chase: { findMany: async () => [] },
    }) as unknown as ScopedClient;

  test('⚠ a documents table asks for deletedAt: null alongside archivedAt: null', async () => {
    const calls: unknown[] = [];
    await composeDisplay(recordingDb(calls), 'biz_1', { kind: 'table', subject: 'documents' });

    // Two different columns. `archivedAt: null` excludes none of Trash.
    expect(calls[0]).toEqual({ businessId: 'biz_1', archivedAt: null, deletedAt: null });
  });

  test('⚠ the bar chart is the SAME query, so a deleted document cannot inflate a bar', async () => {
    const calls: unknown[] = [];
    await composeDisplay(recordingDb(calls), 'biz_1', { kind: 'barChart', subject: 'documents' });

    expect(calls[0]).toEqual({ businessId: 'biz_1', archivedAt: null, deletedAt: null });
  });
});

/**
 * #233 + #231 together: the statements question whose honest answer is a table.
 * D40 makes the uploaded statement the ONLY bank input, so "which statements
 * has this client sent and were they complete?" is a pipeline question, and the
 * cell that matters is D41's verdict — spelled the same way the grounding line
 * spells it, by the same `readVerdict`.
 */
describe('composeDisplay — statements', () => {
  test('a statements table carries period, a COUNT of lines as digits, and the verdict in plain words', async () => {
    const block = await composeDisplay(db({ statements: STATEMENTS }), 'biz_1', { kind: 'table', subject: 'statements' });

    expect(block!.kind).toBe('table');
    expect(block!.title).toBe('Bank statements');
    expect(block!.columns!.map((c) => c.cellType)).toEqual(['date', 'date', 'count', 'text']);
    expect(block!.rows![0]).toEqual(['2026-08-01', '2026-08-31', '128', 'proven']);
    expect(block!.rows![1]).toEqual(['2026-07-01', '2026-07-31', '96', 'checked and failed']);
  });

  test('⚠ an unreadable gapAnalysis is "could not be checked" — never "proven" — and unknowns stay empty', async () => {
    const block = await composeDisplay(db({ statements: STATEMENTS }), 'biz_1', { kind: 'table', subject: 'statements' });

    // Period and row count unknown → empty strings, not '0' or a made-up date.
    expect(block!.rows![2]).toEqual(['', '', '', 'could not be checked']);
    expect(JSON.stringify(block)).not.toContain('"0"');
  });

  test('the bar chart tallies VERDICTS, insertion-ordered, and carries no money', async () => {
    const block = await composeDisplay(db({ statements: STATEMENTS }), 'biz_1', { kind: 'barChart', subject: 'statements' });

    expect(block!.title).toBe('Statements by completeness');
    expect(block!.bars).toEqual([
      { label: 'proven', count: 1 },
      { label: 'checked and failed', count: 1 },
      { label: 'could not be checked', count: 1 },
    ]);
    expect(block!.columns).toBeUndefined();
    expect(block!.rows).toBeUndefined();
  });

  test('a client with no statements gets NO block — the words say "not uploaded yet", a table would claim more', async () => {
    expect(await composeDisplay(db({}), 'biz_1', { kind: 'table', subject: 'statements' })).toBeNull();
    expect(await composeDisplay(db({}), 'biz_1', { kind: 'barChart', subject: 'statements' })).toBeNull();
  });

  test('the read is the same order and cap as the grounding window, so the chat and the Bank tab agree', async () => {
    const calls: unknown[] = [];
    const recording = {
      ...db({}),
      statement: {
        findMany: async (args: unknown) => {
          calls.push(args);
          return STATEMENTS;
        },
      },
    } as unknown as ScopedClient;

    await composeDisplay(recording, 'biz_1', { kind: 'table', subject: 'statements' });

    expect(calls[0]).toMatchObject({
      where: { businessId: 'biz_1' },
      orderBy: [{ periodEnd: 'desc' }, { createdAt: 'desc' }],
      take: 40,
    });
  });
});

/**
 * Every value in a block is the server's, and so is every TITLE — which makes
 * the titles the one place this module writes prose a user reads. The
 * `ExportView.test.tsx` vocabulary rule (D42, now D50's export lane): nothing
 * on this surface may imply something was posted, synced or sent to a ledger.
 * Also pinned: no model text can reach a block, because `composeDisplay` is
 * never handed the model's reply — its signature cannot carry one.
 */
describe('composeDisplay — what a block may say', () => {
  const FULL = {
    documents: DOCS,
    transactions: [
      {
        descriptionRaw: 'JUST EAT PAYOUT',
        merchantName: null,
        amountPence: 284155,
        bookedAt: new Date('2026-08-25T00:00:00Z'),
        matchState: 'UNMATCHED',
      },
    ],
    chases: [{ state: 'OPEN', createdAt: new Date('2026-08-20T00:00:00Z'), detectionEngine: 'deterministic' }],
    statements: STATEMENTS,
  };
  const SUBJECTS = ['documents', 'bankTransactions', 'chases', 'statements'] as const;
  const KINDS = ['table', 'barChart'] as const;
  const FORBIDDEN = [/publish(ing|ed)? to/i, /\bsync(ed|ing)?\b/i, /\bposted to\b/i, /\bXero\b/i, /\bQuickBooks\b/i, /\bledger\b/i];

  test('no title or column name claims a ledger write, for every subject and kind', async () => {
    for (const subject of SUBJECTS) {
      for (const kind of KINDS) {
        const block = await composeDisplay(db(FULL), 'biz_1', { kind, subject });
        const prose = [block!.title, ...(block!.columns ?? []).map((c) => c.name)].join(' ');
        for (const forbidden of FORBIDDEN) expect(prose).not.toMatch(forbidden);
      }
    }
  });

  test('every pence cell is a signed integer in digits, never a float or a formatted amount', async () => {
    for (const subject of ['documents', 'bankTransactions'] as const) {
      const block = await composeDisplay(db(FULL), 'biz_1', { kind: 'table', subject });
      const penceColumns = block!.columns!.flatMap((c, i) => (c.cellType === 'pence' ? [i] : []));
      expect(penceColumns.length).toBeGreaterThan(0);
      for (const row of block!.rows!) {
        for (const i of penceColumns) expect(row[i]).toMatch(/^(-?\d+)?$/);
      }
    }
  });

  test('every count cell and every bar is a non-negative integer', async () => {
    const table = await composeDisplay(db(FULL), 'biz_1', { kind: 'table', subject: 'statements' });
    const countColumns = table!.columns!.flatMap((c, i) => (c.cellType === 'count' ? [i] : []));
    for (const row of table!.rows!) for (const i of countColumns) expect(row[i]).toMatch(/^\d*$/);

    for (const subject of SUBJECTS) {
      const chart = await composeDisplay(db(FULL), 'biz_1', { kind: 'barChart', subject });
      for (const bar of chart!.bars!) {
        expect(Number.isInteger(bar.count)).toBe(true);
        expect(bar.count).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
