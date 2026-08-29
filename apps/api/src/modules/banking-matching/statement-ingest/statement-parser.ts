import { formatFor, readSheet, type Grid, type ReadFailure } from './sheet-reader.js';
import type { OcrFailure } from '../../../common/ocr/document-ocr.js';

/**
 * A bank statement's bytes → the transactions it contains.
 *
 * ## Why this is deterministic and not a model call
 *
 * A CSV or an XLSX has no page to read. Every value is already a value, in a
 * column with a header, and sending that down an OCR/vision path would take a
 * lossless grid, render an opinion about it, and hand back something that can be
 * wrong. D41 gates statement extraction on **provable completeness**, and the
 * only way a count or a balance can be proved is arithmetic over exact input —
 * a model's confidence is not proof. So the rules here are boring on purpose,
 * and every one of them fails loudly rather than guessing.
 *
 * ## Money is integer pence, everywhere, always
 *
 * Nothing in this file produces a float. `£1,234.56` becomes `123456`; a value
 * whose pence cannot be represented exactly is a REFUSAL, not a rounding.
 */

/** One line of the statement, in the shape the persistence step writes. */
export interface ParsedRow {
  /** `YYYY-MM-DD`, UTC. A bare calendar date — no instant is implied. */
  readonly bookedOn: string;
  readonly description: string;
  /** Signed pence. Negative is money OUT, matching `BankTransaction.amountPence`. */
  readonly amountPence: number;
  /** Running balance after this line, when the statement carries one. */
  readonly balanceAfterPence: number | null;
  /** 1-based line in the source grid, so a refusal can name where it was. */
  readonly sourceLine: number;
}

export interface ParsedStatement {
  readonly rows: ParsedRow[];
  /** Earliest and latest `bookedOn`, inclusive. */
  readonly periodStart: string;
  readonly periodEnd: string;
  /**
   * The opening balance implied by the first row: its closing balance minus its
   * own amount. Null when the file carries no balance column — in which case
   * continuity cannot be proved and the completeness gate says so.
   */
  readonly openingBalancePence: number | null;
  readonly closingBalancePence: number | null;
  /** Which columns were used, for the audit trail and for the review card. */
  readonly mapping: ColumnMapping;
  /**
   * Lines that looked like data and could not be read. **Never silently
   * dropped** — D41 exists because a dropped line is a document that is never
   * chased, so these are carried up and the gate refuses on them.
   */
  readonly skipped: SkippedLine[];
}

export interface SkippedLine {
  readonly sourceLine: number;
  readonly reason: 'noDate' | 'noAmount' | 'unreadableAmount';
  /** The row as text, truncated — enough for a human to find it in their file. */
  readonly preview: string;
}

export interface ColumnMapping {
  readonly date: number;
  readonly description: number;
  /** A single signed amount column, when the bank uses one. */
  readonly amount: number | null;
  /** Separate debit/credit columns, when it uses two. */
  readonly paidOut: number | null;
  readonly paidIn: number | null;
  readonly balance: number | null;
  readonly headerRow: number;
}

export type ParseFailure =
  | { reason: 'unsupportedFormat'; fileName: string }
  | { reason: 'unreadable'; detail: ReadFailure['reason'] }
  /** The OCR reader's own verdict, for a PDF or an image. */
  | { reason: 'tableRead'; failure: OcrFailure }
  | { reason: 'noHeaderRow' }
  | { reason: 'noDateColumn' }
  | { reason: 'noAmountColumn' }
  | { reason: 'noRows' };

export type ParseResult = { ok: true; statement: ParsedStatement } | { ok: false; failure: ParseFailure };

/* ── Header detection ─────────────────────────────────────────────────────── */

const DATE_HEADERS = /^(date|transaction date|posting date|booked|value date|date posted)$/i;
const DESC_HEADERS = /^(description|details|narrative|reference|transaction|payee|merchant|particulars)$/i;
const AMOUNT_HEADERS = /^(amount|value|transaction amount|amount \(gbp\)|amt)$/i;
const PAID_OUT_HEADERS = /^(paid out|debit|money out|withdrawal|withdrawals|out|dr)$/i;
const PAID_IN_HEADERS = /^(paid in|credit|money in|deposit|deposits|in|cr)$/i;
const BALANCE_HEADERS = /^(balance|running balance|balance \(gbp\)|closing balance)$/i;

/**
 * Finds the header row rather than assuming row 0.
 *
 * Every UK bank puts preamble above the table — account name, sort code, a
 * date range, often blank rows. Assuming the first row is the header reads
 * "Account: 12345678" as column names and then finds no date column, which
 * reports a perfectly good statement as unreadable.
 *
 * The header is the first row within the first 25 that names BOTH a date and
 * something amount-shaped, which is the minimum a statement must have.
 */
function findMapping(grid: Grid): ColumnMapping | null {
  const limit = Math.min(grid.length, 25);
  for (let r = 0; r < limit; r += 1) {
    const cells = (grid[r] ?? []).map((c) => c.trim());
    const find = (re: RegExp): number | null => {
      const i = cells.findIndex((c) => re.test(c));
      return i === -1 ? null : i;
    };
    const date = find(DATE_HEADERS);
    if (date === null) continue;
    const amount = find(AMOUNT_HEADERS);
    const paidOut = find(PAID_OUT_HEADERS);
    const paidIn = find(PAID_IN_HEADERS);
    if (amount === null && paidOut === null && paidIn === null) continue;
    return {
      date,
      // A statement with no description column is unusual but not fatal — the
      // line still has a date and an amount, which is what matching needs.
      description: find(DESC_HEADERS) ?? -1,
      amount,
      paidOut,
      paidIn,
      balance: find(BALANCE_HEADERS),
      headerRow: r,
    };
  }
  return null;
}

/* ── Dates ────────────────────────────────────────────────────────────────── */

/**
 * UK day-first, and that is not a preference — it is the difference between
 * 3 April and 4 March on the same bytes.
 *
 * `05/04/2026` is 5 April. The one case where day-first is impossible
 * (`2026-04-05`, or a first component above 12) is read the only way it can be.
 * Anything else is refused rather than guessed.
 */
export function parseStatementDate(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;

  // ISO already — the only unambiguous form.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // Excel serial. Day 1 is 1900-01-01, and the epoch is offset by the famous
  // non-existent 1900-02-29 that every spreadsheet reproduces.
  if (/^\d+(\.\d+)?$/.test(value)) {
    const serial = Number.parseFloat(value);
    // Below 1000 it is far more likely a reference number than a date in 1902.
    if (serial >= 1000) {
      const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000;
      return new Date(ms).toISOString().slice(0, 10);
    }
    return null;
  }

  const parts = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2}|\d{4})$/.exec(value);
  if (parts) {
    const a = Number.parseInt(parts[1] ?? '', 10);
    const b = Number.parseInt(parts[2] ?? '', 10);
    const yearRaw = Number.parseInt(parts[3] ?? '', 10);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    // Day-first, because this is a UK product and `05/04/2026` is 5 April.
    //
    // The one exception is a second component that cannot be a month: in
    // `04/25/2026` the 25 has to be the day, so the file is month-first and
    // reading it day-first would produce month 25 and refuse a date that is
    // perfectly legible. Where BOTH components are ≤ 12 the form is genuinely
    // ambiguous and day-first is the answer — that is the convention, and
    // guessing per-row from the surrounding data would make one file parse two
    // ways.
    const monthFirst = a <= 12 && b > 12;
    const day = monthFirst ? b : a;
    const month = monthFirst ? a : b;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // `5 Apr 2026` / `05 April 2026`
  const named = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/.exec(value);
  if (named) {
    const month = MONTHS.indexOf((named[2] ?? '').slice(0, 3).toLowerCase()) + 1;
    if (month === 0) return null;
    return `${named[3]}-${String(month).padStart(2, '0')}-${String(Number.parseInt(named[1] ?? '', 10)).padStart(2, '0')}`;
  }
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/* ── Money ────────────────────────────────────────────────────────────────── */

/**
 * `£1,234.56` → `123456`. Integer pence or nothing.
 *
 * Handles the currency symbol, thousands separators, a trailing or leading
 * minus, accounting parentheses (`(12.34)` is negative), and the European
 * `1.234,56` form — which is the trap: read with English rules that is one
 * pound twenty-three, not one thousand two hundred and thirty-four.
 *
 * The decision is made on SHAPE, not locale: if both separators appear, the
 * LAST one is the decimal point. If only one appears and it splits exactly two
 * trailing digits, it is a decimal point; three trailing digits make it a
 * thousands separator.
 */
export function parseMoneyPence(raw: string): number | null {
  let value = raw.trim();
  if (value === '') return null;

  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  value = value.replace(/[£$€\s]/g, '');
  if (value.startsWith('-')) {
    negative = true;
    value = value.slice(1);
  } else if (value.endsWith('-')) {
    negative = true;
    value = value.slice(0, -1);
  }
  if (value === '') return null;

  const lastComma = value.lastIndexOf(',');
  const lastDot = value.lastIndexOf('.');
  let decimalAt = -1;
  if (lastComma !== -1 && lastDot !== -1) decimalAt = Math.max(lastComma, lastDot);
  else if (lastComma !== -1 || lastDot !== -1) {
    const only = Math.max(lastComma, lastDot);
    const trailing = value.length - only - 1;
    // Grouping is ALWAYS exactly three digits (`1,234`). Anything else is a
    // decimal point — including four or more, which is then refused below as
    // money we cannot represent exactly rather than silently regrouped. An
    // earlier cut treated "not exactly two" as grouping, which turned
    // `12.3456` into £12,345.60.
    decimalAt = trailing === 3 ? -1 : only;
  }

  const whole = (decimalAt === -1 ? value : value.slice(0, decimalAt)).replace(/[.,]/g, '');
  const frac = decimalAt === -1 ? '' : value.slice(decimalAt + 1).replace(/[.,]/g, '');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;
  if (whole === '' && frac === '') return null;
  // More than two decimal places is not money we can represent exactly. Refused
  // rather than rounded: a silently rounded statement will not reconcile, and
  // the accountant will hunt the penny rather than the file.
  if (frac.length > 2) return null;

  const pence = Number.parseInt(whole === '' ? '0' : whole, 10) * 100 + Number.parseInt(frac.padEnd(2, '0') || '0', 10);
  if (!Number.isSafeInteger(pence)) return null;
  return negative ? -pence : pence;
}

/* ── The parse ────────────────────────────────────────────────────────────── */

/**
 * A statement's bytes → its transactions, for the SPREADSHEET formats.
 *
 * CSV and XLSX only. A PDF or an image is a table that has to be recovered
 * rather than read, which is Textract's job (D20) — that path produces a grid
 * and calls {@link parseStatementGrid} with it. Both end up in the same parser,
 * so the column rules, the money rules and the D41 gate are shared and cannot
 * drift between formats.
 */
export function parseStatement(bytes: Buffer, fileName: string): ParseResult {
  const format = formatFor(fileName);
  if (format === null) return { ok: false, failure: { reason: 'unsupportedFormat', fileName } };

  const read = readSheet(bytes, format);
  if (!read.ok) return { ok: false, failure: { reason: 'unreadable', detail: read.failure.reason } };

  return parseStatementGrid(read.grid);
}

/** The half that works on a grid, whatever produced it. */
export function parseStatementGrid(grid: Grid): ParseResult {
  const read = { grid };
  const mapping = findMapping(read.grid);
  if (mapping === null) return { ok: false, failure: { reason: 'noHeaderRow' } };

  const rows: ParsedRow[] = [];
  const skipped: SkippedLine[] = [];
  /**
   * A "balance brought forward" line: dated, carrying a balance, with no
   * amount. It is the statement's starting position, not a transaction, and it
   * is what makes the opening balance a FACT the bank stated rather than one
   * derived by subtracting the first transaction from its own closing balance.
   */
  let broughtForwardPence: number | null = null;

  for (let r = mapping.headerRow + 1; r < read.grid.length; r += 1) {
    const cells = read.grid[r] ?? [];
    const at = (i: number | null): string => (i === null || i < 0 ? '' : (cells[i] ?? ''));
    const preview = cells.join(' | ').slice(0, 120);
    // Blank rows survive the reader so line numbers stay true to the file; they
    // are simply not rows of data.
    if (cells.every((c) => c.trim() === '')) continue;

    const bookedOn = parseStatementDate(at(mapping.date));
    if (bookedOn === null) {
      // A row with no date is usually the bank's own trailer ("Total", a
      // disclaimer). Only worth reporting if it carries money, because a line
      // with an amount and no date IS a lost transaction.
      const looksMonetary =
        parseMoneyPence(at(mapping.amount)) !== null ||
        parseMoneyPence(at(mapping.paidOut)) !== null ||
        parseMoneyPence(at(mapping.paidIn)) !== null;
      if (looksMonetary) skipped.push({ sourceLine: r + 1, reason: 'noDate', preview });
      continue;
    }

    const amountPence = amountFor(mapping, at);
    if (amountPence === null) {
      const balanceHere = parseMoneyPence(at(mapping.balance));
      // Dated, has a balance, states no amount → brought-forward, not a hole.
      // Reporting it as a dropped line would mark every well-formed statement
      // from a bank that prints one as INCOMPLETE, which would make the D41
      // gate cry wolf on the most ordinary file there is.
      if (balanceHere !== null && !hasAnyAmountText(mapping, at)) {
        broughtForwardPence = balanceHere;
        continue;
      }
      skipped.push({
        sourceLine: r + 1,
        reason: hasAnyAmountText(mapping, at) ? 'unreadableAmount' : 'noAmount',
        preview,
      });
      continue;
    }

    rows.push({
      bookedOn,
      description: at(mapping.description).trim(),
      amountPence,
      balanceAfterPence: parseMoneyPence(at(mapping.balance)),
      sourceLine: r + 1,
    });
  }

  if (rows.length === 0) return { ok: false, failure: { reason: 'noRows' } };

  const dates = rows.map((row) => row.bookedOn).sort();
  const closing = lastNonNull(rows.map((row) => row.balanceAfterPence));
  const first = rows[0];
  // The bank's own brought-forward line when it printed one; otherwise derived
  // by reversing the first transaction out of its closing balance.
  const opening =
    broughtForwardPence ??
    (first !== undefined && first.balanceAfterPence !== null ? first.balanceAfterPence - first.amountPence : null);

  return {
    ok: true,
    statement: {
      rows,
      periodStart: dates[0] ?? '',
      periodEnd: dates[dates.length - 1] ?? '',
      openingBalancePence: opening,
      closingBalancePence: closing,
      mapping,
      skipped,
    },
  };
}

/**
 * One signed amount, however the bank chose to express it.
 *
 * ⚠ **A `Paid out` column is money LEAVING, so it is negated** even though the
 * bank prints it unsigned. Getting this backwards files every payment as income
 * — it looks completely normal on screen and inverts the client's books.
 */
function amountFor(mapping: ColumnMapping, at: (i: number | null) => string): number | null {
  if (mapping.amount !== null) {
    const signed = parseMoneyPence(at(mapping.amount));
    if (signed !== null) return signed;
  }
  const out = parseMoneyPence(at(mapping.paidOut));
  const inn = parseMoneyPence(at(mapping.paidIn));
  // Both populated is contradictory; a bank writes one or the other. Reading it
  // as the difference would invent a number neither column states.
  if (out !== null && inn !== null && out !== 0 && inn !== 0) return null;
  if (out !== null && out !== 0) return -Math.abs(out);
  if (inn !== null && inn !== 0) return Math.abs(inn);
  return null;
}

function hasAnyAmountText(mapping: ColumnMapping, at: (i: number | null) => string): boolean {
  return [mapping.amount, mapping.paidOut, mapping.paidIn].some((i) => at(i).trim() !== '');
}

function lastNonNull(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const v = values[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}
