import { describe, expect, it } from 'vitest';

import { analyseSheet, parseDelimited } from './spreadsheet';
import { amountOfRow, defaultKindFor, importSheet, parseSheetDate } from './tableImport';
import { seedClients } from './seed';

/**
 * A spreadsheet import is a hundred documents at once, so a misread column is
 * a hundred wrong records rather than one. The cases here are the ones that
 * actually go wrong: an XLSX date arriving as a serial number, a US-shaped
 * slash date, a totals line becoming a document for the value of the whole
 * month, and a signed ledger where a positive row is a refund.
 */

const client = seedClients[0];
const sheet = (csv: string) => analyseSheet(parseDelimited(csv));

describe('parseSheetDate', () => {
  it('reads an XLSX serial rather than treating it as a reference', () => {
    // Excel's epoch is 1899-12-30, because it believes 1900 was a leap year.
    expect(parseSheetDate('46235')).toBe('01 Aug 2026');
    expect(parseSheetDate('45870')).toBe('01 Aug 2025');
  });

  it('reads a serial with a time fraction as its calendar day', () => {
    expect(parseSheetDate('46235.75')).toBe('01 Aug 2026');
  });

  it('reads ISO unambiguously', () => {
    expect(parseSheetDate('2026-08-10')).toBe('10 Aug 2026');
    expect(parseSheetDate('2026-01-31')).toBe('31 Jan 2026');
  });

  it('reads a slash date day-first, because this is a UK product', () => {
    expect(parseSheetDate('03/08/2026')).toBe('03 Aug 2026');
    expect(parseSheetDate('08/03/2026')).toBe('08 Mar 2026');
    expect(parseSheetDate('13/08/2026')).toBe('13 Aug 2026');
  });

  it('reads the other separators a sheet uses, and a two-digit year', () => {
    expect(parseSheetDate('03.08.2026')).toBe('03 Aug 2026');
    expect(parseSheetDate('03-08-2026')).toBe('03 Aug 2026');
    expect(parseSheetDate('03/08/26')).toBe('03 Aug 2026');
  });

  it('passes through the format the rest of the pipeline speaks', () => {
    expect(parseSheetDate('12 Aug 2026')).toBe('12 Aug 2026');
    expect(parseSheetDate('  12 Aug 2026  ')).toBe('12 Aug 2026');
  });

  it('refuses a cell that is not a date, so the row is flagged rather than dated wrongly', () => {
    expect(parseSheetDate(undefined)).toBeNull();
    expect(parseSheetDate('')).toBeNull();
    expect(parseSheetDate('   ')).toBeNull();
    expect(parseSheetDate('TOTAL')).toBeNull();
    expect(parseSheetDate('Bidfood UK')).toBeNull();
  });
});

describe('amountOfRow', () => {
  it('takes whichever of the paid-in / paid-out pair carries the value', () => {
    expect(amountOfRow(['', '1420.50'], { moneyIn: 0, moneyOut: 1 })).toBe(1420.5);
    expect(amountOfRow(['4820.75', ''], { moneyIn: 0, moneyOut: 1 })).toBe(4820.75);
  });

  it('reads a single amount column as its magnitude, sign handled elsewhere', () => {
    expect(amountOfRow(['-1420.50'], { amount: 0 })).toBe(1420.5);
    expect(amountOfRow(['(1,420.50)'], { amount: 0 })).toBe(1420.5);
  });

  it('is zero when the row has no money in it', () => {
    expect(amountOfRow(['', ''], { amount: 0 })).toBe(0);
    expect(amountOfRow(['Bidfood UK'], { amount: 0 })).toBe(0);
    expect(amountOfRow(['10.00'], {})).toBe(0);
  });
});

describe('defaultKindFor', () => {
  it('reads the direction off the party column before anything else', () => {
    expect(defaultKindFor(sheet('Date,Customer,Total\n01/08/2026,Deliveroo,10.00'), 'august.csv').kind).toBe('sales');
    expect(defaultKindFor(sheet('Date,Supplier,Total\n01/08/2026,Bidfood,10.00'), 'august.csv').kind).toBe('cost');
  });

  it('falls back to the file name when the columns do not say', () => {
    const anonymous = sheet('Date,Name,Total\n01/08/2026,Deliveroo,10.00');

    expect(defaultKindFor(anonymous, 'sales-august.csv').kind).toBe('sales');
    expect(defaultKindFor(anonymous, 'purchases-august.csv').kind).toBe('cost');
  });

  it('assumes money out when nothing says otherwise, and says that is why', () => {
    const verdict = defaultKindFor(sheet('Date,Name,Total\n01/08/2026,Deliveroo,10.00'), 'august.csv');

    expect(verdict.kind).toBe('cost');
    expect(verdict.reason).toContain('no direction given');
  });
});

describe('importSheet — a purchase listing', () => {
  const csv = [
    'Date,Supplier,Category,Total,VAT',
    '01/08/2026,Bidfood UK,Cost of Sales Food,"1,420.50",236.75',
    '03/08/2026,Costco,,850.20,',
    '13/08/2026,Screwfix Direct,Repairs,99.99,16.67',
    ',,,2370.69,',
  ].join('\n');

  const analysis = sheet(csv);
  const result = importSheet(analysis, 'purchases.csv', client, 'csv', 'shakib@practice.co.uk');

  it('makes one document per row and no bank transactions', () => {
    expect(result.documents).toHaveLength(3);
    expect(result.transactions).toEqual([]);
  });

  it('refuses the totals line instead of booking the month twice', () => {
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.row).toBe(5);
    expect(result.skipped[0]?.reason).toContain('totals line');
    expect(result.documents.map((d) => d.total)).not.toContain(2370.69);
  });

  it('reads the dates day-first and the money exactly', () => {
    expect(result.documents.map((d) => d.date)).toEqual(['01 Aug 2026', '03 Aug 2026', '13 Aug 2026']);
    expect(result.documents.map((d) => d.total)).toEqual([1420.5, 850.2, 99.99]);
  });

  it('sends the row missing its category to review, and the others straight to ready', () => {
    expect(result.documents.map((d) => d.status)).toEqual(['ready', 'review', 'ready']);
    expect(result.documents[1]?.statusNote).toBe('Missing Category');
    expect(result.documents[1]?.category).toBe('—');
  });

  it('names the row a value came from, so it is findable in the original file', () => {
    expect(result.documents[0]?.splitFrom).toBe('purchases.csv — row 2');

    const total = result.documents[0]?.fields.find((f) => f.label === 'Total');
    expect(total?.value).toBe('£1420.50');
    expect(total?.provenance).toBe('row 2, "Total" column');
  });

  it('is honest about which values were read and which were judged', () => {
    const doc = result.documents[0];
    const total = doc?.fields.find((f) => f.label === 'Total');
    const direction = doc?.fields.find((f) => f.label === 'Document type');

    // A figure read out of a column called Total was not inferred from a photo.
    expect(total?.confidence).toBe(0.99);
    // Which way the money went was a judgement, and it says so.
    expect(direction?.confidence).toBe(0.72);
    expect(direction?.provenance).toContain('names suppliers');
  });

  it('carries the client and the channel onto every document', () => {
    expect(result.documents.every((d) => d.clientId === client?.id)).toBe(true);
    expect(result.documents.every((d) => d.source === 'csv' && d.kind === 'cost')).toBe(true);
  });
});

describe('importSheet — a signed sheet', () => {
  const csv = [
    'Date,Supplier,Category,Amount',
    '01/08/2026,Bidfood UK,Cost of Sales Food,-1420.50',
    '02/08/2026,Bidfood UK,Cost of Sales Food,212.40',
  ].join('\n');

  const result = importSheet(sheet(csv), 'transactions.csv', client, 'csv', 'shakib@practice.co.uk');

  it('reads a positive line in a signed sheet as money in, not another cost', () => {
    expect(result.documents.map((d) => d.kind)).toEqual(['cost', 'sales']);
  });

  it('books both at their magnitude', () => {
    expect(result.documents.map((d) => d.total)).toEqual([1420.5, 212.4]);
  });

  it('is confident about the direction when the column states it', () => {
    const direction = result.documents[1]?.fields.find((f) => f.label === 'Document type');

    expect(direction?.confidence).toBe(0.99);
    expect(direction?.value).toContain('Money in');
  });
});

describe('importSheet — a bank export', () => {
  const csv = [
    'Statement of account',
    'Date,Description,Money In,Money Out,Balance',
    '02/08/2026,BIDFOOD UK LTD,,1420.50,3000.00',
    '05/08/2026,DELIVEROO PAYOUT,4820.75,,7820.75',
    ',SUBTOTAL,,1420.50,',
  ].join('\n');

  const analysis = sheet(csv);
  const result = importSheet(analysis, 'statement.csv', client, 'csv', 'shakib@practice.co.uk', 'acct-1-1');

  it('produces transactions rather than documents', () => {
    expect(analysis.kind).toBe('bank');
    expect(result.documents).toEqual([]);
    expect(result.transactions).toHaveLength(2);
  });

  it('signs money out negative, which is how the matcher reads it', () => {
    expect(result.transactions.map((t) => t.amount)).toEqual([-1420.5, 4820.75]);
    expect(result.transactions.map((t) => t.isCredit)).toEqual([false, true]);
  });

  it('skips a subtotal line named as one', () => {
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain('totals line');
  });

  it('files the transactions against the account they were imported for', () => {
    expect(result.transactions.every((t) => t.accountId === 'acct-1-1')).toBe(true);
    expect(result.transactions.map((t) => t.description)).toEqual(['BIDFOOD UK LTD', 'DELIVEROO PAYOUT']);
  });
});

/**
 * Regression (#66). `new Date(y, m, d)` rolls over out-of-range components and
 * the result is a valid Date, so the old `Number.isNaN` guard never fired: an
 * impossible date became a different, plausible one and imported as `ready`
 * with a confident "Document date" on screen.
 *
 * A US-formatted client export is the case that matters — 01/13/2026 was
 * landing in the wrong VAT quarter, silently.
 */
describe('parseSheetDate refuses impossible dates rather than re-dating them', () => {
  it('rejects a month-first US export instead of rolling it into the next year', () => {
    expect(parseSheetDate('01/13/2026')).toBeNull();
  });

  it('rejects a day that does not exist in that month', () => {
    expect(parseSheetDate('32/08/2026')).toBeNull();
    expect(parseSheetDate('31/09/2026')).toBeNull(); // September has 30
    expect(parseSheetDate('30/02/2026')).toBeNull();
  });

  it('accepts a real leap day and rejects one that is not', () => {
    expect(parseSheetDate('29/02/2024')).toBe('29 Feb 2024');
    expect(parseSheetDate('29/02/2026')).toBeNull();
  });

  it('still reads unambiguous day-first dates the UK way', () => {
    expect(parseSheetDate('07/12/2026')).toBe('07 Dec 2026');
  });

  it('applies the same refusal to ISO input, which had the identical rollover', () => {
    expect(parseSheetDate('2026-13-01')).toBeNull();
    expect(parseSheetDate('2026-02-30')).toBeNull();
    expect(parseSheetDate('2026-08-07')).toBe('07 Aug 2026');
  });
});
