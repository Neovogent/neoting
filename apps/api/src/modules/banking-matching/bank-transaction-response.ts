import type { BankTransaction } from '@neoting/contracts/model';
import type { BankTransaction as BankTransactionRow } from '@prisma/client';

/**
 * One `bank_transactions` row in the contract's normalised shape (SoT §4
 * Stage 7, `BankTransaction` in `openapi.yaml`).
 *
 * Its own file, next to the service, for the reason `common/documents/` exists:
 * the moment a second surface projects this row — a match view, an export — the
 * projection must be the same one, or the two start disagreeing about what a
 * transaction is, which is the drift the generated contract exists to prevent.
 *
 * Three things are deliberate:
 *
 * - **`amountPence` is copied, never converted.** It is a signed integer in the
 *   column, a signed integer in the contract (`x-nt-money: true`), and nothing
 *   between the two is allowed to divide it. The Bank screen renders pounds;
 *   that division happens once, in the web boundary, on a value this endpoint
 *   never rounded.
 * - **`chaseSuppressed` is read off the column, not recomputed here.** The
 *   descriptor rules belong to the chase lane, and a second implementation of
 *   them on the read path is how the Bank screen and the chase list start
 *   disagreeing about which lines have paperwork to chase. The column is the
 *   one answer both read.
 * - **The optional columns emit `null`, not `undefined`.** The contract types
 *   them `[string, 'null']`, and JSON.stringify drops an undefined member
 *   entirely — a required-but-nullable field vanishing from the body is a
 *   contract violation the generated client's Zod parse would reject at the
 *   consumer, far from here.
 */
/**
 * The CONFIRMED match's document id, when the caller joined it in — the list
 * and the bank-match read both pass it; a caller with no join passes null.
 */
export function toBankTransaction(row: BankTransactionRow, matchedDocumentId: string | null = null): BankTransaction {
  return {
    id: row.id,
    businessId: row.businessId,
    accountId: row.accountId,
    // UTC in storage, ISO-8601 on the wire; Europe/London is a rendering
    // concern and belongs to the client, not to this projection.
    bookedAt: row.bookedAt.toISOString(),
    amountPence: row.amountPence,
    currency: row.currency,
    descriptionRaw: row.descriptionRaw,
    merchantName: row.merchantName,
    classification: row.classification,
    balanceAfterPence: row.balanceAfterPence,
    matchState: row.matchState,
    chaseSuppressed: row.chaseSuppressed,
    matchedDocumentId,
  };
}
