import { describe, expect, test } from 'vitest';

import { assessCompleteness } from './completeness.js';
import { parseMoneyPence, parseStatement, parseStatementDate } from './statement-parser.js';

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

/* ── PDF ──────────────────────────────────────────────────────────────────── */

/**
 * A minimal, uncompressed, text-based statement PDF, built here rather than
 * committed as a binary fixture: the point of the test is the reader's grammar,
 * and a fixture nobody can read in a diff hides what it is exercising.
 */
function statementPdf(rows: string[][], xs: number[]): Buffer {
  let content = 'BT /F1 10 Tf\n';
  rows.forEach((cells, r) => {
    const y = 700 - r * 20;
    cells.forEach((c, i) => {
      if (c === '') return;
      content += `1 0 0 1 ${xs[i]} ${y} Tm (${c}) Tj\n`;
    });
  });
  content += 'ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => {
    pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

const PDF_COLUMNS = [60, 140, 320, 400, 480];
/** The middle row deliberately leaves BOTH money columns empty. */
const PDF_ROWS = [
  ['Date', 'Description', 'Paid out', 'Paid in', 'Balance'],
  ['01/04/2026', 'BALANCE BROUGHT FORWARD', '', '', '1000.00'],
  ['02/04/2026', 'BIDFOOD LTD', '150.00', '', '850.00'],
  ['03/04/2026', 'CARD PAYMENT', '', '250.00', '1100.00'],
];

describe('a text-based PDF statement', () => {
  test('parses to exactly what the same statement as CSV parses to', () => {
    const result = parseStatement(statementPdf(PDF_ROWS, PDF_COLUMNS), 'statement.pdf');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.statement.rows).toHaveLength(2);
    expect(result.statement.rows[0]?.amountPence).toBe(-15_000);
    expect(result.statement.rows[1]?.amountPence).toBe(25_000);
    expect(result.statement.openingBalancePence).toBe(100_000);
    expect(result.statement.closingBalancePence).toBe(110_000);
  });

  test('an EMPTY cell does not slide the columns left', () => {
    // The whole reason columns are keyed on x. A PDF emits nothing at all for
    // an empty cell, so reading runs positionally would put the closing balance
    // under "Paid out" — plausible numbers, wrong books.
    const result = parseStatement(statementPdf(PDF_ROWS, PDF_COLUMNS), 'statement.pdf');
    if (!result.ok) throw new Error('expected a parse');
    expect(result.statement.rows[0]?.balanceAfterPence).toBe(85_000);
    expect(result.statement.rows[1]?.balanceAfterPence).toBe(110_000);
  });

  test('the completeness proof survives the format', () => {
    const result = parseStatement(statementPdf(PDF_ROWS, PDF_COLUMNS), 'statement.pdf');
    if (!result.ok) throw new Error('expected a parse');
    const report = assessCompleteness(result.statement);
    expect(report.assurance).toBe('complete');
    expect(report.provenBy).toBe('balanceContinuity');
  });

  test('a scan — a PDF with no text — is refused, not half-read', () => {
    // It needs OCR, which is the extraction lane's job. Returning zero rows
    // silently would report an unreadable statement as an empty one.
    const scan = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF', 'latin1');
    const result = parseStatement(scan, 'scan.pdf');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({ reason: 'unreadable', detail: 'noTextFound' });
  });

  test('a password-protected PDF says so rather than reading noise', () => {
    const enc = Buffer.from('%PDF-1.4\ntrailer << /Encrypt 9 0 R >>\n%%EOF', 'latin1');
    const result = parseStatement(enc, 'locked.pdf');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({ reason: 'unreadable', detail: 'encrypted' });
  });
});
