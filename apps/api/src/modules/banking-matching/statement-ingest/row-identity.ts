import { createHash } from 'node:crypto';

import type { ParsedRow } from './statement-parser.js';

/**
 * A deterministic identity for a bank line that came out of an uploaded file.
 *
 * ## ⚠ The defect this exists to close
 *
 * A real client held **2,288** `bank_transactions` that were 1,144 rows imported
 * **twice** — identical `booked_at`, `amount_pence`, `description_raw` and
 * `account_id`, from two `statements` rows covering the same
 * 2025-08-01 → 2026-07-31 period, created nine seconds apart. Half of that
 * client's ledger was a lie, and nothing in the product noticed.
 *
 * Three defences existed and all three were inert:
 *
 * | Defence | Why it did nothing |
 * |---|---|
 * | `bank_transactions_account_id_provider_transaction_id_key` | Under D40 there is no provider, so **every** statement-derived row had `provider_transaction_id IS NULL`. Postgres treats NULLs as DISTINCT in a plain unique index, so the constraint admitted unlimited copies. It is not weak here — it is *absent*. |
 * | `documentId` idempotency in `ingestStatement` | Keyed on the document. The two uploads were two different files with two different `byte_hash` values, so it never fired. |
 * | exact-byte dedupe upstream | Same reason: the bank re-exported the same period and the PDFs differed byte for byte. |
 *
 * ## What is hashed, and why an ORDINAL is the whole trick
 *
 * ```
 * sha256( accountId ⋮ bookedOn ⋮ currency ⋮ amountPence ⋮ normalisedDescription ⋮ ordinal )
 * ```
 *
 * `ordinal` is the 1-based occurrence of that exact tuple **within the file being
 * imported**, in file order. It is what separates the two failures that look
 * identical from a single row's point of view:
 *
 * - **A business really can buy the same coffee twice.** Two identical lines in
 *   ONE statement get ordinals 1 and 2, so they hash differently and BOTH
 *   survive. Collapsing them would silently delete a real payment from an
 *   accounting ledger, which is a worse failure than showing two.
 * - **The same file imported twice** replays the same lines in the same order,
 *   so it reproduces ordinals 1 and 2 — the same two hashes — and the unique
 *   index rejects both. Nothing is added.
 *
 * The ordinal is a property of the FILE's content, never of the database, which
 * is what makes it reproduce exactly on a re-read. Deriving it from a count of
 * rows already stored would make the second import produce ordinals 3 and 4 and
 * double the data again.
 *
 * It also holds across *overlapping* statements rather than identical ones: an
 * Aug 1–31 file and an Aug 15 – Sep 15 file agree on every line they share, so
 * the shared lines collide and only September's are added.
 *
 * ## What is deliberately NOT in the hash
 *
 * | Field | Why not |
 * |---|---|
 * | `balanceAfterPence` | It would discriminate better — but a statement with **no balance column** is a real and supported class (D41 `reduced`). A client who sends a balance-less CSV and then a proper PDF of the same month would hash every line differently and double the whole period, which is precisely the bug this file exists to stop. |
 * | `sourceLine` | The same statement as CSV and as a Textract grid has different preamble, so the same transaction sits on different lines. Identity must survive the format. |
 * | `documentId` / `byteHash` | Those are what already failed. Two exports of one period are two documents. |
 *
 * ## ⚠ The one false-skip this can cause, stated plainly
 *
 * D40 gives a business **one implicit `BankAccount`** (`accountFor`), so every
 * statement from every one of that client's bank accounts lands on the same
 * `accountId`. Two *different* bank accounts carrying a byte-identical
 * description, on the same day, for the same pence — a standing charge on a
 * current and a savings account, say — would hash the same and the second would
 * be skipped.
 *
 * That is rare (banks format descriptions differently and amounts rarely agree
 * to the penny), it is strictly less wrong than doubling every client's ledger,
 * and **it is never silent**: `ingestStatement` records how many lines were
 * already present and writes a finding naming them, so it surfaces on the
 * Statements tab rather than being discovered a year later. The real fix is a
 * per-statement bank account, which needs the parser to read an account number
 * and is out of ID's scope (D40).
 */

/** Bumped only when the tuple or the normalisation changes — see below. */
const IDENTITY_VERSION = 'v1';

/**
 * The field separator: ASCII UNIT SEPARATOR, which cannot appear in a parsed
 * description (the readers strip control characters) and so cannot be used to
 * make two different tuples serialise the same way.
 */
const SEP = '\u001F';

/**
 * Descriptions, reduced to what two exports of one line always agree on.
 *
 * Case and run-length of whitespace are the two things that differ between a
 * bank's CSV export and Textract's read of its PDF for the *same* transaction.
 * Nothing else is touched — stripping punctuation or digits would start merging
 * `CARD PAYMENT 1234` with `CARD PAYMENT 5678`, which are different payments.
 */
export function normaliseDescription(description: string): string {
  return description.normalize('NFKC').replace(/\s+/gu, ' ').trim().toUpperCase();
}

/** The tuple a fingerprint is taken over. Exported for the backfill. */
export interface RowIdentityInput {
  readonly accountId: string;
  /** `YYYY-MM-DD`, UTC. The calendar date, never an instant. */
  readonly bookedOn: string;
  readonly currency: string;
  /** Signed integer pence. Never a float — a float would not hash stably. */
  readonly amountPence: number;
  readonly description: string;
  /** 1-based occurrence of this exact tuple within its own source file. */
  readonly ordinal: number;
}

export function importFingerprint(input: RowIdentityInput): string {
  const digest = createHash('sha256')
    .update(
      [
        input.accountId,
        input.bookedOn,
        input.currency,
        String(input.amountPence),
        normaliseDescription(input.description),
        String(input.ordinal),
      ].join(SEP),
      'utf8',
    )
    .digest('hex');
  // The version rides the VALUE rather than a column, so a future change of the
  // tuple is legible in the database and a backfill can find the rows it must
  // re-key. (It does not make an algorithm change safe on its own: `v2` keys
  // would not collide with `v1` ones, so any bump owes a re-key pass.)
  return `${IDENTITY_VERSION}:${digest}`;
}

/**
 * The key that groups occurrences. NOT the stored fingerprint — this is the
 * pre-ordinal tuple, used only to count repeats.
 *
 * Exported because the backfill must group rows **exactly** the way the ingest
 * lane does. Two rows differing only in the case of their description hash to
 * one fingerprint (the description is normalised inside {@link importFingerprint}),
 * so a grouper that did not normalise would hand them both ordinal 1 and produce
 * a unique-constraint violation on the second.
 */
export function identityGroupKey(
  accountId: string,
  bookedOn: string,
  currency: string,
  amountPence: number,
  description: string,
): string {
  return [accountId, bookedOn, currency, String(amountPence), normaliseDescription(description)].join(SEP);
}

/**
 * One fingerprint per parsed row, **aligned to `rows` by index**, with the
 * occurrence ordinal assigned in file order.
 *
 * Returned as a parallel array rather than a mutated row so `ParsedRow` stays
 * what the parser produces — the parser knows nothing about accounts and must
 * not have to.
 */
export function importFingerprintsFor(
  accountId: string,
  currency: string,
  rows: readonly ParsedRow[],
): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = identityGroupKey(accountId, row.bookedOn, currency, row.amountPence, row.description);
    const ordinal = (seen.get(key) ?? 0) + 1;
    seen.set(key, ordinal);
    return importFingerprint({
      accountId,
      bookedOn: row.bookedOn,
      currency,
      amountPence: row.amountPence,
      description: row.description,
      ordinal,
    });
  });
}
