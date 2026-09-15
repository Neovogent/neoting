/**
 * The money boundary for every ledger adapter (build brief, "The money boundary
 * is where adapters will bite").
 *
 * Money is integer pence everywhere inside this codebase, lint-enforced. Three
 * of the four vendors put money on the wire as a **JSON number**, which in
 * JavaScript is a double, and that is the conversion this file owns in both
 * directions. `exports-public-api/canonical/money.ts` does the same job for the
 * file lane; this is its sibling, and the two are deliberately separate — an
 * emitter's conventions (VT wants magnitudes) have nothing to do with a
 * vendor's.
 *
 * | Platform | Money on the wire |
 * |---|---|
 * | Xero | `format: double` on ~98 fields |
 * | QuickBooks Online | JSON decimal number |
 * | Sage Accounting | `double`, and SOMETIMES a string |
 * | FreeAgent | decimal strings — the only one with no conversion risk |
 */

export class LedgerMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerMoneyError';
  }
}

/**
 * ⚠ **Outbound: integer pence → the decimal a vendor's JSON must carry.**
 *
 * Returns a NUMBER because three of the four schemas type it as one, and this
 * is the only place in the codebase allowed to make one out of pence. It is
 * built from a string rather than by dividing, because `1234 / 100` is
 * `12.34`-ish and `1999999999 / 100` is visibly not: integer division for the
 * pounds, integer remainder for the pence, one `Number()` on text that is
 * already exactly right.
 *
 * The returned double is the nearest representable value to that decimal, which
 * is the best any JSON encoder can do — and it is what {@link penceFromWire}
 * inverts exactly.
 */
export function penceToWireNumber(signedPence: number): number {
  return Number(penceToDecimalString(signedPence));
}

/**
 * ⚠ **Outbound: integer pence → a decimal STRING.** FreeAgent's whole API takes
 * money this way (`"total_value": "100.0"`), which is why it is the gentlest of
 * the four. Also what {@link penceToWireNumber} is built on.
 */
export function penceToDecimalString(signedPence: number): string {
  if (!Number.isInteger(signedPence)) {
    throw new LedgerMoneyError(
      `Money is integer pence (R5, Governance §1.7). Got ${signedPence}, which is a float and therefore already the wrong number.`,
    );
  }
  if (!Number.isSafeInteger(signedPence)) {
    throw new LedgerMoneyError(`${signedPence} pence is outside the range this codebase can represent exactly.`);
  }
  const absolute = Math.abs(signedPence);
  const pounds = Math.trunc(absolute / 100);
  const remainder = absolute % 100;
  return `${signedPence < 0 ? '-' : ''}${pounds}.${String(remainder).padStart(2, '0')}`;
}

/**
 * ⚠ **Inbound: whatever the vendor sent → integer pence, or an error.**
 *
 * This is the read-back half, and it is the one that decides whether the
 * reconciliation check in every adapter is telling the truth.
 *
 * Three shapes arrive: a JSON number (Xero, QuickBooks, Sage), a decimal string
 * (FreeAgent, and Sage sometimes), and — because vendors are vendors — null.
 *
 * **Strings are read as text**, digit by digit, so nothing ever becomes a double.
 * **Numbers cannot be**, because `JSON.parse` has already thrown the text away
 * by the time we see them, so the double is scaled by 100 and rounded — which is
 * exact for any value that started life as a 2-decimal amount, because the
 * nearest double to such a decimal is closer than half a penny to it. The guard
 * below is what makes that claim checkable rather than assumed: anything further
 * than a thousandth of a penny from a whole one is not a 2-decimal amount and is
 * refused rather than silently rounded, which is how a unit price with four
 * decimal places would otherwise arrive as a plausible wrong total.
 */
export function penceFromWire(value: unknown, field: string): number {
  if (typeof value === 'string') return penceFromDecimalString(value, field);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LedgerMoneyError(`${field} came back as ${describe(value)} rather than an amount.`);
  }
  const scaled = value * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 0.001) {
    throw new LedgerMoneyError(
      `${field} came back as ${value}, which is not a whole number of pence — this build refuses to round it into the books.`,
    );
  }
  if (!Number.isSafeInteger(rounded)) {
    throw new LedgerMoneyError(`${field} came back as ${value}, which is outside the range of exact integer pence.`);
  }
  return rounded;
}

/**
 * A decimal string → integer pence, read as TEXT.
 *
 * No `parseFloat` anywhere: `parseFloat('0.1') * 100` is `10.000000000000002`,
 * and the whole point of a vendor sending a string is that it never has to
 * become a double at all. Accepts what the four actually send — `"100.0"`,
 * `"12.34"`, `"-9"`, `"1,234.56"` is NOT accepted (a thousands separator means
 * the locale is wrong, not that the number should be guessed at).
 */
export function penceFromDecimalString(value: string, field: string): number {
  const text = value.trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,}))?$/.exec(text);
  if (match === null) {
    throw new LedgerMoneyError(`${field} came back as "${value}", which is not a plain decimal amount.`);
  }
  const [, sign, whole, fraction = ''] = match as unknown as [string, string | undefined, string, string | undefined];
  const decimals = fraction ?? '';
  // More than two decimal places is only acceptable when the extra ones are
  // zeros — `"100.000"` is £100 written long, `"12.345"` is not an amount of
  // money and must not be rounded into somebody's books.
  if (decimals.length > 2 && /[^0]/.test(decimals.slice(2))) {
    throw new LedgerMoneyError(
      `${field} came back as "${value}", which is finer than a penny — this build refuses to round it into the books.`,
    );
  }
  const pennies = `${decimals}00`.slice(0, 2);
  const magnitude = Number(`${whole}${pennies}`);
  if (!Number.isSafeInteger(magnitude)) {
    throw new LedgerMoneyError(`${field} came back as "${value}", which is outside the range of exact integer pence.`);
  }
  return sign === '-' ? -magnitude : magnitude;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  return typeof value;
}
