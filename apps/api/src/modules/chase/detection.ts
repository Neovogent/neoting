/**
 * Detection engine (a) — unmatched bank transactions (SoT §4 Stage 8.1).
 *
 * SoT Stage 8 names five detection engines:
 *   (a) bank transaction with no matched document;
 *   (b) supplier-statement line with status Missing;
 *   (c) bank-statement period gap;
 *   (d) accounting-software transaction without an attachment;
 *   (e) expected recurring document not arrived.
 *
 * // DEMO-MOCK: only engine (a) is built. Engines (b)–(e) are FIXTURE for the
 * // demo (METH_MODE Stage 8, PRD row "Detection engines (five)"), each a
 * // separate detector behind this same shape post-demo.
 *
 * Engine (a) is: a business's UNMATCHED bank transactions that are not
 * suppressed. A suppressed line is a bank-originated charge with no paperwork to
 * chase (SoT Stage 7) — see `suppression.ts`. Money stays integer pence; this is
 * a read, so no arithmetic touches it at all.
 */

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { isChaseSuppressed } from './suppression.js';

/**
 * One unmatched, chaseable transaction. Pence stays integer; the descriptor and
 * merchant name are the bank feed's own text (untrusted for display, but never
 * fed to a model here — composition interpolates the amount and date, not this).
 */
export interface UnmatchedTransaction {
  readonly transactionId: string;
  readonly businessId: string;
  /** Signed pence — negative is money out (SoT Stage 7 normalised schema). */
  readonly amountPence: number;
  readonly currency: string;
  readonly bookedAt: Date;
  readonly descriptionRaw: string;
  readonly merchantName: string | null;
}

/**
 * The unmatched, non-suppressed transactions for one business — detection
 * engine (a). Takes a `ScopedClient`: the CALLER opens the `scopedDb`
 * transaction, so RLS decides which rows are even visible and this function
 * never sees another tenant's data.
 *
 * Two suppression gates, both honoured:
 *  - the stored `chaseSuppressed` flag (SoT Stage 7 — a line marked suppressed
 *    at import time, e.g. by the per-client extension the seed sets);
 *  - the descriptor keyword list, matched against `descriptionRaw` in memory,
 *    so a line the flag missed is still not chased.
 * The `matchState` filter (`UNMATCHED` only) is the "no matched document" half.
 */
export async function detectUnmatchedChases(
  db: ScopedClient,
  businessId: string,
): Promise<UnmatchedTransaction[]> {
  const rows = await db.bankTransaction.findMany({
    where: {
      businessId,
      matchState: 'UNMATCHED',
      // The stored flag is the cheap gate the index can answer; the descriptor
      // scan below is the belt-and-braces the SoT list guarantees.
      chaseSuppressed: false,
    },
    select: {
      id: true,
      businessId: true,
      amountPence: true,
      currency: true,
      bookedAt: true,
      descriptionRaw: true,
      merchantName: true,
    },
    orderBy: { bookedAt: 'desc' },
  });

  return rows
    .filter((row) => !isChaseSuppressed(row.descriptionRaw))
    .map((row) => ({
      transactionId: row.id,
      businessId: row.businessId,
      amountPence: row.amountPence,
      currency: row.currency,
      bookedAt: row.bookedAt,
      descriptionRaw: row.descriptionRaw,
      merchantName: row.merchantName,
    }));
}
