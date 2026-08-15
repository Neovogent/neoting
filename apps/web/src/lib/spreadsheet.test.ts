import { describe, expect, it } from 'vitest';

import { analyseSheet, mapColumns, parseAmount, parseDelimited, sniffDelimiter, sniffSheet } from './spreadsheet';

/**
 * Reading a sheet is where money is quietly lost: a European "2.000,00" read
 * as 2, a Net column claimed as the total, a quoted comma splitting a row in
 * half. Each case below is one of those, not a shape assertion.
 */

describe('parseAmount', () => {
  it('reads what a UK export writes', () => {
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount('£1,420.50')).toBe(1420.5);
    expect(parseAmount('850.20')).toBe(850.2);
    expect(parseAmount('0.01')).toBe(0.01);
  });

  it('reads the European layout without losing a factor of a thousand', () => {
    expect(parseAmount('2.000,00')).toBe(2000);
    expect(parseAmount('10 000,50')).toBe(10000.5);
    expect(parseAmount('1.234.567,89')).toBe(1234567.89);
  });

  it('tells a thousands comma from a decimal comma by what follows it', () => {
    expect(parseAmount('1,234')).toBe(1234);
    expect(parseAmount('12,5')).toBe(12.5);
  });

  it('reads accounting negatives — brackets and a trailing DR', () => {
    expect(parseAmount('(1,234.56)')).toBe(-1234.56);
    expect(parseAmount('100.00 DR')).toBe(-100);
    expect(parseAmount('100.00 CR')).toBe(100);
    expect(parseAmount('-45.00')).toBe(-45);
  });

  it('strips currency symbols and codes', () => {
    expect(parseAmount('$99.99')).toBe(99.99);
    expect(parseAmount('EUR 1.500,00')).toBe(1500);
    expect(parseAmount('GBP 20.00')).toBe(20);
  });

  it('returns nothing for a cell that is not money, rather than NaN', () => {
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('   ')).toBe(0);
    expect(parseAmount(undefined)).toBe(0);
    expect(parseAmount('n/a')).toBe(0);
    expect(parseAmount('Bidfood UK')).toBe(0);
  });
});

describe('parseDelimited', () => {
  it('keeps a quoted comma inside its own field', () => {
    expect(parseDelimited('a,"b,c",d\n')).toEqual([['a', 'b,c', 'd']]);
  });

  it('reads a doubled quote as one quote', () => {
    expect(parseDelimited('name,note\nBooker,"they said ""yes"""\n')).toEqual([
      ['name', 'note'],
      ['Booker', 'they said "yes"'],
    ]);
  });

  it('keeps a newline inside a quoted field on the same row', () => {
    expect(parseDelimited('a,"line one\nline two",c')).toEqual([['a', 'line one\nline two', 'c']]);
  });

  it('survives CRLF endings and a trailing line without one', () => {
    expect(parseDelimited('a,b\r\nc,d\r\ne,f')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });

  it('drops spacer rows and the BOM Excel writes', () => {
    expect(parseDelimited('﻿Date,Total\n\n01/08/2026,10.00\n,\n')).toEqual([
      ['Date', 'Total'],
      ['01/08/2026', '10.00'],
    ]);
  });
});

describe('sniffDelimiter', () => {
  it('picks the separator the export actually used', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(sniffDelimiter('a\tb\tc')).toBe('\t');
    expect(sniffDelimiter('a|b|c')).toBe('|');
  });

  it('falls back to a comma when there is nothing to go on', () => {
    expect(sniffDelimiter('justonecolumn')).toBe(',');
    expect(sniffDelimiter('')).toBe(',');
  });
});

describe('mapColumns', () => {
  it('gives the amount role the gross column, not the first number it sees', () => {
    // Net · VAT · Total is the ordinary purchase layout. Matching header by
    // header instead of role by role books every line at its net value.
    const { mapping } = mapColumns(['Date', 'Supplier', 'Net', 'VAT', 'Total']);

    expect(mapping.amount).toBe(4);
    expect(mapping.tax).toBe(3);
    expect(mapping.party).toBe(1);
    expect(mapping.date).toBe(0);
  });

  it('never gives one column to two roles', () => {
    const { mapping } = mapColumns(['Date', 'Description', 'Money In', 'Money Out', 'Balance']);
    const claimed = Object.values(mapping);

    expect(new Set(claimed).size).toBe(claimed.length);
    expect(mapping.moneyIn).toBe(2);
    expect(mapping.moneyOut).toBe(3);
    expect(mapping.balance).toBe(4);
  });

  it('reports the headings it could not place so the UI can say what was ignored', () => {
    const { unmapped } = mapColumns(['Date', 'Supplier', 'Total', 'Cost centre', 'Approved by']);

    expect(unmapped).toEqual(['Cost centre', 'Approved by']);
  });

  it('tolerates the whitespace real headers carry', () => {
    const { mapping } = mapColumns(['  Date ', 'Supplier   Name', ' Total  ']);

    expect(mapping.date).toBe(0);
    expect(mapping.amount).toBe(2);
  });
});

describe('sniffSheet', () => {
  it('calls a running balance beside paid-in and paid-out a bank export', () => {
    const headers = ['Date', 'Description', 'Money In', 'Money Out', 'Balance'];
    const { mapping } = mapColumns(headers);

    expect(sniffSheet(headers, mapping).kind).toBe('bank');
  });

  it('calls a listing with names and amounts a set of documents', () => {
    const headers = ['Date', 'Supplier', 'Category', 'Total'];
    const { mapping } = mapColumns(headers);

    expect(sniffSheet(headers, mapping).kind).toBe('documents');
  });
});

describe('analyseSheet', () => {
  it('finds the header under the account preamble an export opens with', () => {
    const csv = [
      'Statement of account',
      'Sort code,20-45-77',
      'Date,Description,Money In,Money Out,Balance',
      '02/08/2026,BIDFOOD UK LTD,,1420.50,3000.00',
    ].join('\n');

    const analysis = analyseSheet(parseDelimited(csv));

    expect(analysis.headers).toEqual(['Date', 'Description', 'Money In', 'Money Out', 'Balance']);
    expect(analysis.kind).toBe('bank');
    expect(analysis.rows).toEqual([['02/08/2026', 'BIDFOOD UK LTD', '', '1420.50', '3000.00']]);
  });

  it('says so rather than throwing when the file is empty', () => {
    const analysis = analyseSheet([]);

    expect(analysis.rows).toEqual([]);
    expect(analysis.headers).toEqual([]);
    expect(analysis.reason).toContain('empty');
  });
});
