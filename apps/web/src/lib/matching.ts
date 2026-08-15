import type { BankTransaction, Document, MatchKind, MatchSettings } from './types';

export const DEFAULT_MATCH_SETTINGS: MatchSettings = {
  documentWindow: 30,
  dueWindow: 10,
  lookbackMonths: 6,
  allowProbable: true,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parses the "09 Aug 2026" format used throughout the pipeline. */
export function parseDate(s: string): number | null {
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})$/);
  if (!m) return null;
  const [, day, mon, year] = m;
  // Unreachable: none of the three groups is optional, so a match means all
  // three participated.
  if (!day || !mon || !year) return null;
  const month = MONTHS.indexOf(mon.slice(0, 3));
  if (month < 0) return null;
  return Date.UTC(Number(year), month, Number(day));
}

export function daysBetween(a: string, b: string): number | null {
  const x = parseDate(a);
  const y = parseDate(b);
  if (x === null || y === null) return null;
  return Math.round((x - y) / 86400000);
}

/**
 * Normalises merchant names so "BIDFOOD UK LTD" on a bank line matches the
 * "Bidfood UK" printed on the invoice. Dext's matcher is literal here.
 */
export function normaliseMerchant(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(ltd|limited|plc|llp|uk|inc|co|company|group|online|payments?|card|refund)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Whether two names refer to the same merchant.
 *
 * The bar admits one name containing the other — "Brakes Bros Limited" is the
 * receipt for a request logged against "Brakes", and "Screwfix Direct" is
 * Screwfix. That is safe here only because callers anchor on more than the
 * name: a chase item closes when the client matches and the amount matches to
 * the penny as well. It stays tight enough to keep Costco off Costa and
 * Amazon Business off Amazon Web Services.
 */
export const sameMerchant = (a: string, b: string) => merchantSimilarity(a, b) > 0.8;

/**
 * Character-bigram overlap (Dice coefficient), 0..1.
 *
 * ⚠ THIS USED TO BE A POSITIONAL COMPARISON — `if (x[i] === y[i]) shared++` —
 * under a comment that said "token overlap". Comment and code disagreed, and
 * the code was the wrong one: positional comparison collapses to near zero the
 * moment one string is shifted by a character, so "jsainsbury" against
 * "sainsburys" scored ~0.1 while "abc" against "abd" scored 0.67. It measured
 * alignment, not similarity.
 *
 * Bigrams are shift-invariant, which is the property actually wanted here:
 * bank descriptions carry prefixes and reference numbers that the invoice
 * does not.
 *
 * The thresholds either side of this are UNCHANGED (0.8 for sameMerchant,
 * 0.5 in matchCandidates) — this fixes the measure, not the bar. Worth knowing
 * that the docstring's "keep Costco off Costa" is upheld by the 0.8 bar and
 * not by the 0.5 one: those two score ~0.67 under either measure.
 */
function merchantSimilarity(a: string, b: string): number {
  const x = normaliseMerchant(a);
  const y = normaliseMerchant(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;

  // A single character has no bigrams; without this the Dice denominator is 0.
  if (x.length < 2 || y.length < 2) return 0;

  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };

  const bx = bigrams(x);
  const by = bigrams(y);

  // Multiset intersection: a repeated bigram only counts as often as it
  // appears in BOTH, so "aaaa" does not score highly against "aa".
  let shared = 0;
  for (const [g, n] of bx) shared += Math.min(n, by.get(g) ?? 0);

  return (2 * shared) / (x.length - 1 + (y.length - 1));
}

export interface Candidate {
  document: Document;
  confidence: number;
  kind: MatchKind;
  reason: string;
}

/**
 * Ranks documents that could explain a transaction.
 *
 * Deterministic rules at Dext parity — equal totals inside the date window —
 * extended with credit-note handling, fuzzy merchant names, partial payments
 * and a clearly-labelled probable tier.
 */
export function matchCandidates(
  txn: BankTransaction,
  documents: Document[],
  settings: MatchSettings,
): Candidate[] {
  const pool = documents.filter(
    (d) => d.clientId === txn.clientId && d.status !== 'rejected' && !d.id.startsWith('matched-'),
  );

  const candidates: Candidate[] = [];

  for (const doc of pool) {
    const gap = daysBetween(txn.date, doc.date);
    // Outside the lookback there is nothing to consider.
    if (gap !== null && (gap < -settings.dueWindow || gap > settings.lookbackMonths * 31)) continue;

    const amountsEqual = Math.abs(Math.abs(doc.total) - Math.abs(txn.amount)) < 0.01;
    const merchant = merchantSimilarity(txn.description, doc.supplier);
    const inWindow = gap === null || (gap >= -settings.dueWindow && gap <= settings.documentWindow);

    // ⚠ THE MERCHANT AND WINDOW TESTS ARE NOT OPTIONAL HERE, AND THEY USED TO
    // BE MISSING. This branch checked only that the absolute amounts were
    // equal, yet scored 0.94 — above CONFIDENT_MIN — so autoMatches linked it
    // with nobody looking. A £340 refund from "RANDOM UNRELATED CO"
    // auto-linked to an Uber Eats £340 invoice, while the equivalent
    // non-credit transaction scored 0.86 and was correctly held back. It was
    // the one place in the matcher where the LOOSER case got the HIGHER
    // confidence, which reads as an inverted condition rather than an intended
    // relaxation.
    //
    // A refund genuinely from a different supplier than the invoice is not a
    // match worth making silently. The two conditions below are the same ones
    // the exact branch immediately after this already requires.
    //
    // Partial mitigation that hid this: clearWinner needs a CLEAR_GAP over the
    // runner-up, so two documents sharing an amount both score 0.94, the gap is
    // zero, and it goes to a human. It bit when exactly ONE document in the
    // lookback shared the amount — the common case for a small client, and the
    // case where that single document can be the wrong supplier entirely.
    if (amountsEqual && txn.isCredit && inWindow && merchant > 0.5) {
      candidates.push({
        document: doc,
        confidence: 0.94,
        kind: 'credit-note',
        reason: 'Negative amount matched to a credit note or refund from the same supplier.',
      });
      continue;
    }

    // A credit that failed the gate above is still worth SHOWING — it just must
    // not be linked without a person. Refunds routinely lag their invoice by
    // more than the document window, so without this a legitimate late refund
    // would produce no candidate at all and disappear from review rather than
    // being asked about. Deliberately below CONFIDENT_MIN.
    //
    // Anything reaching here failed (inWindow && merchant > 0.5), so it cannot
    // satisfy the exact branch below either — this does not shadow it.
    if (amountsEqual && txn.isCredit) {
      candidates.push({
        document: doc,
        confidence: 0.6,
        kind: 'credit-note',
        reason: 'Equal amount and a credit, but the supplier name or the date window does not line up.',
      });
      continue;
    }

    if (amountsEqual && inWindow && merchant > 0.5) {
      candidates.push({
        document: doc,
        confidence: 1,
        kind: 'exact',
        reason: `Equal totals, paid ${gap ?? 0} day${Math.abs(gap ?? 0) === 1 ? '' : 's'} after the document date.`,
      });
      continue;
    }

    if (amountsEqual && inWindow) {
      candidates.push({
        document: doc,
        confidence: 0.86,
        kind: 'exact',
        reason: 'Equal totals inside the date window, but the merchant name differs.',
      });
      continue;
    }

    if (Math.abs(doc.total) < Math.abs(txn.amount) && merchant > 0.6 && inWindow) {
      candidates.push({
        document: doc,
        confidence: 0.72,
        kind: 'partial',
        reason: 'This payment appears to settle several invoices, including this one.',
      });
      continue;
    }

    if (settings.allowProbable && merchant > 0.7 && inWindow) {
      candidates.push({
        document: doc,
        confidence: 0.48,
        kind: 'probable',
        reason: 'Merchant name normalises to the same supplier, but the amounts differ.',
      });
    }
  }

  return candidates.sort((a, b) => b.confidence - a.confidence).slice(0, 6);
}

/** Above this, a candidate is strong enough to link without asking. */
export const CONFIDENT_MIN = 0.9;
/** A winner must beat the runner-up by this much, or it is a coin toss. */
export const CLEAR_GAP = 0.15;

export type MatchVerdictKind = 'confident' | 'confused' | 'none';

export interface MatchVerdict {
  kind: MatchVerdictKind;
  candidates: Candidate[];
  best?: Candidate;
  /** Plain-English account of what the matcher could or could not settle. */
  reason: string;
}

/**
 * Decides whether a transaction needs a human at all.
 *
 * A clear winner is linked without asking. Anything else — a tie, or nothing
 * better than a probable fit — is handed over with its candidates, because a
 * guess dressed up as a match is worse than an honest question.
 */
export function assessTransaction(
  txn: BankTransaction,
  documents: Document[],
  settings: MatchSettings,
): MatchVerdict {
  const candidates = matchCandidates(txn, documents, settings);

  // Reading the first entry is the empty check: matchCandidates builds a dense
  // array, so a missing candidates[0] means there were none at all.
  const best = candidates[0];
  if (!best) {
    return {
      kind: 'none',
      candidates,
      reason: 'Nothing in this client’s documents could explain it inside the current match window.',
    };
  }

  const runner = candidates[1];
  const clearWinner = best.confidence >= CONFIDENT_MIN && (!runner || best.confidence - runner.confidence >= CLEAR_GAP);

  if (clearWinner) return { kind: 'confident', candidates, best, reason: best.reason };

  const tied = candidates.filter((c) => Math.abs(c.confidence - best.confidence) < 0.01).length;
  const reason =
    tied > 1
      ? `${tied} documents fit this transaction equally well — only you can say which one it is.`
      : best.confidence < CONFIDENT_MIN
        ? 'The closest document is a probable fit only: the amount or the date does not line up exactly.'
        : 'The top two candidates are too close to call.';

  return { kind: 'confused', candidates, best, reason };
}

export interface AutoMatch {
  txnId: string;
  candidate: Candidate;
}

/**
 * Every transaction the matcher can settle on its own. Run once over the
 * starting data so the queue only ever contains genuine questions.
 */
export function autoMatches(
  transactions: BankTransaction[],
  documents: Document[],
  settings: MatchSettings,
): AutoMatch[] {
  const claimed = new Set(transactions.filter((t) => t.matchedDocId).map((t) => t.matchedDocId as string));
  const result: AutoMatch[] = [];

  for (const txn of transactions) {
    if (txn.matchedDocId) continue;
    const verdict = assessTransaction(txn, documents, settings);
    // One document cannot explain two different transactions.
    if (verdict.kind !== 'confident' || !verdict.best || claimed.has(verdict.best.document.id)) continue;
    claimed.add(verdict.best.document.id);
    result.push({ txnId: txn.id, candidate: verdict.best });
  }

  return result;
}

export function shortLabel(doc: Document) {
  return `${doc.supplier} · £${Math.abs(doc.total).toFixed(2)} · ${doc.date.replace(/ \d{4}$/, '')}`;
}

export function txnLabel(txn: BankTransaction) {
  return `${txn.description} · £${Math.abs(txn.amount).toFixed(2)} · ${txn.date.replace(/ \d{4}$/, '')}`;
}
