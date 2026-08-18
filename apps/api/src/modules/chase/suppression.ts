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
  descriptors: readonly string[] = SUPPRESSION_DESCRIPTORS,
): boolean {
  const haystack = descriptionRaw.toLowerCase();
  return descriptors.some((keyword) => haystack.includes(keyword.toLowerCase()));
}
