import type { CanonicalBankStatementLine, CanonicalTransactionDocument } from '../../canonical/canonical-row.js';
import { formatPenceDecimal } from '../../canonical/money.js';

import { VtEmitterError } from './vt-safety.js';

/**
 * Where VT's cells are shaped: the sign convention on an amount, and a calendar
 * date as UK d/m/y. **This file is the emitter boundary in the sense rule 1
 * means it** — the point a money value stops being an integer. The digits
 * themselves are produced by `canonical/money.ts`, which is shared with the D43
 * manifest so that two output boundaries cannot render one number two ways.
 */

/**
 * Signed integer pence → VT's amount cell.
 *
 * **The result is always positive.** §24.3.1: *all positive — VT derives debit
 * and credit from `Type`.* The canonical model stores debit-positive /
 * credit-negative (§24.3.4) precisely so each target can derive its own
 * convention; emitting our sign as well as VT's `Type` would post the reversal
 * twice. The sign is dropped **here**, in VT's emitter, and nowhere earlier.
 *
 * The integer guard is repeated rather than delegated because the message
 * differs: a float reaching a VT cell is a `VtEmitterError` like every other
 * refusal in this emitter, so a caller catching one catches all of them.
 */
export function formatVtAmount(signedPence: number): string {
  if (!Number.isInteger(signedPence)) {
    throw new VtEmitterError(
      `Money is integer pence (R5, Governance §1.7). Got ${signedPence}, which is a float and therefore already the wrong number.`,
    );
  }

  return formatPenceDecimal(Math.abs(signedPence));
}

/**
 * `YYYY-MM-DD` → `DD/MM/YYYY`.
 *
 * Three substrings rearranged, and no `Date` is constructed. Rule 8 says UTC in
 * storage and Europe/London in rendering, and the cheapest way to honour it for
 * a value that was never an instant is to refuse to make it one: a
 * `new Date('2026-08-04')` is midnight UTC, and one careless local-time
 * formatter later it is 3 August in the accountant's file.
 */
export function formatVtDate(calendarDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calendarDate);
  if (match === null) {
    throw new VtEmitterError(`Expected a YYYY-MM-DD calendar date, got "${calendarDate}".`);
  }
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/**
 * VT's `Type` codes. **Never invented** (§24.3.1) — VT derives the whole
 * double entry from this cell, so a code VT does not know is a rejected row and
 * a code VT knows but we meant differently is a wrong posting that reconciles.
 *
 * | Canonical | VT |
 * |---|---|
 * | supplier invoice | `PIN` |
 * | supplier credit note | `PCR` |
 * | customer invoice | `SIN` |
 * | customer credit note | `SCR` |
 * | bank payment | `PAY` |
 * | cheque payment | `CHQ` |
 * | bank receipt | `REC` |
 */
export type VtType = 'PIN' | 'PCR' | 'SIN' | 'SCR' | 'PAY' | 'CHQ' | 'REC';

export function vtTypeForDocument(row: CanonicalTransactionDocument): VtType {
  if (row.party === 'SUPPLIER') return row.instrument === 'INVOICE' ? 'PIN' : 'PCR';
  return row.instrument === 'INVOICE' ? 'SIN' : 'SCR';
}

export function vtTypeForBankLine(row: CanonicalBankStatementLine): VtType {
  if (row.movement === 'RECEIPT') return 'REC';
  return row.instrument === 'CHEQUE' ? 'CHQ' : 'PAY';
}
