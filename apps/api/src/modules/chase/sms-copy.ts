/**
 * Chase composition (SoT §4 Stage 8.2) — the SMS copy, verbatim.
 *
 * SoT specifies the shape exactly:
 *
 *   "American Burger Accounts: we're missing the receipt for Currys £1,299 on
 *    9 Aug. Upload securely: [link]"
 *
 * and: **grouped per client, not one text per receipt**. So one message per
 * client covers every unmatched item, and the link is the portal token for that
 * client's grant.
 *
 * This is a PURE function of its inputs — no clock, no DB, no model — so the SMS
 * shown at Read review is byte-for-byte the SMS that sends, and the executor can
 * store it and the sender can send it without either re-deriving it. The real
 * composer is Sonnet writing bespoke copy; this is the template.
 * // DEMO-MOCK: Sonnet composition writes the bespoke message per SoT Stage 8.2.
 *
 * Money is integer pence everywhere it is carried; pounds/pence are formatted
 * to a display string ONLY at the very edge, here, and never as a float — the
 * repo's most-guarded invariant applied to composition too.
 */

/** One chased item, as composition needs it. Money is integer pence. */
export interface ChaseItem {
  /** The bank transaction id — becomes the chase item ref and portal grant. */
  readonly transactionId: string;
  /** Signed pence. The copy shows the magnitude; the sign is money-in/out. */
  readonly amountPence: number;
  readonly bookedAt: Date;
  /** The bank's merchant name when enriched, else the raw descriptor. */
  readonly supplierLabel: string;
}

export interface ComposeChaseInput {
  /** The client's display name — the greeting is "<name> Accounts:". */
  readonly businessName: string;
  /** The items this client is being chased for, grouped into one message. */
  readonly items: readonly ChaseItem[];
  /** The signed portal link the client taps to upload — `signPortalLink` output. */
  readonly portalLink: string;
}

/**
 * The composed SMS for one client. Verbatim per SoT Stage 8.2 for the
 * single-item case; the multi-item case lists each "<supplier> £x on <date>"
 * with the same framing, because the SoT rule is one grouped text, not one per
 * receipt.
 */
export function composeChaseSms(input: ComposeChaseInput): string {
  const greeting = `${input.businessName} Accounts:`;
  const list = joinItems(input.items.map(describeItem));
  const noun = input.items.length === 1 ? 'the receipt' : 'the receipts';
  return `${greeting} we're missing ${noun} for ${list}. Upload securely: ${input.portalLink}`;
}

/** "Currys £1,299 on 9 Aug" — supplier, magnitude in pounds, Europe/London day. */
function describeItem(item: ChaseItem): string {
  return `${item.supplierLabel} ${formatGbp(item.amountPence)} on ${formatDay(item.bookedAt)}`;
}

/** "a", "a and b", "a, b and c" — a natural list, not a comma dump. */
function joinItems(parts: readonly string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] as string;
  const head = parts.slice(0, -1).join(', ');
  return `${head} and ${parts[parts.length - 1] as string}`;
}

/**
 * Integer pence → "£1,299" or "£1,299.50", with STRING arithmetic only — no
 * division, so no float ever touches a monetary value even transiently. Whole
 * pounds drop the ".00" (the SoT copy shows "£1,299", not "£1,299.00");
 * non-zero pence are kept. The magnitude is shown — a payment out is money the
 * client spent, and the sign is not part of the human sentence.
 */
export function formatGbp(amountPence: number): string {
  const abs = Math.abs(Math.trunc(amountPence));
  const digits = String(abs).padStart(3, '0');
  const poundsDigits = digits.slice(0, -2);
  const penceDigits = digits.slice(-2);
  const pounds = withThousands(poundsDigits);
  return penceDigits === '00' ? `£${pounds}` : `£${pounds}.${penceDigits}`;
}

/** "1299" → "1,299". Groups of three from the right, string-only. */
function withThousands(pounds: string): string {
  const chars = pounds.split('');
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    if (i > 0 && (chars.length - i) % 3 === 0) out.push(',');
    out.push(chars[i] as string);
  }
  return out.join('');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * A UTC instant → "9 Aug" in Europe/London. Storage is UTC, rendering is
 * Europe/London (the repo invariant); the day/month are read in that zone via
 * `Intl` so a late-evening UTC timestamp does not show the wrong UK day.
 */
export function formatDay(bookedAt: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: 'numeric',
    month: '2-digit',
  }).formatToParts(bookedAt);
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const monthNum = Number.parseInt(parts.find((p) => p.type === 'month')?.value ?? '', 10);
  const month = Number.isFinite(monthNum) ? MONTHS[monthNum - 1] ?? '' : '';
  return `${day} ${month}`;
}
