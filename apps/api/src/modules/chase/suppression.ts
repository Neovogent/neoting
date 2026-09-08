/**
 * Chase-suppression descriptor list (SoT §4 Stage 7).
 *
 * Bank-originated lines with no paperwork to chase — service charges, per-item
 * fees, interest, card-processor payouts — must never generate a chase: nobody
 * gets asked for a receipt that cannot exist. The list is the descriptor
 * keywords SoT Stage 7 names verbatim; the predicate is a pure, case-insensitive
 * substring match against the transaction's raw descriptor, split out from the
 * DB read so it is unit-testable on its own.
 *
 * SoT Stage 7 also says the list is "extensible per client". That per-client
 * override is NOT built here (it needs a schema home — `prisma/` is LAW); this
 * is the shared base list, and the extension point is a recorded follow-up.
 * // DEMO-MOCK: per-client suppression descriptors (needs a schema column, G7).
 */

/**
 * The base descriptor keywords, exactly as SoT §4 Stage 7 lists them:
 * `SERVICE CHARGE · COMMISSION · CHG · CHAPS · UNPAID · OD INTEREST · SUMUP ·
 * WORLDPAY · STRIPE PAYOUT`. Upper-case here; the match lower-cases both sides.
 */
export const SUPPRESSION_DESCRIPTORS: readonly string[] = Object.freeze([
  'SERVICE CHARGE',
  'COMMISSION',
  'CHG',
  'CHAPS',
  'UNPAID',
  'OD INTEREST',
  'SUMUP',
  'WORLDPAY',
  'STRIPE PAYOUT',
]);

/**
 * Descriptors found live that the SoT list does not cover — 8 Sep 2026.
 *
 * ⚠ **Kept SEPARATE from `SUPPRESSION_DESCRIPTORS` on purpose.** That list is
 * quoted verbatim from SoT §4 Stage 7 so a reader can check it against the
 * document; folding these into it would make the citation false. These are
 * this release's additions and are owed a SoT amendment.
 *
 * The walk that found them: a chase went out reading *"we're missing the
 * receipts for FRESH DIRECT CD 4211 on 14 Aug, **PAYROLL AUG STAFF** on 21 Aug
 * and **HMRC VAT** on 28 Aug"*. A payroll run and a VAT payment have no
 * supplier receipt in existence, so the client is being asked for a document
 * nobody can produce — and the accountant has to apologise for a message the
 * product composed. The mechanism to prevent it already existed and simply had
 * nothing in it for these two shapes.
 *
 * Conservative by design: **a suppressed line is never chased**, so a
 * false positive costs a document that should have been collected. Only
 * descriptors whose paperwork cannot exist are here — staff pay, and money paid
 * to the revenue. Own-account transfers (`TFR TO SAVINGS`) belong to the same
 * class and are deliberately NOT added: `TRANSFER`/`TFR` also appears on
 * genuine supplier payments, and the substring match cannot tell them apart.
 * That one needs the counterparty, not a keyword.
 */
export const FOUND_LIVE_SUPPRESSION_DESCRIPTORS: readonly string[] = Object.freeze([
  'PAYROLL',
  'WAGES',
  'SALARY',
  'SALARIES',
  'HMRC',
  'PAYE',
]);

/** Everything a descriptor is matched against: the SoT list plus this release's additions. */
export const ALL_SUPPRESSION_DESCRIPTORS: readonly string[] = Object.freeze([
  ...SUPPRESSION_DESCRIPTORS,
  ...FOUND_LIVE_SUPPRESSION_DESCRIPTORS,
]);

/**
 * True when a transaction descriptor matches any suppression keyword — the line
 * has no paperwork to chase, so it is excluded from missing-evidence detection.
 *
 * Case-insensitive substring match: `descriptionRaw` is a bank feed's own free
 * text (`STRIPE PAYOUT 12 AUG`, `SERVICE CHARGE - Q3`), so the keyword sits
 * inside a longer string. The comparison lower-cases both sides rather than
 * upper-casing the keywords at match time, so the exported list stays the
 * SoT-verbatim upper-case form a reader can check against the document.
 */
export function isChaseSuppressed(
  descriptionRaw: string,
  descriptors: readonly string[] = ALL_SUPPRESSION_DESCRIPTORS,
): boolean {
  const haystack = descriptionRaw.toLowerCase();
  return descriptors.some((keyword) => haystack.includes(keyword.toLowerCase()));
}
