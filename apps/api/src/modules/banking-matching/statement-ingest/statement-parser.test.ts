import { describe, expect, test } from 'vitest';

import { assessCompleteness } from './completeness.js';
import {
  parseMoneyPence,
  parseStatement,
  parseStatementDate,
  parseStatementGrid,
} from './statement-parser.js';

const csv = (text: string): Buffer => Buffer.from(text, 'utf8');

describe('money', () => {
  test('pounds and pence become integer pence', () => {
    expect(parseMoneyPence('£1,234.56')).toBe(123456);
    expect(parseMoneyPence('0.05')).toBe(5);
    expect(parseMoneyPence('12')).toBe(1200);
  });

  test('a negative is negative however the bank writes it', () => {
    // Three conventions, one answer. Accounting parentheses are the one most
    // often missed, and reading `(12.34)` as positive inverts a payment.
    expect(parseMoneyPence('-12.34')).toBe(-1234);
    expect(parseMoneyPence('12.34-')).toBe(-1234);
    expect(parseMoneyPence('(12.34)')).toBe(-1234);
  });

  test('the European form is not read as English', () => {
    // THE trap. `1.234,56` is one thousand two hundred; read with English rules
    // it is £1.23 and the statement is out by three orders of magnitude.
    expect(parseMoneyPence('1.234,56')).toBe(123456);
    expect(parseMoneyPence('1,234.56')).toBe(123456);
  });

  test('a single separator is decided by what follows it', () => {
    expect(parseMoneyPence('1,234')).toBe(123400);
    expect(parseMoneyPence('12,34')).toBe(1234);
  });

  test('more than two decimal places is REFUSED, never rounded', () => {
    // A silently rounded statement does not reconcile, and the accountant hunts
    // the penny rather than the file. `12.345` is deliberately NOT this case —
    // exactly three trailing digits is thousands grouping (£12,345), which is
    // how every bank writes it.
    expect(parseMoneyPence('12.3456')).toBeNull();
    expect(parseMoneyPence('1,234.567')).toBeNull();
    expect(parseMoneyPence('12.345')).toBe(1234500);
  });

  test('non-money is null rather than zero', () => {
    expect(parseMoneyPence('')).toBeNull();
    expect(parseMoneyPence('n/a')).toBeNull();
  });

  test('TWO numbers in one cell are REFUSED, never read as one', () => {
    // Textract fused a credit and its balance into one cell on a real
    // statement. Stripping the space would read `25.97 17,321.32` as
    // £259,717,321.32 — a fake amount with no balance beside it, which is the
    // one shape the continuity check cannot interrogate.
    expect(parseMoneyPence('25.97 17,321.32')).toBeNull();
    expect(parseMoneyPence('1.00 2.00 3.00')).toBeNull();
    // The cost, accepted deliberately: space-grouped forms are refused too.
    // A refusal surfaces as a skipped line; a misread never surfaces at all.
    expect(parseMoneyPence('1 234,56')).toBeNull();
    // A currency symbol set off by a space is still fine — the refusal is
    // only for whitespace BETWEEN digit-ish characters.
    expect(parseMoneyPence('£ 12.34')).toBe(1234);
  });
});

describe('dates', () => {
  test('UK day-first', () => {
    expect(parseStatementDate('05/04/2026')).toBe('2026-04-05');
    expect(parseStatementDate('5.4.26')).toBe('2026-04-05');
  });

  test('a second component above 12 forces month-first', () => {
    expect(parseStatementDate('04/25/2026')).toBe('2026-04-25');
  });

  test('ISO passes through', () => {
    expect(parseStatementDate('2026-04-05')).toBe('2026-04-05');
  });

  test('an Excel serial resolves through the 1900 leap-year quirk', () => {
    // 46117 is 2026-04-05 in every spreadsheet, because they all reproduce the
    // non-existent 1900-02-29.
    expect(parseStatementDate('46117')).toBe('2026-04-05');
  });

  test('a small integer is a reference number, not a date in 1902', () => {
    expect(parseStatementDate('42')).toBeNull();
  });

  test('a named month reads', () => {
    expect(parseStatementDate('5 Apr 2026')).toBe('2026-04-05');
  });
});

describe('parsing a statement', () => {
  const withBalance = csv(
    [
      'Barclays Bank plc',
      'Account: 12345678   Sort code: 20-00-00',
      '',
      'Date,Description,Paid out,Paid in,Balance',
      '01/04/2026,OPENING,,,1000.00',
      '02/04/2026,BIDFOOD LTD,150.00,,850.00',
      '03/04/2026,CARD PAYMENT,,250.00,1100.00',
    ].join('\n'),
  );

  test('the header row is found beneath the bank preamble', () => {
    const result = parseStatement(withBalance, 'april.csv');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.statement.mapping.headerRow).toBe(3);
    // Three data lines, of which the first is brought-forward.
    expect(result.statement.rows).toHaveLength(2);
  });

  test('paid out is NEGATIVE and paid in is positive', () => {
    // Getting this backwards files every payment as income. It looks entirely
    // normal on screen and inverts the client's books.
    const result = parseStatement(withBalance, 'april.csv');
    if (!result.ok) throw new Error('expected a parse');
    expect(result.statement.rows[0]?.amountPence).toBe(-15000);
    expect(result.statement.rows[1]?.amountPence).toBe(25000);
  });

  test('the period and the opening balance are derived, not assumed', () => {
    const result = parseStatement(withBalance, 'april.csv');
    if (!result.ok) throw new Error('expected a parse');
    // The OPENING line is brought-forward, not a transaction, so the period
    // starts at the first real movement.
    expect(result.statement.periodStart).toBe('2026-04-02');
    expect(result.statement.periodEnd).toBe('2026-04-03');
    // Taken from the bank's own brought-forward line, not derived.
    expect(result.statement.openingBalancePence).toBe(100000);
    expect(result.statement.closingBalancePence).toBe(110000);
  });

  test('a quoted description containing the delimiter survives', () => {
    const file = csv(
      ['Date,Description,Amount', '01/04/2026,"BIDFOOD LTD, LONDON",-150.00'].join('\n'),
    );
    const result = parseStatement(file, 'q.csv');
    if (!result.ok) throw new Error('expected a parse');
    expect(result.statement.rows[0]?.description).toBe('BIDFOOD LTD, LONDON');
  });

  test('a semicolon export is not read as one column', () => {
    const file = csv(['Date;Description;Amount', '01/04/2026;BIDFOOD;-150,00'].join('\n'));
    const result = parseStatement(file, 'eu.csv');
    if (!result.ok) throw new Error('expected a parse');
    expect(result.statement.rows[0]?.amountPence).toBe(-15000);
  });

  test('a trailer row without a date is ignored, not reported', () => {
    const file = csv(
      ['Date,Description,Amount', '01/04/2026,BIDFOOD,-150.00', ',Total,-150.00'].join('\n'),
    );
    const result = parseStatement(file, 't.csv');
    if (!result.ok) throw new Error('expected a parse');
    // It carries money, so it IS reported — a line with an amount and no date
    // is a transaction that would otherwise vanish.
    expect(result.statement.skipped).toHaveLength(1);
    expect(result.statement.skipped[0]?.reason).toBe('noDate');
  });

  test('a PDF renamed .xlsx is refused by name, not mis-parsed', () => {
    const result = parseStatement(Buffer.from('%PDF-1.7 not a zip'), 'statement.xlsx');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({ reason: 'unreadable', detail: 'notAZipFile' });
  });

  test('a format this does not read is refused by NAME, before any parsing', () => {
    // PDF, CSV and XLSX are the three D40 names. Anything else is refused on
    // the extension, so the message can say what IS accepted instead of
    // reporting a failure to parse something we never intended to.
    const result = parseStatement(Buffer.from('PK'), 'statement.docx');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('unsupportedFormat');
  });

  test('a file with no recognisable table refuses rather than inventing rows', () => {
    const result = parseStatement(csv('hello\nworld'), 'x.csv');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('noHeaderRow');
  });
});

describe('the D41 completeness gate', () => {
  const parse = (text: string) => {
    const result = parseStatement(csv(text), 's.csv');
    if (!result.ok) throw new Error(`expected a parse: ${JSON.stringify(result.failure)}`);
    return result.statement;
  };

  test('continuous balances prove completeness', () => {
    const report = assessCompleteness(
      parse(
        [
          'Date,Description,Amount,Balance',
          '01/04/2026,A,-100.00,900.00',
          '02/04/2026,B,-50.00,850.00',
        ].join('\n'),
      ),
    );
    expect(report.assurance).toBe('complete');
    expect(report.provenBy).toBe('balanceContinuity');
    expect(report.findings).toHaveLength(0);
  });

  test('a broken balance chain is proof a transaction is MISSING', () => {
    // 900 − 50 is 850, and the statement claims 800. The £50 difference is a
    // line the file does not show, and this is the whole point of the gate.
    const report = assessCompleteness(
      parse(
        [
          'Date,Description,Amount,Balance',
          '01/04/2026,A,-100.00,900.00',
          '02/04/2026,B,-50.00,800.00',
        ].join('\n'),
      ),
    );
    expect(report.assurance).toBe('incomplete');
    expect(report.provenBy).toBeNull();
    const break_ = report.findings.find((f) => f.kind === 'balanceBreak');
    expect(break_?.sourceLine).toBe(3);
    expect(break_?.detail).toContain('£850.00');
  });

  test('no balance column is REDUCED assurance, never complete', () => {
    // D41 names this a distinct class. Reporting it as complete would be a
    // green tick meaning "we did not look".
    const report = assessCompleteness(
      parse(['Date,Description,Amount', '01/04/2026,A,-100.00'].join('\n')),
    );
    expect(report.assurance).toBe('reduced');
    expect(report.provenBy).toBeNull();
    expect(report.findings.some((f) => f.kind === 'noBalanceColumn')).toBe(true);
  });

  test('a dropped line outranks a clean balance chain', () => {
    // The remaining rows may add up perfectly and still be missing one.
    const report = assessCompleteness(
      parse(
        [
          'Date,Description,Amount,Balance',
          '01/04/2026,A,-100.00,900.00',
          ',ORPHAN,-25.00,',
          '02/04/2026,B,-50.00,850.00',
        ].join('\n'),
      ),
    );
    expect(report.assurance).toBe('incomplete');
    expect(report.findings.some((f) => f.kind === 'skippedLine')).toBe(true);
  });

  test('an exact repeat is surfaced, because the other cause is a doubled export', () => {
    const report = assessCompleteness(
      parse(
        ['Date,Description,Amount', '01/04/2026,COFFEE,-3.50', '01/04/2026,COFFEE,-3.50'].join('\n'),
      ),
    );
    expect(report.findings.some((f) => f.kind === 'duplicateLine')).toBe(true);
  });

  test('a backwards date is reported', () => {
    const report = assessCompleteness(
      parse(['Date,Description,Amount', '02/04/2026,A,-1.00', '01/04/2026,B,-1.00'].join('\n')),
    );
    expect(report.findings.some((f) => f.kind === 'dateOutOfOrder')).toBe(true);
  });
});

/* ── A PDF, which this module no longer reads itself ──────────────────────── */

describe('a PDF statement', () => {
  test('parseStatement REFUSES it, by name', () => {
    // A hand-rolled PDF text extractor used to stand here. It read only
    // born-digital files (a scanned statement has no text objects at all), and
    // on a real 29-page statement it dropped 80 of 1,250 transactions and never
    // found the balance column — so under D41 it could only ever report
    // `reduced`. D20 commits this job to Textract, and the routing happens one
    // level up in `statement-ingest.ts`. THIS module is the spreadsheet door.
    const result = parseStatement(Buffer.from('%PDF-1.4', 'latin1'), 'april.pdf');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('unsupportedFormat');
  });

  test('the grid a table reader recovers parses to exactly what the CSV parses to', () => {
    // The point of the seam: the reader changes, the interpretation does not.
    // Same statement, same numbers, same D41 verdict — whichever door it came
    // through.
    const grid = [
      ['Barclays Bank plc'],
      ['Account: 12345678   Sort code: 20-00-00'],
      [],
      ['Date', 'Description', 'Paid out', 'Paid in', 'Balance'],
      ['01/04/2026', 'BALANCE BROUGHT FORWARD', '', '', '1000.00'],
      ['02/04/2026', 'BIDFOOD LTD', '150.00', '', '850.00'],
      ['03/04/2026', 'CARD PAYMENT', '', '250.00', '1100.00'],
    ];

    const result = parseStatementGrid(grid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.statement.rows).toHaveLength(2);
    // Paid out NEGATIVE, paid in positive — the sign convention that inverts a
    // client's books if the recovered grid ever shifts a column.
    expect(result.statement.rows[0]?.amountPence).toBe(-15000);
    expect(result.statement.rows[1]?.amountPence).toBe(25000);
    // The empty money cells did NOT slide the balance one column left.
    expect(result.statement.rows[0]?.balanceAfterPence).toBe(85_000);
    expect(result.statement.rows[1]?.balanceAfterPence).toBe(110_000);
    expect(assessCompleteness(result.statement).assurance).toBe('complete');
  });

  test('a grid with no header row is a refusal, never an empty statement', () => {
    // Textract answering with a table that is not a statement — a summary box,
    // an address block — must not read as "this month had no transactions".
    const result = parseStatementGrid([['Your statement'], ['Thank you for banking with us']]);
    expect(result.ok).toBe(false);
  });
});

/* ── A fused header cell, which Textract actually produces ────────────────── */

describe('a fused CREDIT BALANCE header', () => {
  // Verbatim from a real Textract read of a 29-page statement: the header's
  // last TWO column names came back as ONE cell, and the data rows under it
  // came back BOTH ways in the same document — some pages one cell short with
  // the two values fused, other pages at full width. Before this was handled,
  // every credit was skipped as "has no amount" and the balance column did not
  // exist, so a perfectly ordinary statement reported 77 dropped lines.
  const header = ['DATE', 'DESCRIPTION', 'REFERENCE', 'DEBIT', 'CREDIT BALANCE'];

  test('the fused cell maps as TWO logical columns', () => {
    const result = parseStatementGrid([
      ['Account holder', 'Account number', 'Sort code', 'Statement period'],
      ['Alex Morgan (FICTIONAL)', 'TEST-4827-1903-6651', '99-88-77', '01/08/2025 31/07/2026'],
      header,
      ['01/08/2025', 'CARD PAYMENT AMAZON UK MARKETPLACE', 'NMB2508010000121', '22.75', '18,429.98'],
    ]);
    if (!result.ok) throw new Error('expected a parse');
    expect(result.statement.mapping).toEqual({
      date: 0,
      description: 1,
      amount: null,
      paidOut: 3,
      paidIn: 4,
      balance: 5,
      headerRow: 2,
      fusedAmountBalance: 4,
    });
  });

  test('the three row shapes the real read produced all parse, signed correctly', () => {
    const result = parseStatementGrid([
      header,
      // One short, movement under DEBIT: the lone fused value is the BALANCE.
      ['01/08/2025', 'CARD PAYMENT AMAZON UK MARKETPLACE', 'NMB2508010000121', '22.75', '18,429.98'],
      // One short, credit and balance fused into one cell.
      ['06/08/2025', 'BANK TRANSFER RECEIVED A ROBERTS', 'NMB2508060001715', '', '25.97 17,321.32'],
      // Full width — already logical, read as-is.
      ['01/10/2025', 'SALARY - NORTHSTAR CONSULTING LTD', 'NMB2510010020834', '', '3,817.96', '16,868.22'],
    ]);
    if (!result.ok) throw new Error('expected a parse');
    expect(result.statement.skipped).toHaveLength(0);
    const [debit, fusedCredit, fullCredit] = result.statement.rows;
    expect(debit?.amountPence).toBe(-2275);
    expect(debit?.balanceAfterPence).toBe(1_842_998);
    expect(fusedCredit?.amountPence).toBe(2597);
    expect(fusedCredit?.balanceAfterPence).toBe(1_732_132);
    expect(fullCredit?.amountPence).toBe(381_796);
    expect(fullCredit?.balanceAfterPence).toBe(1_686_822);
  });

  test('a consistent statement mixing both page shapes proves COMPLETE', () => {
    const result = parseStatementGrid([
      header,
      ['Page opening', 'balance: GBP 1,000.00 / Transactions 1-4', '', '', ''],
      ['01/08/2025', 'CARD PAYMENT AMAZON UK MARKETPLACE', 'REF1', '150.00', '850.00'],
      ['02/08/2025', 'BANK TRANSFER RECEIVED A ROBERTS', 'REF2', '', '250.00 1,100.00'],
      ['03/08/2025', 'SALARY - NORTHSTAR CONSULTING LTD', 'REF3', '', '300.00', '1,400.00'],
      ['04/08/2025', 'ATM CASH WITHDRAWAL MANCHESTER', 'REF4', '100.00', '', '1,300.00'],
      // The bank's own page trailer: no date, no readable money — not a line.
      ['PAGE CLOSING', 'BALANCE', '', '', 'GBP 1,300.00'],
    ]);
    if (!result.ok) throw new Error('expected a parse');
    expect(result.statement.rows).toHaveLength(4);
    expect(result.statement.skipped).toHaveLength(0);
    // Derived by reversing the first row out of its balance — and it agrees
    // with the banner the bank printed, which is the point.
    expect(result.statement.openingBalancePence).toBe(100_000);
    expect(result.statement.closingBalancePence).toBe(130_000);
    const report = assessCompleteness(result.statement);
    expect(report.assurance).toBe('complete');
    expect(report.provenBy).toBe('balanceContinuity');
    expect(report.findings).toHaveLength(0);
  });

  test('a brought-forward line on a fused page is the stated opening, not a credit', () => {
    const result = parseStatementGrid([
      header,
      ['01/08/2025', 'BALANCE BROUGHT FORWARD', 'R0', '', '1,000.00'],
      ['02/08/2025', 'CARD PAYMENT', 'R1', '40.00', '960.00'],
    ]);
    if (!result.ok) throw new Error('expected a parse');
    expect(result.statement.rows).toHaveLength(1);
    expect(result.statement.openingBalancePence).toBe(100_000);
    expect(result.statement.skipped).toHaveLength(0);
  });

  test('the split REFUSES every other shape, and the refusal is surfaced', () => {
    // Three tokens, or tokens that are not money, are never split — a guess
    // here invents a transaction. They surface as skipped lines, and the D41
    // gate refuses the statement on them.
    const result = parseStatementGrid([
      header,
      ['01/08/2025', 'FINE', 'R1', '10.00', '990.00'],
      ['02/08/2025', 'THREE TOKENS', 'R2', '', '1.00 2.00 3.00'],
      ['03/08/2025', 'NOT MONEY', 'R3', '', 'GBP 15,651.64'],
    ]);
    if (!result.ok) throw new Error('expected a parse');
    expect(result.statement.rows).toHaveLength(1);
    expect(result.statement.skipped).toHaveLength(2);
    expect(result.statement.skipped.map((s) => s.reason)).toEqual([
      'unreadableAmount',
      'unreadableAmount',
    ]);
    expect(assessCompleteness(result.statement).assurance).toBe('incomplete');
  });

  test('the vocabulary stays CLOSED — "Balance brought forward" is not a balance column', () => {
    // The fusion split matches both halves against the same anchored regexes,
    // never a loose `includes`. A column NAMED "Balance brought forward" maps
    // to nothing, and the statement honestly reports reduced assurance.
    const result = parseStatementGrid([
      ['Date', 'Description', 'Paid in', 'Balance brought forward'],
      ['01/08/2025', 'A CREDIT', '10.00', ''],
    ]);
    if (!result.ok) throw new Error('expected a parse');
    expect(result.statement.mapping.balance).toBeNull();
    expect(result.statement.mapping.fusedAmountBalance).toBeNull();
    expect(assessCompleteness(result.statement).assurance).toBe('reduced');
  });
});
