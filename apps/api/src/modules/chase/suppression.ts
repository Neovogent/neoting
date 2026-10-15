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

// ── Per-client suppression (rush/chase-detection) ───────────────────────────

/**
 * The list a client starts from: the SoT list, the found-live additions, and
 * INTEREST / TRANSFER (owner's list). Editable per client — an accountant whose
 * client pays suppliers by "TRANSFER" removes it on that client's Settings tab.
 *
 * ⚠ Ingest's stored `chaseSuppressed` flag still uses
 * `ALL_SUPPRESSION_DESCRIPTORS`; this list is applied at detection and compose.
 */
export const DEFAULT_CLIENT_SUPPRESSION_KEYWORDS: readonly string[] = Object.freeze([
  ...ALL_SUPPRESSION_DESCRIPTORS,
  'INTEREST',
  'TRANSFER',
]);

export interface ClientSuppression {
  readonly keywords: readonly string[];
  /** Normalised supplier keys (see {@link supplierKey}) the client said have no receipt. */
  readonly noReceiptSuppliers: readonly string[];
  /** True when the client has no row and is on {@link DEFAULT_CLIENT_SUPPRESSION_KEYWORDS}. */
  readonly isDefault: boolean;
}

/**
 * A supplier label reduced to what stays the same between two payments to it:
 * lower case, punctuation and standalone numbers (store ids, card suffixes,
 * dates) dropped. `CURRYS PC WORLD 1234` and `Currys PC World 5678` share a key.
 */
export function supplierKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a line or finding is suppressed for THIS client: a descriptor
 * keyword hit, or a supplier the client already said has no receipt.
 * ponytail: learned match is whole-word containment of the stored key.
 */
export function isSuppressedForClient(
  suppression: ClientSuppression,
  text: { readonly descriptionRaw?: string | null; readonly supplierLabel?: string | null },
): boolean {
  const descriptor = text.descriptionRaw ?? text.supplierLabel ?? '';
  if (descriptor !== '' && isChaseSuppressed(descriptor, suppression.keywords)) return true;
  const padded = ` ${supplierKey([text.supplierLabel, text.descriptionRaw].filter(Boolean).join(' '))} `;
  return suppression.noReceiptSuppliers.some((key) => key !== '' && padded.includes(` ${key} `));
}

/** Minimal read shape so this works on any `ScopedClient`. */
interface SuppressionReader {
  chaseSuppressionSetting: {
    findUnique(args: {
      where: { businessId: string };
      select: { keywords: true; noReceiptSuppliers: true };
    }): Promise<{ keywords: string[]; noReceiptSuppliers: string[] } | null>;
  };
}

/** The client's effective suppression, through the caller's scoped transaction. */
export async function loadClientSuppression(db: SuppressionReader, businessId: string): Promise<ClientSuppression> {
  const row = await db.chaseSuppressionSetting.findUnique({
    where: { businessId },
    select: { keywords: true, noReceiptSuppliers: true },
  });
  return row === null
    ? { keywords: DEFAULT_CLIENT_SUPPRESSION_KEYWORDS, noReceiptSuppliers: [], isDefault: true }
    : { keywords: row.keywords, noReceiptSuppliers: row.noReceiptSuppliers, isDefault: false };
}
