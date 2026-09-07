/**
 * Chase composition (SoT §4 Stage 8.2) — the SMS copy, verbatim.
 *
 * SoT specifies the shape exactly:
 *
 *   "American Burger Accounts: we're missing the receipt for Currys on 9 Aug.
 *    Upload securely: [link]"
 *
 * ⚠ **No amount in the copy — an owner ruling of 4 Sep 2026 amending §8.2,
 * which used to show "Currys £1,299 on 9 Aug".** A chase travels by SMS/email
 * to a phone whose lock screen previews it; the supplier and the day identify
 * the receipt without putting a client's spending on that screen. The amounts
 * still exist everywhere identity-gated: the portal's item list (behind the
 * OTP), the accountant's review card sections, and the workspace boards.
 *
 * And: **grouped per client, not one text per receipt**. So one message per
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
 * Above this many items the copy SUMMARISES instead of naming every line —
 * an owner ruling of 6 Sep 2026 amending §8.2 (review item 31): thirty raw
 * bank descriptors in one sentence is a data dump nobody reads, and a long
 * recitation could exceed the contract's 500-char body cap, refusing the
 * stored payload at review. The full itemised list still exists everywhere
 * identity-gated: the portal's item list behind the OTP, and the review card.
 */
export const CHASE_SUMMARISE_THRESHOLD = 3;

/**
 * The composed SMS for one client. Verbatim per SoT Stage 8.2 (as amended
 * 4 Sep 2026 — no amounts; 6 Sep 2026 — long lists summarise) for the
 * single-item case; up to three items are listed as "<supplier> on <date>"
 * with the same framing, because the SoT rule is one grouped text, not one
 * per receipt. More than three summarises: count, period, two named examples.
 */
export function composeChaseSms(input: ComposeChaseInput): string {
  const greeting = `${input.businessName} Accounts:`;
  if (input.items.length > CHASE_SUMMARISE_THRESHOLD) {
    return `${greeting} we're missing receipts for ${summariseItems(input.items)}. Upload securely: ${input.portalLink}`;
  }
  const list = joinItems(input.items.map(describeItem));
  const noun = input.items.length === 1 ? 'the receipt' : 'the receipts';
  return `${greeting} we're missing ${noun} for ${list}. Upload securely: ${input.portalLink}`;
}

/**
 * "12 payments between 3 Aug and 28 Aug, including L Ferreira Wages and
 * Aldgate Meats" — the humane summary for a long list. Period bounds are the
 * earliest and latest booked days (one day collapses to "on <day>"); the
 * examples are the first two distinct supplier labels, so a client scanning a
 * lock screen learns the shape of the ask without thirty descriptors.
 */
function summariseItems(items: readonly ChaseItem[]): string {
  const times = items.map((i) => i.bookedAt.getTime());
  const from = formatDay(new Date(Math.min(...times)));
  const to = formatDay(new Date(Math.max(...times)));
  const period = from === to ? `on ${from}` : `between ${from} and ${to}`;
  const named = [...new Set(items.map((i) => i.supplierLabel))].slice(0, 2);
  return `${items.length} payments ${period}, including ${joinItems(named)}`;
}

/**
 * The accountant's own wording woven into the engine's frame (review item 31,
 * owner-approved 6 Sep 2026). The engine keeps the greeting and the signed
 * portal link — "never free-typed by a caller" still holds for the parts that
 * carry authority — and the middle sentence is the accountant's, shown
 * verbatim at Read review and released by the super admin like any chase.
 */
export function composeCustomChaseBody(input: {
  readonly businessName: string;
  readonly message: string;
  readonly portalLink: string;
}): string {
  return `${input.businessName} Accounts: ${input.message} Upload securely: ${input.portalLink}`;
}

/**
 * "Currys on 9 Aug" — supplier and the Europe/London day, NO amount (the
 * 4 Sep 2026 ruling). `ChaseItem.amountPence` stays on the type: the portal's
 * item list and the review card's sections still show it, behind identity.
 */
function describeItem(item: ChaseItem): string {
  return `${item.supplierLabel} on ${formatDay(item.bookedAt)}`;
}

/** "a", "a and b", "a, b and c" — a natural list, not a comma dump. */
function joinItems(parts: readonly string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] as string;
  const head = parts.slice(0, -1).join(', ');
  return `${head} and ${parts[parts.length - 1] as string}`;
}

/**
 * The statement-request copy (engine (c), Phase 5) — the same SoT §8.2 shape
 * with the statement named instead of receipts. Pure, like `composeChaseSms`,
 * for the same reason: the reviewed bytes are the sent bytes.
 */
export function composeStatementRequestSms(input: {
  readonly businessName: string;
  /** `YYYY-MM` or `YYYY-MM-DD..YYYY-MM-DD` — see `formatPeriod`. */
  readonly period: string;
  readonly portalLink: string;
}): string {
  return `${input.businessName} Accounts: we're missing your bank statement for ${formatPeriod(input.period)}. Upload securely: ${input.portalLink}`;
}

/**
 * The sign-in code by SMS (Phase 3) — byte-for-byte the sample registered with
 * the UK carriers (message sample 2 on the GB long-code registration), so the
 * product sends exactly what the network approved. Pure; the code is the only
 * variable and it is never logged by any caller.
 */
export function composeSignInCodeSms(code: string, expiresInMinutes: number): string {
  return `Your Neo Accounting sign-in code is ${code}. It expires in ${expiresInMinutes} minutes. Never share this code with anyone.`;
}

/**
 * The period as a client says it out loud, never an ISO string.
 *
 *   `2026-07`                    → "July 2026"
 *   `2026-08-01..2026-08-15`     → "1 to 15 August 2026"
 *   `2026-07-26..2026-08-03`     → "26 July to 3 August 2026"
 *   `2025-12-30..2026-01-05`     → "30 December 2025 to 5 January 2026"
 *
 * ⚠ The range shapes collapse whatever the two ends SHARE (review item 16,
 * 8 Sep 2026). "1 August 2026 to 15 August 2026" is what a template produces
 * and not what anybody writes, and this string goes into a text message a
 * client reads on a phone — every repeated word is one they have to read past
 * to find the two numbers that differ.
 */
export function formatPeriod(period: string): string {
  if (period.includes('..')) {
    const [from, to] = period.split('..') as [string, string];
    return formatRange(from, to);
  }
  const month = Number.parseInt(period.slice(5, 7), 10);
  const name = Number.isFinite(month) ? (FULL_MONTHS[month - 1] ?? period) : period;
  return name === period ? period : `${name} ${period.slice(0, 4)}`;
}

/** `2026-08-01` → `{ day: 1, month: 'August', year: '2026' }`, or null if unparseable. */
function partsOf(day: string): { day: number; month: string; year: string } | null {
  const monthIndex = Number.parseInt(day.slice(5, 7), 10);
  const name = FULL_MONTHS[monthIndex - 1];
  const dayOfMonth = Number.parseInt(day.slice(8, 10), 10);
  if (name === undefined || !Number.isFinite(dayOfMonth)) return null;
  return { day: dayOfMonth, month: name, year: day.slice(0, 4) };
}

function formatRange(from: string, to: string): string {
  const a = partsOf(from);
  const b = partsOf(to);
  // Unparseable is echoed rather than guessed at — the same stance the month
  // branch takes. A client reading an ISO string knows something is wrong;
  // a client reading a plausible WRONG date does not.
  if (a === null || b === null) return `${from} to ${to}`;

  if (a.year !== b.year) return `${a.day} ${a.month} ${a.year} to ${b.day} ${b.month} ${b.year}`;
  if (a.month !== b.month) return `${a.day} ${a.month} to ${b.day} ${b.month} ${a.year}`;
  if (a.day !== b.day) return `${a.day} to ${b.day} ${a.month} ${a.year}`;
  return `${a.day} ${a.month} ${a.year}`;
}

const FULL_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

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
