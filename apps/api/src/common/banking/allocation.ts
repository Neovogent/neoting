/**
 * Allocation arithmetic for partial payments, batch payments and credit-note
 * netting (rush/matching, SoT §4 Stage 7). Integer pence only — every value
 * here is signed pence in a BANK LINE's direction: negative is money out.
 */

export interface AllocationCandidate {
  readonly id: string;
  /** Signed pence this candidate would contribute to the line. */
  readonly amountPence: number;
}

export interface CombinationOptions {
  /** Largest combination considered. */
  readonly maxItems?: number;
  /** Stop after this many exact combinations. */
  readonly maxResults?: number;
  /** Hard search budget — the Governance §5.1 unbounded-work stance. */
  readonly maxNodes?: number;
}

/**
 * Bounded subset-sum: combinations of candidates whose signed pence sum EXACTLY
 * to `targetPence`, fewest items first.
 *
 * Depth-first over candidates sorted by size, pruned by the reachable range of
 * the remaining suffix (the most negative and most positive sums still
 * possible), so same-signed inputs — the common case, four invoices against one
 * payment — prune hard, and mixed signs (a credit note netted inside a batch)
 * stay correct within the node budget.
 *
 * ponytail: exponential in the worst case, capped by `maxNodes`; a
 * pseudo-polynomial DP over pence is the upgrade if a client ever needs 40+
 * open invoices from one supplier searched exhaustively.
 */
export function findExactCombinations(
  targetPence: number,
  candidates: readonly AllocationCandidate[],
  options: CombinationOptions = {},
): string[][] {
  const maxItems = options.maxItems ?? 8;
  const maxResults = options.maxResults ?? 5;
  const maxNodes = options.maxNodes ?? 50_000;
  if (!Number.isSafeInteger(targetPence) || targetPence === 0) return [];

  const items = candidates
    .filter((c) => Number.isSafeInteger(c.amountPence) && c.amountPence !== 0)
    .sort((a, b) => Math.abs(b.amountPence) - Math.abs(a.amountPence) || a.id.localeCompare(b.id));
  const n = items.length;
  const posSuffix = new Array<number>(n + 1).fill(0);
  const negSuffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const v = items[i]!.amountPence;
    posSuffix[i] = posSuffix[i + 1]! + Math.max(v, 0);
    negSuffix[i] = negSuffix[i + 1]! + Math.min(v, 0);
  }

  const results: string[][] = [];
  const chosen: string[] = [];
  let nodes = 0;
  const walk = (i: number, remaining: number): void => {
    if (results.length >= maxResults || ++nodes > maxNodes) return;
    if (remaining === 0 && chosen.length > 0) {
      results.push([...chosen]);
      return;
    }
    if (i >= n || chosen.length >= maxItems) return;
    if (remaining > posSuffix[i]! || remaining < negSuffix[i]!) return;
    const item = items[i]!;
    chosen.push(item.id);
    walk(i + 1, remaining - item.amountPence);
    chosen.pop();
    walk(i + 1, remaining);
  };
  walk(0, targetPence);
  return results.sort((a, b) => a.length - b.length);
}

/** What the allocation maths needs to know about a document. */
export interface SettlementDocument {
  readonly inbox: string | null;
  readonly docType: string | null;
  readonly totalPence: number | null;
}

/**
 * Which way this document should move the bank: a purchase takes money out
 * (−1); a sale, a supplier credit note or a refund of a purchase brings it in
 * (+1). A credit on the sales side flips the other way.
 */
export function expectedDirection(doc: SettlementDocument): 1 | -1 {
  const credit = doc.docType === 'CREDIT_NOTE' || (doc.totalPence ?? 0) < 0;
  const base = doc.inbox === 'SALES' ? 1 : -1;
  return (credit ? -base : base) as 1 | -1;
}

/** The document's signed bank effect, or null when it has no total. */
export function expectedPence(doc: SettlementDocument): number | null {
  if (doc.totalPence === null || doc.totalPence === 0) return null;
  return expectedDirection(doc) * Math.abs(doc.totalPence);
}

export interface Settlement {
  /** Allocations in the expected direction, unsigned. */
  readonly paidPence: number;
  /** Allocations against it (a refund of a purchase), unsigned. */
  readonly refundedPence: number;
  /** Signed remainder still to settle, in the expected direction. */
  readonly outstandingPence: number;
  readonly status: 'unpaid' | 'part-paid' | 'paid';
}

/**
 * Where a document stands given its live CONFIRMED allocations. An allocation
 * of `null` is a legacy one-to-one match and settles the whole document.
 * A document is PAID when its allocations cover its gross.
 */
export function settle(doc: SettlementDocument, allocations: readonly (number | null)[]): Settlement {
  const gross = Math.abs(doc.totalPence ?? 0);
  const dir = expectedDirection(doc);
  let paid = 0;
  let refunded = 0;
  for (const amount of allocations) {
    if (amount === null) paid += gross;
    else if (Math.sign(amount) === dir) paid += Math.abs(amount);
    else refunded += Math.abs(amount);
  }
  const outstanding = Math.max(gross - paid, 0);
  return {
    paidPence: paid,
    refundedPence: refunded,
    outstandingPence: dir * outstanding,
    status: gross > 0 && paid >= gross ? 'paid' : paid > 0 ? 'part-paid' : 'unpaid',
  };
}
