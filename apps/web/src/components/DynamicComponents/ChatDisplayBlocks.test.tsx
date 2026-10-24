import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { ChatDisplayBlock } from '@neoting/contracts/model';

import { cellText, ChatDisplayBlocks } from './ChatDisplayBlocks';

/**
 * The renderer for a grounded answer's pictures (#231). What is pinned is the
 * money boundary and the honesty rules, not the styling: a `pence` cell is the
 * ONE place integer pence become pounds on this surface and a `text` cell can
 * never be mistaken for money; an empty cell is an em dash, never a zero; a bar
 * is a count with its number beside it; and nothing rendered claims a ledger
 * write (the `ExportView.test.tsx` D42 copy test, applied here).
 */

const STATEMENTS_TABLE: ChatDisplayBlock = {
  kind: 'table',
  title: 'Bank statements',
  columns: [
    { name: 'Period from', cellType: 'date' },
    { name: 'Period to', cellType: 'date' },
    { name: 'Transactions', cellType: 'count' },
    { name: 'Completeness', cellType: 'text' },
  ],
  rows: [
    ['2026-08-01', '2026-08-31', '128', 'proven'],
    ['', '', '', 'could not be checked'],
  ],
};

const DOCUMENTS_TABLE: ChatDisplayBlock = {
  kind: 'table',
  title: 'Recent documents',
  columns: [
    { name: 'Supplier', cellType: 'text' },
    { name: 'Date', cellType: 'date' },
    { name: 'Total', cellType: 'pence' },
  ],
  rows: [
    ['Bidfood', '2026-08-29', '128450'],
    ['Refund Ltd', '2026-08-30', '-7840'],
    ['1299', '', ''],
  ],
};

const CHART: ChatDisplayBlock = {
  kind: 'barChart',
  title: 'Statements by completeness',
  bars: [
    { label: 'proven', count: 3 },
    { label: 'could not be checked', count: 1 },
    { label: 'checked and failed', count: 0 },
  ],
};

describe('cells render by their declared type', () => {
  test('a pence cell is integer pence rendered as pounds — the one money boundary on this surface', () => {
    expect(cellText('128450', 'pence')).toBe('£1,284.50');
    expect(cellText('-7840', 'pence')).toBe('−£78.40');
    expect(cellText('5', 'pence')).toBe('£0.05');
  });

  test('a text cell that happens to be digits is NOT money, and a count is the digits it is', () => {
    expect(cellText('1299', 'text')).toBe('1299');
    expect(cellText('128', 'count')).toBe('128');
  });

  test('an empty cell is an em dash — never a zero nobody read, whatever the column type', () => {
    for (const type of ['text', 'pence', 'date', 'count'] as const) expect(cellText('', type)).toBe('—');
  });

  test('a date cell renders the UK long-ish form every screen uses', () => {
    expect(cellText('2026-08-01', 'date')).toBe('01 Aug 2026');
  });
});

describe('the table', () => {
  test('renders the statements table with its verdict words and a count, and unknowns as dashes', () => {
    render(<ChatDisplayBlocks blocks={[STATEMENTS_TABLE]} />);

    expect(screen.getByRole('heading', { name: 'Bank statements' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Completeness' })).toBeInTheDocument();
    expect(screen.getByText('proven')).toBeInTheDocument();
    expect(screen.getByText('could not be checked')).toBeInTheDocument();
    expect(screen.getByText('128')).toBeInTheDocument();
    expect(screen.getByText('01 Aug 2026')).toBeInTheDocument();
    // The unknown row: three dashes, not three zeros and not an invented date.
    expect(screen.getAllByText('—')).toHaveLength(3);
    expect(screen.queryByText('0')).toBeNull();
  });

  test('money and text columns cannot be confused — the pence column prints pounds, the digits-only supplier prints verbatim', () => {
    render(<ChatDisplayBlocks blocks={[DOCUMENTS_TABLE]} />);

    expect(screen.getByText('£1,284.50')).toBeInTheDocument();
    expect(screen.getByText('−£78.40')).toBeInTheDocument();
    expect(screen.getByText('1299')).toBeInTheDocument();
    expect(screen.queryByText('£12.99')).toBeNull();
    // Numeric cells are right-aligned by their declared type.
    const total = screen.getByText('£1,284.50');
    expect(total.getAttribute('data-cell-type')).toBe('pence');
    expect(total.className).toContain('text-right');
    expect(screen.getByText('Bidfood').className).not.toContain('text-right');
  });
});

describe('the bar chart', () => {
  test('is inline SVG — no library — with one bar per label, proportional, and the count printed beside it', () => {
    const { container } = render(<ChatDisplayBlocks blocks={[CHART]} />);

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('role')).toBe('img');
    expect(svg!.getAttribute('aria-label')).toBe('Statements by completeness');

    const bars = container.querySelectorAll('g[data-bar]');
    expect(bars).toHaveLength(3);
    const fill = (label: string) =>
      Number(container.querySelector(`g[data-bar="${label}"] rect[data-fill-width]`)!.getAttribute('data-fill-width'));
    expect(fill('proven')).toBe(300);
    expect(fill('could not be checked')).toBe(100);
    expect(fill('checked and failed')).toBe(0);
    // The number is on the picture, so the chart never says more than the count does.
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  test('no literal colour is written — fills come from theme classes via currentColor', () => {
    const { container } = render(<ChatDisplayBlocks blocks={[CHART]} />);
    for (const rect of container.querySelectorAll('rect')) {
      expect(rect.getAttribute('fill')).toBeNull();
      expect(rect.getAttribute('style') ?? '').not.toMatch(/#|rgb/);
    }
    for (const g of container.querySelectorAll('g[fill]')) expect(g.getAttribute('fill')).toBe('currentColor');
  });
});

describe('what the blocks may say (D42 copy test)', () => {
  test('nothing rendered implies a ledger write or names a ledger vendor', () => {
    render(<ChatDisplayBlocks blocks={[STATEMENTS_TABLE, DOCUMENTS_TABLE, CHART]} />);
    const text = document.body.textContent ?? '';
    for (const forbidden of [/publish(ing|ed)? to/i, /\bsync(ed|ing)?\b/i, /\bposted to\b/i, /\bXero\b/i, /\bQuickBooks\b/i, /\bledger\b/i]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  test('every block is a labelled section, so a screen reader hears the title before the data', () => {
    render(<ChatDisplayBlocks blocks={[STATEMENTS_TABLE, CHART]} />);
    expect(screen.getByRole('region', { name: 'Bank statements' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Statements by completeness' })).toBeInTheDocument();
  });
});
