import type { ParsedStatement } from './statement-parser.js';

/**
 * D41: statement extraction is gated on **provable completeness**, not on a
 * confidence score.
 *
 * ## Why this is a hard gate and not a warning
 *
 * D40 makes manual upload the ONLY bank input in ID. So a transaction this
 * parser drops is not a row missing from a screen — it is a payment nobody will
 * ever chase a receipt for, and no other input will catch it. There is no feed
 * to reconcile against later. That is the whole reason the gate exists, and why
 * a statement that cannot be proved complete is marked as such rather than
 * being quietly accepted because it looked fine.
 *
 * ## What can actually be PROVED
 *
 * Only arithmetic. Given a running-balance column, a statement is complete iff
 * every consecutive pair satisfies `balance[n] = balance[n-1] + amount[n]`, to
 * the penny. A break in that chain is proof of a missing or misread line, and
 * its position says which one. That is the only assurance available here, and
 * it is genuinely strong.
 *
 * ## Reduced assurance is a CLASS, not a pass
 *
 * A statement with no balance column cannot be proved complete by any means
 * this file has. D41 names that a *distinct reduced-assurance class*, so it is
 * recorded as `reduced` and never as `complete` — the accountant is told what
 * could not be checked instead of being shown a green tick that means "we did
 * not look".
 */

export type Assurance =
  /** Balance continuity holds across every line. Nothing is missing. */
  | 'complete'
  /** No balance column: parsed cleanly, but completeness is unprovable. */
  | 'reduced'
  /** Proof failed, or lines were dropped. The statement is not trustworthy. */
  | 'incomplete';

export interface CompletenessFinding {
  readonly kind: 'balanceBreak' | 'skippedLine' | 'duplicateLine' | 'dateOutOfOrder' | 'noBalanceColumn';
  /** The 1-based source line the finding is about, when it has one. */
  readonly sourceLine: number | null;
  /** Plain English, for the accountant — never a code on its own. */
  readonly detail: string;
}

export interface CompletenessReport {
  readonly assurance: Assurance;
  readonly findings: CompletenessFinding[];
  readonly rowCount: number;
  /** Set only when continuity was actually checked and held. */
  readonly provenBy: 'balanceContinuity' | null;
}

export function assessCompleteness(statement: ParsedStatement): CompletenessReport {
  const findings: CompletenessFinding[] = [];

  // 1. Anything the parser could not read is a hole, full stop. A statement
  //    with a dropped line cannot be complete however well the rest adds up.
  for (const skip of statement.skipped) {
    findings.push({
      kind: 'skippedLine',
      sourceLine: skip.sourceLine,
      detail:
        skip.reason === 'noDate'
          ? `Line ${skip.sourceLine} carries an amount but no readable date, so it was not imported: ${skip.preview}`
          : skip.reason === 'unreadableAmount'
            ? `Line ${skip.sourceLine} has an amount that could not be read as money: ${skip.preview}`
            : `Line ${skip.sourceLine} has no amount: ${skip.preview}`,
    });
  }

  // 2. In-statement duplicates. Same date, same amount, same description twice
  //    is usually a genuine repeat (two identical coffees), so this reports
  //    rather than refuses — but an accountant must see it, because the other
  //    cause is a file exported twice and concatenated.
  const seen = new Map<string, number>();
  for (const row of statement.rows) {
    const key = `${row.bookedOn}|${row.amountPence}|${row.description.toLowerCase()}`;
    const first = seen.get(key);
    if (first !== undefined) {
      findings.push({
        kind: 'duplicateLine',
        sourceLine: row.sourceLine,
        detail: `Line ${row.sourceLine} repeats line ${first} exactly — same date, amount and description.`,
      });
    } else seen.set(key, row.sourceLine);
  }

  // 3. Date monotonicity. Statements run forwards; a backwards step suggests
  //    two periods concatenated or a mis-parsed date. Reported, not fatal —
  //    some banks group by type rather than strictly by date.
  for (let i = 1; i < statement.rows.length; i += 1) {
    const prev = statement.rows[i - 1];
    const row = statement.rows[i];
    if (prev !== undefined && row !== undefined && row.bookedOn < prev.bookedOn) {
      findings.push({
        kind: 'dateOutOfOrder',
        sourceLine: row.sourceLine,
        detail: `Line ${row.sourceLine} (${row.bookedOn}) is dated before line ${prev.sourceLine} (${prev.bookedOn}).`,
      });
    }
  }

  // 4. The proof itself.
  const balances = statement.rows.map((row) => row.balanceAfterPence);
  const hasBalances = balances.some((b) => b !== null);

  if (!hasBalances) {
    findings.push({
      kind: 'noBalanceColumn',
      sourceLine: null,
      detail:
        'This statement carries no running balance, so it cannot be proved that every transaction is present. ' +
        'The lines that were read are imported; a file with a balance column can be checked to the penny.',
    });
    return {
      // Skipped lines are a KNOWN hole and outrank "we could not check".
      assurance: statement.skipped.length > 0 ? 'incomplete' : 'reduced',
      findings,
      rowCount: statement.rows.length,
      provenBy: null,
    };
  }

  let broke = false;
  for (let i = 1; i < statement.rows.length; i += 1) {
    const prev = statement.rows[i - 1];
    const row = statement.rows[i];
    if (prev?.balanceAfterPence == null || row?.balanceAfterPence == null) continue;
    const expected = prev.balanceAfterPence + row.amountPence;
    if (expected !== row.balanceAfterPence) {
      broke = true;
      findings.push({
        kind: 'balanceBreak',
        sourceLine: row.sourceLine,
        detail:
          `The running balance does not follow at line ${row.sourceLine}: ` +
          `${penceToText(prev.balanceAfterPence)} ${row.amountPence < 0 ? '−' : '+'} ` +
          `${penceToText(Math.abs(row.amountPence))} should be ${penceToText(expected)}, ` +
          `but the statement says ${penceToText(row.balanceAfterPence)}. ` +
          'That difference is a transaction this file does not show.',
      });
    }
  }

  const clean = !broke && statement.skipped.length === 0;
  return {
    assurance: clean ? 'complete' : 'incomplete',
    findings,
    rowCount: statement.rows.length,
    provenBy: clean ? 'balanceContinuity' : null,
  };
}

/**
 * Pence → `£1,234.56`, for the findings only.
 *
 * Display formatting inside a domain module is normally the wrong place, and it
 * is right here for one reason: these strings are read by an accountant hunting
 * a specific line in their own file, and `123456` is not a number anybody can
 * match against a bank statement by eye.
 */
function penceToText(pence: number): string {
  const negative = pence < 0;
  const abs = Math.abs(pence);
  const whole = Math.trunc(abs / 100).toLocaleString('en-GB');
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '−' : ''}£${whole}.${frac}`;
}
