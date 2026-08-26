/**
 * The one place integer pence become a decimal string in this module.
 *
 * Rule 1 (Governance §1.7, R5): money is integer pence, and it stops being an
 * integer **only at an output boundary**. This module now has two such
 * boundaries rather than one — the VT emitter's amount cells, and the D43
 * manifest's `Total` column (SoT §24.3.2: *"document code, filename, checksum,
 * document number, date, supplier, amount"*). Two boundaries formatting money
 * two ways is how one file says `12.34` and its companion says `12.3`, so both
 * go through this function.
 *
 * **No float exists at any point.** `pence / 100` in floating point is where
 * `1234` becomes `12.340000000000001`, and `toFixed(2)` then launders it into
 * something that looks right and is not. Integer division for the pounds,
 * integer remainder for the pence, string concatenation for the dot.
 */

export class ExportMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportMoneyError';
  }
}

/**
 * Signed integer pence → a decimal string with exactly two places.
 *
 * The sign is **kept**. Dropping it is a target's convention (VT derives debit
 * and credit from its `Type` column and wants magnitudes), and a convention
 * belongs in the emitter that holds it — `formatVtAmount` takes the absolute
 * value before calling this. The manifest is a human-readable index of what was
 * exported, so a credit note reads as negative there.
 */
export function formatPenceDecimal(signedPence: number): string {
  if (!Number.isInteger(signedPence)) {
    throw new ExportMoneyError(
      `Money is integer pence (R5, Governance §1.7). Got ${signedPence}, which is a float and therefore already the wrong number.`,
    );
  }

  const absolute = Math.abs(signedPence);
  const pounds = Math.trunc(absolute / 100);
  const remainder = absolute % 100;
  const sign = signedPence < 0 ? '-' : '';

  return `${sign}${pounds}.${String(remainder).padStart(2, '0')}`;
}
