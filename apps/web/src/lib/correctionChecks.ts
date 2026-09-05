import type { UpdateCodingPayload } from '@neoting/contracts/model';
import type { CorrectionCheckContext } from '../api/document-detail';
import { currency } from './resolver';
import { fromIsoDate } from '../api/documents';

/**
 * The deterministic sanity checks on a typed correction — the CLIENT half of
 * the correction-integrity package (review items 22, 46, 47).
 *
 * ⚠ MIRRORS THE SERVER's `evaluateCorrectionChecks`
 * (`apps/api/src/modules/validation-dedupe/correction-checks.ts`) — the same
 * rules, the same firing conditions, so what the dialog warns about and what
 * the proposal review restates cannot disagree. Change the two together.
 *
 * These are ADVISORY (Mubashir's ruling, 5 Sep 2026: warn with an Ignore
 * button, never hard-block the human — "ai also can make mistake too"). The
 * dialog renders them with [Ignore — I'm sure] / [Go back and fix]; Ignore
 * proceeds with the ORIGINAL typed value. The one hard rule at this boundary —
 * a category must be a code on the client's chart — is the SERVER's refusal at
 * proposal creation, not a check here: the web has no chart read surface yet
 * (a recorded G7 gap), so the refusal arrives on the card with its reason.
 *
 * The checks fire on what the correction TOUCHES, against the AFTER values
 * (the stored figure with the correction applied over it). Live-only by
 * construction: the staging path that reaches the dialog exists only with the
 * API on, so synthetic mode is byte-for-byte unchanged (METH_MODE §1).
 */

/** A document date more than this many years back is almost certainly a typo. Mirrors the server. */
export const IMPLAUSIBLY_OLD_YEARS = 7;

const FINANCIAL_FIELDS = ['totalPence', 'taxPence', 'categoryCode', 'currency'] as const;

export function correctionWarnings(
  context: CorrectionCheckContext,
  corrections: UpdateCodingPayload['fields'],
  todayIso: string = todayInLondon(),
): string[] {
  const warnings: string[] = [];
  const code = context.currency ?? 'GBP';
  const asMoney = (pence: number) => currency(pence / 100, code);

  const total = corrections.totalPence ?? context.totalPence;
  const tax = corrections.taxPence ?? context.taxPence;
  const touchesMoney = corrections.totalPence !== undefined || corrections.taxPence !== undefined;

  if (touchesMoney && total != null && tax != null) {
    if (Math.abs(tax) > Math.abs(total)) {
      warnings.push(
        `Tax ${asMoney(tax)} is larger than the total ${asMoney(total)}. A document whose tax exceeds its total will produce NO line in the export file — correct the tax or the total before approving.`,
      );
    } else if (total !== 0 && tax !== 0 && Math.sign(total) !== Math.sign(tax)) {
      warnings.push(
        `Tax ${asMoney(tax)} and total ${asMoney(total)} point in opposite directions. Gross, net and VAT must share one sign, so this document will not export as it stands.`,
      );
    }
  }

  const date = corrections.documentDate;
  if (date !== undefined) {
    if (date > todayIso) {
      warnings.push(
        `The document date ${fromIsoDate(date)} is in the future. A future date is almost always a typo, and it files this document into an accounting period that does not exist yet.`,
      );
    } else if (date < minusYears(todayIso, IMPLAUSIBLY_OLD_YEARS)) {
      warnings.push(
        `The document date ${fromIsoDate(date)} is more than ${IMPLAUSIBLY_OLD_YEARS} years ago. Check the year — a date that old is outside any period this practice would still be filing.`,
      );
    }
  }

  const assertsFinancialFacts = FINANCIAL_FIELDS.some((field) => corrections[field] !== undefined);
  if (assertsFinancialFacts && (context.docType === 'OTHER' || !context.extractionHadValues)) {
    warnings.push(
      context.docType === 'OTHER'
        ? 'This does not appear to be a financial document — the pipeline classified it as Type OTHER. Figures typed onto it will be treated as real bookkeeping once approved.'
        : 'This does not appear to be a financial document — extraction found no readable values on it at all. Figures typed onto it will be treated as real bookkeeping once approved.',
    );
  }

  return warnings;
}

/** Today's calendar date in Europe/London, `YYYY-MM-DD` — the repo's rendering zone. */
export function todayInLondon(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now);
}

/** `YYYY-MM-DD` minus N years, string arithmetic; 29 Feb clamps to 28 Feb. Mirrors the server. */
export function minusYears(iso: string, years: number): string {
  const year = Number(iso.slice(0, 4)) - years;
  const shifted = `${String(year).padStart(4, '0')}${iso.slice(4)}`;
  return shifted.endsWith('-02-29') ? `${String(year).padStart(4, '0')}-02-28` : shifted;
}
