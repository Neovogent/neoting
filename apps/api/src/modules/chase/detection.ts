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

import type { Chase as ChaseRow } from '@prisma/client';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { chaseItemRefs } from './chase-projection.js';
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
 * The rows {@link alreadyChasedTransactionIds} narrows — a chase's identity of
 * what it covers. The grouped list and the single-transaction convenience
 * column, exactly the pair `chaseItemRefs` reads.
 */
export type ChaseCoverageRow = Pick<ChaseRow, 'itemRefs' | 'transactionId'>;

/**
 * Every transaction some chase already covers — the **do-not-over-ask** set
 * (launch stage A13).
 *
 * SoT §24.2.3 is unusually blunt about why this exists: *"Over-chasing is the
 * failure mode, not under-chasing. A client who is asked every month for a
 * receipt that cannot exist stops reading the messages, and then the chase that
 * matters is ignored too"*, and *"re-asking an answered question is the single
 * biggest cause of chase fatigue"*. Suppression is a first-class part of the
 * engine there, not a filter bolted on, which is why this sits inside detection
 * rather than in whatever eventually composes the message.
 *
 * PURE, and split from the read the way `isChaseSuppressed` is, so the rule can
 * be unit-tested without a database.
 *
 * **Any chase suppresses, whatever state it is in**, and the three cases are
 * worth naming because they arrive by different routes and all end the same
 * way:
 *
 *  - **open** (`DETECTED`…`ESCALATED`) — we have already asked. Asking again is
 *    the same request twice, and reminders are a policy-scheduler feature that
 *    does not exist (see this module's TODO); until it does, silence is the
 *    correct second message.
 *  - **closed received** (`CLOSED_RECEIVED`) — auto-close already matched an
 *    inbound document to this line (`auto-close.ts`). Chasing now is chasing
 *    for a receipt we are holding, which is precisely how the product loses a
 *    client in week one.
 *  - **closed otherwise** (`CLOSED_UNAVAILABLE` / `CLOSED_DISMISSED` /
 *    `CLOSED_SUPPRESSED`) — somebody decided this line is not to be chased:
 *    the client said the paperwork does not exist, or the accountant dismissed
 *    it. Re-detecting it would quietly overturn that decision, which is the
 *    answered-question case §24.2.3 names as the worst one.
 *
 * Because every `ChaseState` is one of those three, the predicate is simply
 * "a chase exists". It is written as a set over `itemRefs` rather than a
 * `transactionId` filter because a grouped chase covers many receipts in one
 * message (SoT §8.2) and only the first is in the convenience column — keying
 * on that alone would re-chase every line but the first.
 */
export function alreadyChasedTransactionIds(chases: readonly ChaseCoverageRow[]): Set<string> {
  const covered = new Set<string>();
  for (const chase of chases) {
    for (const ref of chaseItemRefs(chase)) covered.add(ref);
  }
  return covered;
}

/**
 * The unmatched, non-suppressed, not-already-chased transactions for one
 * business — detection engine (a). Takes a `ScopedClient`: the CALLER opens the
 * `scopedDb` transaction, so RLS decides which rows are even visible and this
 * function never sees another tenant's data.
 *
 * **Four gates, and each closes a different way of asking for something we
 * already have:**
 *
 *  - the stored `chaseSuppressed` flag (SoT Stage 7 — a line marked suppressed
 *    at import time, e.g. by the per-client extension the seed sets);
 *  - the descriptor keyword list, matched against `descriptionRaw` in memory,
 *    so a line the flag missed is still not chased;
 *  - `matchState = UNMATCHED`, which is the "no matched document" half of
 *    engine (a) and also the **document already received** gate: a line whose
 *    paperwork has arrived is `SUGGESTED` or `CONFIRMED` and never appears
 *    here, whichever channel brought the document in;
 *  - {@link alreadyChasedTransactionIds}, the **chase already open** gate.
 *
 * ⚠ None of this is a second opinion. The descriptor list is
 * `suppression.ts`'s, the coverage set is built from `chase-projection.ts`'s
 * `chaseItemRefs`, and "the document arrived" is decided by the match state
 * `auto-close.ts` and `bank.confirm-match` maintain. A fifth rule that
 * re-derived any of those in its own words is how the accountant's screen and
 * the client's inbox start disagreeing.
 */
export async function detectUnmatchedChases(
  db: ScopedClient,
  businessId: string,
): Promise<UnmatchedTransaction[]> {
  // Every chase this business has ever had, in any state — see
  // `alreadyChasedTransactionIds` for why the state is not filtered. Two
  // columns only; `itemRefs` is the grouped list and `transactionId` its
  // fallback.
  const chases = await db.chase.findMany({
    where: { businessId },
    select: { itemRefs: true, transactionId: true },
  });
  const alreadyChased = alreadyChasedTransactionIds(chases);

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
    .filter((row) => !alreadyChased.has(row.id))
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
