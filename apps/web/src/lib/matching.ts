import { defineMessages, type IntlShape } from 'react-intl';
import type { BankTransaction, Document, MatchKind, MatchSettings } from './types';

/**
 * Bank matching — the explanations, and why `intl` is a parameter.
 *
 * This is not a component, so it cannot call `useIntl`: every sentence below is
 * a `MessageDescriptor` (`i18n/index.ts`). They are formatted here rather than
 * handed back unformatted because a match reason ends up in `Match.reason`, a
 * plain string in the shared contract, written once when the matcher links a
 * transaction and read long afterwards — and because the reason that carries a
 * day count is only the matcher's to fill in. So the caller passes its `intl`
 * in and gets finished sentences back, which is the second shape §12.6 allows
 * for a module with no hooks of its own. `dedupe.ts` does the same.
 */
const m = defineMessages({
  reasonCreditNoteSameSupplier: {
    id: 'pipeline.matching.reasonCreditNoteSameSupplier',
    defaultMessage: 'Negative amount matched to a credit note or refund from the same supplier.',
  },
  reasonCreditNoteUnaligned: {
    id: 'pipeline.matching.reasonCreditNoteUnaligned',
    defaultMessage: 'Equal amount and a credit, but the supplier name or the date window does not line up.',
  },
  // Was `paid ${gap} day${Math.abs(gap) === 1 ? '' : 's'} after` — a plural
  // built by concatenation, which §12.6 forbids. ICU keeps the existing
  // behaviour exactly, negative gaps included: CLDR selects `one` for -1, which
  // is what `Math.abs(gap) === 1` used to decide.
  reasonExactWithGap: {
    id: 'pipeline.matching.reasonExactWithGap',
    defaultMessage:
      '{days, plural, one {Equal totals, paid # day after the document date.} other {Equal totals, paid # days after the document date.}}',
  },
  reasonExactMerchantDiffers: {
    id: 'pipeline.matching.reasonExactMerchantDiffers',
    defaultMessage: 'Equal totals inside the date window, but the merchant name differs.',
  },
  reasonPartial: {
    id: 'pipeline.matching.reasonPartial',
    defaultMessage: 'This payment appears to settle several invoices, including this one.',
  },
  reasonProbable: {
    id: 'pipeline.matching.reasonProbable',
    defaultMessage: 'Merchant name normalises to the same supplier, but the amounts differ.',
  },

  verdictNothingExplains: {
    id: 'pipeline.matching.verdictNothingExplains',
    defaultMessage: 'Nothing in this client’s documents could explain it inside the current match window.',
  },
  // `other` alone, deliberately: the branch is guarded by `tied > 1`, so a
  // singular can never render and inventing English for it would put a sentence
  // in the catalogue that contradicts itself ("1 document … which one it is").
  // A locale that distinguishes 2–4 from 5+ still adds those arms in its own
  // catalogue, which a bare `{count}` would not have allowed.
  verdictTied: {
    id: 'pipeline.matching.verdictTied',
    defaultMessage:
      '{count, plural, other {# documents fit this transaction equally well — only you can say which one it is.}}',
  },
  verdictProbableOnly: {
    id: 'pipeline.matching.verdictProbableOnly',
    defaultMessage: 'The closest document is a probable fit only: the amount or the date does not line up exactly.',
  },
  verdictTooClose: {
    id: 'pipeline.matching.verdictTooClose',
    defaultMessage: 'The top two candidates are too close to call.',
  },
});

export const DEFAULT_MATCH_SETTINGS: MatchSettings = {
  documentWindow: 30,
  dueWindow: 10,
  lookbackMonths: 6,
  allowProbable: true,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Parses the "09 Aug 2026" format used throughout the pipeline. */
export function parseDate(s: string): number | null {
  // `parts`, not `m`: `m` is the message catalogue at module scope now.
  const parts = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})$/);
  if (!parts) return null;
  const [, day, mon, year] = parts;
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
 * The largest relative amount gap the PROBABLE tier tolerates on a DEBIT.
 *
 * A supplier a restaurant pays weekly makes a name-only hit the EXPECTED
 * collision, not evidence: every one of those payments normalises to the same
 * merchant, and a candidate whose amount is materially different is almost
 * certainly a different invoice. Ten per cent admits the near-misses worth a
 * human's eyes (a card surcharge, a rounding difference) and refuses the
 * £674-vs-£994 shape that shipped as "Probable 48%" (review item 32, 5 Sep
 * 2026). Credits are deliberately NOT held to it — a partial refund genuinely
 * differs from its invoice, and the question is real.
 */
export const PROBABLE_AMOUNT_TOLERANCE = 0.1;

/**
 * Ranks documents that could explain a transaction.
 *
 * Deterministic rules at Dext parity — equal totals inside the date window —
 * extended with credit-note handling, fuzzy merchant names, partial payments
 * and a clearly-labelled probable tier.
 *
 * `claimedDocIds` — documents already matched to ANOTHER transaction. One
 * receipt cannot answer two bank lines, so a claimed document is out of the
 * pool entirely rather than merely losing the auto-link (which was the only
 * place the claimed set used to be consulted — the candidate DIALOG offered a
 * matched-and-published document as "Probable" for a second transaction,
 * review item 32). Callers build it from `matchedDocId`, which live is set on
 * exactly the CONFIRMED rows — that is the contract's design, not a gap.
 */
export function matchCandidates(
  intl: IntlShape,
  txn: BankTransaction,
  documents: Document[],
  settings: MatchSettings,
  claimedDocIds?: ReadonlySet<string>,
): Candidate[] {
  const pool = documents.filter(
    (d) =>
      d.clientId === txn.clientId &&
      d.status !== 'rejected' &&
      !d.id.startsWith('matched-') &&
      claimedDocIds?.has(d.id) !== true,
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
        reason: intl.formatMessage(m.reasonCreditNoteSameSupplier),
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
        reason: intl.formatMessage(m.reasonCreditNoteUnaligned),
      });
      continue;
    }

    if (amountsEqual && inWindow && merchant > 0.5) {
      candidates.push({
        document: doc,
        confidence: 1,
        kind: 'exact',
        reason: intl.formatMessage(m.reasonExactWithGap, { days: gap ?? 0 }),
      });
      continue;
    }

    if (amountsEqual && inWindow) {
      candidates.push({
        document: doc,
        confidence: 0.86,
        kind: 'exact',
        reason: intl.formatMessage(m.reasonExactMerchantDiffers),
      });
      continue;
    }

    if (Math.abs(doc.total) < Math.abs(txn.amount) && merchant > 0.6 && inWindow) {
      candidates.push({
        document: doc,
        confidence: 0.72,
        kind: 'partial',
        reason: intl.formatMessage(m.reasonPartial),
      });
      continue;
    }

    if (settings.allowProbable && merchant > 0.7 && inWindow) {
      // ⚠ The probable tier is SPLIT BY SIGN since review item 32 (5 Sep 2026).
      //
      // This branch used to fire on the merchant name alone, so a £674.46
      // payment to a weekly supplier offered that supplier's £994.00 invoice
      // from a month earlier as "Probable 48%". For a DEBIT, amount
      // disagreement now crushes the candidate out entirely: a repeat
      // supplier's name matches EVERY one of their payments, so the name
      // carries no information and the amount is the evidence. Within the
      // tolerance the confidence still scales down with the gap, so a
      // penny-close near-miss outranks a 9%-off one.
      //
      // A CREDIT keeps the old behaviour on purpose: a partial refund
      // genuinely differs from its invoice, and "same supplier, different
      // amount" is a real question for a human there — pinned by the seeded
      // £212.40 Bidfood refund case.
      const larger = Math.max(Math.abs(doc.total), Math.abs(txn.amount));
      const relativeGap = larger === 0 ? 0 : Math.abs(Math.abs(doc.total) - Math.abs(txn.amount)) / larger;
      if (txn.isCredit) {
        candidates.push({
          document: doc,
          confidence: 0.48,
          kind: 'probable',
          reason: intl.formatMessage(m.reasonProbable),
        });
      } else if (relativeGap <= PROBABLE_AMOUNT_TOLERANCE) {
        candidates.push({
          document: doc,
          confidence: 0.48 * (1 - relativeGap),
          kind: 'probable',
          reason: intl.formatMessage(m.reasonProbable),
        });
      }
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
  intl: IntlShape,
  txn: BankTransaction,
  documents: Document[],
  settings: MatchSettings,
  claimedDocIds?: ReadonlySet<string>,
): MatchVerdict {
  const candidates = matchCandidates(intl, txn, documents, settings, claimedDocIds);

  // Reading the first entry is the empty check: matchCandidates builds a dense
  // array, so a missing candidates[0] means there were none at all.
  const best = candidates[0];
  if (!best) {
    return {
      kind: 'none',
      candidates,
      reason: intl.formatMessage(m.verdictNothingExplains),
    };
  }

  const runner = candidates[1];
  const clearWinner = best.confidence >= CONFIDENT_MIN && (!runner || best.confidence - runner.confidence >= CLEAR_GAP);

  if (clearWinner) return { kind: 'confident', candidates, best, reason: best.reason };

  const tied = candidates.filter((c) => Math.abs(c.confidence - best.confidence) < 0.01).length;
  const reason =
    tied > 1
      ? intl.formatMessage(m.verdictTied, { count: tied })
      : best.confidence < CONFIDENT_MIN
        ? intl.formatMessage(m.verdictProbableOnly)
        : intl.formatMessage(m.verdictTooClose);

  return { kind: 'confused', candidates, best, reason };
}

export interface AutoMatch {
  txnId: string;
  candidate: Candidate;
}

/**
 * Whether a line already has its evidence — the one place the two match
 * signals are reconciled (METH Stage 11).
 *
 * `matchedDocId` is the seeded shape and answers *which* document; `matchState`
 * is the server's and answers only *whether*. The contract's `BankTransaction`
 * carries the second and not the first, so an API-sourced row that has been
 * confirmed has no document id to offer — and inventing one would corrupt
 * `autoMatches`' `claimed` set, which uses those ids to stop one receipt
 * answering two lines.
 *
 * `SUGGESTED` is deliberately NOT matched. A suggestion is a question waiting
 * for a human; counting it as evidence would take the line out of the unmatched
 * total that the whole screen — and the chase list — is about.
 */
export function isMatched(txn: BankTransaction): boolean {
  return txn.matchedDocId !== undefined || txn.matchState === 'CONFIRMED';
}

/**
 * Whether a line is UNEXPLAINED — the one definition every count on this
 * screen, the Clients board and Analytics is allowed to use.
 *
 * ⚠ **This is not `isMatched` negated, and it must never be collapsed into
 * one function.** They answer two different questions:
 *
 * - `isMatched` asks *"does this line already have its evidence?"* — the
 *   matching engine's question. `SUGGESTED` is deliberately NOT matched there,
 *   because a suggestion is a question waiting for a human and the matcher
 *   still has work to offer on it.
 * - `isUnexplained` asks *"is this one of the lines the product is going to go
 *   and chase?"* — the counting question. A suggestion is already in front of
 *   a human, so it is not chased and must not be counted.
 *
 * It mirrors the SERVER's definition byte for byte, because the server's is the
 * one that governs: `businesses.service.ts` folds `BusinessSummary.counts`
 * from `bankTransaction.groupBy({ where: { matchState: 'UNMATCHED',
 * chaseSuppressed: false } })`, and the same predicate is what chase detection
 * selects on. Anything a screen counts by a different rule is a number no
 * amount of work by the accountant can ever bring down — a suppressed line
 * (bank interest, a card fee) has no paperwork in existence to find, and an
 * `EXCLUDED` line has had a human say so out loud.
 *
 * **It is truthful on both casts, which is why it is not simply
 * `matchState === 'UNMATCHED'`.** A seeded transaction (`lib/seed.ts`,
 * `lib/generate.ts`) carries `matchedDocId` and NO `matchState` at all, so the
 * strict server test would report every synthetic row as explained and empty
 * the demo (METH_MODE §1 — the app must walk end to end with no API). For that
 * cast the local id is the whole of the truth, and `SUGGESTED`/`EXCLUDED` do
 * not exist in it: the seed's suggestions are computed at render time by
 * `assessTransaction` and never stored.
 *
 * The `isMatched` guard is deliberate rather than duplicated logic: it makes
 * "unexplained is a strict subset of not-matched" true by construction, so a
 * count can never exceed the list the screen is showing.
 */
export function isUnexplained(txn: BankTransaction): boolean {
  // Nothing to chase and nothing to find: excluded from the server's count for
  // the same reason, and the flag is on the row so the screen can say why.
  if (txn.chaseSuppressed === true) return false;
  // Already has its evidence — by either cast's signal.
  if (isMatched(txn)) return false;
  // Server rows say which of the remaining states they are in; seeded rows say
  // nothing, and for them "not matched" is the whole answer.
  return txn.matchState === undefined || txn.matchState === 'UNMATCHED';
}

/**
 * Every transaction the matcher can settle on its own. Run once over the
 * starting data so the queue only ever contains genuine questions.
 */
export function autoMatches(
  intl: IntlShape,
  transactions: BankTransaction[],
  documents: Document[],
  settings: MatchSettings,
): AutoMatch[] {
  const claimed = new Set(transactions.filter((t) => t.matchedDocId).map((t) => t.matchedDocId as string));
  const result: AutoMatch[] = [];

  for (const txn of transactions) {
    // `isMatched`, not `matchedDocId`: a server-confirmed line has no document
    // id on the wire, and proposing a fresh auto-match for one would offer the
    // accountant a decision a human already took.
    if (isMatched(txn)) continue;
    // The evolving claimed set goes INTO the assessment (item 32): a claimed
    // document out of the pool lets the genuine runner-up win, where before it
    // merely blocked the link and the transaction got nothing.
    const verdict = assessTransaction(intl, txn, documents, settings, claimed);
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
