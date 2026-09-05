import type { UpdateCodingPayload } from '@neoting/contracts/model';

/**
 * Deterministic sanity checks on a manual coding correction — the "second
 * opinion" layer of the correction-integrity package (review items 22, 46, 47;
 * design ruling, Mubashir 5 Sep 2026: *"while confirming any manual change pass
 * it under ai suggestion … the accountant gets option to correct himself (so
 * put a button along with the confusion that is 'ignore' — ai also can make
 * mistake too)"*).
 *
 * ## What this is, and is not
 *
 * These are ADVISORY. A check that fires never blocks the correction — D44's
 * boundary stands: a determined human may assert false facts through Review →
 * Approve, and the product's job is to make the assertion INFORMED. The one
 * hard rule at the correction boundary (a category must be a code on the
 * client's chart of accounts) is NOT here — it is a refusal, not an opinion,
 * and lives in `proposals/validate-update-coding.ts`.
 *
 * The checks fire on what the correction TOUCHES: confirming a supplier name
 * does not re-litigate a tax figure the human never typed. The values checked
 * are the AFTER values — the document's stored figures with the correction
 * applied over them — because that is the document the approval would produce.
 *
 * ## Where it runs, deliberately twice
 *
 * - **Client-side** (`apps/web/src/lib/correctionChecks.ts` mirrors these
 *   rules) in the correction dialog, with [Ignore — I'm sure] / [Go back and
 *   fix]. Ignore proceeds with the ORIGINAL typed value.
 * - **Server-side** on the proposal review: `modules/approvals` calls
 *   `evaluateCorrectionChecks` (via `computeCorrectionAdvisory`) when the
 *   review is first opened and renders the result as a "⚠ Checks" section, so
 *   the warning is frozen into the rendered summary the approve hash covers.
 *
 * ## The seam the model-backed second opinion plugs into
 *
 * Items 19/48 (the coding ladder's model tiers) will want to say things about
 * a correction this deterministic layer cannot. A future model pass emits the
 * same `CorrectionCheck` shape and joins the same section — nothing about the
 * rendering or the Ignore mechanics changes.
 *
 * Pure: no clock (today arrives as an argument), no database, integer pence
 * throughout — the money rendering below is string arithmetic, never division.
 */

export type CorrectionCheckCode =
  | 'tax-exceeds-total'
  | 'tax-total-signs-disagree'
  | 'date-in-future'
  | 'date-implausibly-old'
  | 'not-a-financial-document';

export interface CorrectionCheck {
  readonly code: CorrectionCheckCode;
  /** One sentence, written to be read on the review card and in the dialog. */
  readonly message: string;
}

/** The document as stored, BEFORE the correction — the header projection. */
export interface CorrectionCheckContext {
  readonly docType: 'INVOICE' | 'RECEIPT' | 'CREDIT_NOTE' | 'STATEMENT' | 'OTHER' | null;
  readonly totalPence: number | null;
  readonly taxPence: number | null;
  /** `YYYY-MM-DD`, or null when the document has no date. */
  readonly documentDate: string | null;
  readonly currency: string | null;
  /**
   * Whether the accepted extraction read ANY value off the document. False is
   * the selfie shape: an image containing no text at all, every field null.
   */
  readonly extractionHadValues: boolean;
}

/** A document date more than this many years back is almost certainly a typo. */
export const IMPLAUSIBLY_OLD_YEARS = 7;

/** The corrected fields that assert financial facts about the document. */
const FINANCIAL_FIELDS = ['totalPence', 'taxPence', 'categoryCode', 'currency'] as const;

type Corrections = UpdateCodingPayload['fields'];

export function evaluateCorrectionChecks(
  context: CorrectionCheckContext,
  corrections: Corrections,
  /** Today's calendar date in Europe/London, `YYYY-MM-DD`. An argument so the function stays pure. */
  todayIso: string,
): CorrectionCheck[] {
  const checks: CorrectionCheck[] = [];
  const code = context.currency ?? null;

  // AFTER values: the stored figure with the correction applied over it.
  const total = corrections.totalPence ?? context.totalPence;
  const tax = corrections.taxPence ?? context.taxPence;
  const touchesMoney = corrections.totalPence !== undefined || corrections.taxPence !== undefined;

  if (touchesMoney && total !== null && total !== undefined && tax !== null && tax !== undefined) {
    if (Math.abs(tax) > Math.abs(total)) {
      // The exact shape item 22 proved: £9,000.00 of tax on a £994.00 invoice,
      // accepted silently, dead at export (net = total − tax flips sign, and
      // the canonical model refuses mixed signs — NT-EXP-001). Said HERE, in
      // plain words, before it is stored.
      checks.push({
        code: 'tax-exceeds-total',
        message: `Tax ${money(tax, code)} is larger than the total ${money(total, code)}. A document whose tax exceeds its total will produce NO line in the export file — correct the tax or the total before approving.`,
      });
    } else if (total !== 0 && tax !== 0 && Math.sign(total) !== Math.sign(tax)) {
      checks.push({
        code: 'tax-total-signs-disagree',
        message: `Tax ${money(tax, code)} and total ${money(total, code)} point in opposite directions. Gross, net and VAT must share one sign, so this document will not export as it stands.`,
      });
    }
  }

  // Document date only — a DUE date is routinely in the future and never old.
  const date = corrections.documentDate;
  if (date !== undefined) {
    if (date > todayIso) {
      checks.push({
        code: 'date-in-future',
        message: `The document date ${ukDate(date)} is in the future. A future date is almost always a typo, and it files this document into an accounting period that does not exist yet.`,
      });
    } else if (date < minusYears(todayIso, IMPLAUSIBLY_OLD_YEARS)) {
      checks.push({
        code: 'date-implausibly-old',
        message: `The document date ${ukDate(date)} is more than ${IMPLAUSIBLY_OLD_YEARS} years ago. Check the year — a date that old is outside any period this practice would still be filing.`,
      });
    }
  }

  // Item 47: money or category typed onto something the pipeline read as not
  // a financial document. The CURRENT stored type is what the pipeline said —
  // correcting Type in the same breath does not quiet this, because the image
  // is still the image; the human may ignore, and that ignoring is informed.
  const assertsFinancialFacts =
    FINANCIAL_FIELDS.some((field) => corrections[field] !== undefined);
  if (assertsFinancialFacts && (context.docType === 'OTHER' || !context.extractionHadValues)) {
    checks.push({
      code: 'not-a-financial-document',
      message:
        context.docType === 'OTHER'
          ? 'This does not appear to be a financial document — the pipeline classified it as Type OTHER. Figures typed onto it will be treated as real bookkeeping once approved.'
          : 'This does not appear to be a financial document — extraction found no readable values on it at all. Figures typed onto it will be treated as real bookkeeping once approved.',
    });
  }

  return checks;
}

/** Today's calendar date in Europe/London, `YYYY-MM-DD` — the one impure helper, for callers. */
export function todayInLondon(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD; the time zone is the repo's rendering zone.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now);
}

/** `YYYY-MM-DD` minus N years, string arithmetic; 29 Feb clamps to 28 Feb. */
export function minusYears(iso: string, years: number): string {
  const year = Number(iso.slice(0, 4)) - years;
  const rest = iso.slice(4);
  const shifted = `${String(year).padStart(4, '0')}${rest}`;
  return shifted.endsWith('-02-29') ? `${String(year).padStart(4, '0')}-02-28` : shifted;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2027-08-09` → `9 Aug 2027` — UK d/m/y at render, per the repo invariant. */
function ukDate(iso: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!parts) return iso;
  return `${Number(parts[3])} ${MONTHS[Number(parts[2]) - 1] ?? '???'} ${parts[1]}`;
}

/** Symbols we will print; anything else is stated by its ISO code, null renders bare. */
const CURRENCY_SYMBOLS: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };

/**
 * Integer pence → the figure the warning names, with STRING arithmetic — no
 * division, so no float ever touches a monetary value (the repo's most-guarded
 * invariant, applied to rendering, the `render-summary.ts` pattern).
 */
export function money(pence: number, code: string | null): string {
  const sign = pence < 0 ? '-' : '';
  const digits = String(Math.abs(pence)).padStart(3, '0');
  const amount = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  if (code === null) return `${sign}${amount}`;
  const symbol = CURRENCY_SYMBOLS[code] ?? `${code} `;
  return `${sign}${symbol}${amount}`;
}
