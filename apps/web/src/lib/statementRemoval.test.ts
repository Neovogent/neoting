import { describe, expect, test } from 'vitest';

import { summariseRemoval } from './statementRemoval';
import type { Statement } from './types';

const statement = (over: Partial<Statement>): Statement => ({
  id: 'st_1',
  clientId: '1',
  clientName: 'American Burger Ltd',
  accountId: 'acc_1',
  fileName: 'july.csv',
  period: '1 – 31 Jul 2026',
  openingBalance: 0,
  closingBalance: 0,
  rows: 0,
  status: 'extracted',
  uploadedAt: 'today',
  ...over,
});

describe('summariseRemoval', () => {
  test('states the real blast radius: statement count and every imported row', () => {
    const summary = summariseRemoval([
      statement({ id: 'a', fileName: 'july.csv', rows: 1144 }),
      statement({ id: 'b', fileName: 'august.pdf', rows: 143 }),
    ]);
    expect(summary.count).toBe(2);
    // 1,144 + 143 — the number the dialog must say. A generic "Are you sure?"
    // over a thousand-row import is what this exists to prevent.
    expect(summary.totalRows).toBe(1287);
    expect(summary.namedFiles).toEqual(['july.csv', 'august.pdf']);
    expect(summary.moreCount).toBe(0);
  });

  test('names at most three files and counts the rest honestly', () => {
    const summary = summariseRemoval(
      ['a.csv', 'b.csv', 'c.csv', 'd.csv', 'e.csv'].map((fileName, i) =>
        statement({ id: String(i), fileName, rows: 1 }),
      ),
    );
    expect(summary.namedFiles).toEqual(['a.csv', 'b.csv', 'c.csv']);
    expect(summary.moreCount).toBe(2);
    expect(summary.totalRows).toBe(5);
  });

  test('a still-processing statement contributes its honest zero rows', () => {
    const summary = summariseRemoval([statement({ status: 'processing', rows: 0 })]);
    expect(summary.count).toBe(1);
    expect(summary.totalRows).toBe(0);
  });
});
