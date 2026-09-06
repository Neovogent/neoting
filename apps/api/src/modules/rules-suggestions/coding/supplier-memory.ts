import { analysisAccount, resolveAccount } from '../chart-of-accounts/account.js';
import { type AiCodingSuggestion, type SuggestionChart } from './ai-suggestion.js';

/**
 * **Supplier memory** — review item 48, the Dext parity beat:
 *
 * > *"Ai must remember the supplier and set a category for it, if the supplier
 * > is regular then it will suggest the same category."*
 *
 * ## What was actually missing, because most of it was already here
 *
 * The ladder has read this client's own prior codings since A6:
 * `loadHistory` walks the last `HISTORY_WINDOW` documents, keeps only the
 * ones a HUMAN confirmed (`extractor_kind: 'human'` +
 * `provenance: 'HUMAN_CONFIRMED'` — a category a rule applied is not evidence,
 * or one approved decision would look like a growing consensus), and matches
 * them on the NORMALISED supplier key, so `NISBETS LTD` and `Nisbets Ltd` are
 * one supplier. `decide()` then answers `CODE` on the `LEARNED_HISTORY` rung.
 *
 * **And nothing ever showed it to anybody.** The pipeline's only consumer,
 * `extraction/coding-advice.ts`, returned `null` for every outcome that was not
 * `REVIEW` — so a repeat supplier a person had coded by hand arrived with an
 * empty Category, no suggestion panel, and no sentence: exactly the screen a
 * first-time supplier got, which is the complaint. The memory existed, the
 * ladder used it, and the product never said so.
 *
 * ## Why this is a SUGGESTION and not the coding it is entitled to be
 *
 * `LEARNED_HISTORY` outranks nothing but the model, and the pipeline's header
 * projection deliberately has ONE writer carrying "the extractor's value or an
 * accountant's rule". A6's brief is blunt about the alternative — *a rule that
 * silently recodes a document is exactly the thing §10 forbids* — and §24.4.5
 * says a learned treatment should BECOME a deterministic rule, through
 * `rule-proposal.ts`, with a human approving it. So the answer is offered, and
 * accepting it is the ordinary `document.update-coding` proposal every other
 * correction goes through.
 *
 * ## The confidence is CONSISTENCY, which is why it is not a table lookup
 *
 * Five identical human codings and one are not the same claim, and
 * `CONFIDENCE_BY_BASIS` cannot say so with a single number. This is the one
 * basis whose confidence is computed. It is anchored, not invented: the
 * published production figure for a categoriser on a category it HAS seen for a
 * company is ~62.5% top-1, so a single prior human coding starts a shade below
 * that ({@link MEMORY_BASE_CONFIDENCE}) and repetition earns it up to
 * {@link MEMORY_MAX_CONFIDENCE} — the same ceiling `TRAINING_NEVER_CAPITAL`
 * carries, because nothing here may read as more certain than a bright line in
 * a standard.
 *
 * ⚠ It still gates nothing. `modules/extraction`'s invariant holds on this
 * file as on every other: *thresholds come from eval measurements, never from
 * self-reported confidence.* It exists to be displayed.
 */

/** What a single prior human coding is worth, on its own. */
export const MEMORY_BASE_CONFIDENCE = 0.6;
/** What each repetition after the first adds. */
export const MEMORY_CONFIDENCE_PER_REPEAT = 0.08;
/** The ceiling. Five-for-five reaches it; nothing exceeds it. */
export const MEMORY_MAX_CONFIDENCE = 0.9;

/** The history this reads, structurally — `SupplierHistory` satisfies it. */
export interface SupplierMemoryHistory {
  readonly entries: readonly { readonly categoryCode: string; readonly receivedAt: Date }[];
  /** Distinct codes across those entries. More than one is not a memory. */
  readonly categoryCodes: readonly string[];
}

/** 0..1, for DISPLAY. See the header — no branch may compare it to a number. */
export function memoryConfidence(times: number): number {
  const raw = MEMORY_BASE_CONFIDENCE + MEMORY_CONFIDENCE_PER_REPEAT * Math.max(0, times - 1);
  return Math.min(MEMORY_MAX_CONFIDENCE, Math.round(raw * 100) / 100);
}

/**
 * This client's remembered treatment of this supplier, as a suggestion — or
 * `null` when there is no single one to offer.
 *
 * Three `null`s, and each is the right answer rather than a gap:
 *
 * 1. **No prior human coding.** Nothing to remember. The ladder falls to the
 *    deterministic rung and then to the model, which is where a first document
 *    from a new supplier belongs.
 * 2. **More than one code in the history.** §24.4.6: *a change of treatment is
 *    itself worth surfacing.* Two codes is not a tie to break — offering the
 *    more frequent one would present a disagreement as a consensus. It falls
 *    through, and the tiers below answer from the document itself.
 * 3. ⚠ **The remembered code is no longer on this client's chart.** Item 48
 *    names this: *a remembered code that has since left the chart is not
 *    offered.* Offering it would put a nominal into a suggestion that the export
 *    cannot prefix and the correction boundary (`assertUpdateCodingAllowed`)
 *    would refuse on the way back in — an affordance whose only outcome is a
 *    422. Falling through means the document still gets an answer, from a code
 *    that exists.
 */
export function supplierMemorySuggestion(history: SupplierMemoryHistory, chart: SuggestionChart): AiCodingSuggestion | null {
  if (history.categoryCodes.length !== 1) return null;
  const categoryCode = history.categoryCodes[0] as string;
  if (!onChart(chart, categoryCode)) return null;

  const times = history.entries.length;
  if (times === 0) return null;

  // `loadHistory` orders most-recent-first, but this function is on the public
  // seam and must not depend on a caller's ordering for a date it prints.
  const mostRecent = history.entries.reduce<Date | null>(
    (latest, entry) => (latest === null || entry.receivedAt > latest ? entry.receivedAt : latest),
    null,
  );
  if (mostRecent === null) return null;
  const label = labelFor(chart, categoryCode);

  return {
    outcome: 'SUGGEST',
    authority: 'AI_INFERENCE',
    // ⚠ `AI_SUGGESTED` even though nothing about this is a model, and the
    // contract is why: `ProvenanceClass` has three members, `DETERMINISTIC` is
    // what a RULE applied, and `HUMAN_CONFIRMED` is what a person set on THIS
    // document. A remembered treatment is neither — it is an opinion about a
    // document nobody has looked at yet, and the surface must render it as one.
    provenance: 'AI_SUGGESTED',
    basis: 'SUPPLIER_MEMORY',
    categoryCode,
    analysisAccount: analysisAccountFor(chart, categoryCode),
    confidence: memoryConfidence(times),
    // The treatment a memory implies is the one the chart's own account
    // carries; a remembered code cannot make an expense capital.
    treatment: 'REVENUE',
    // Deliberately none. A second choice is what you offer when the rules had a
    // runner-up; a history that answered one way every time had none, and
    // manufacturing one from the chart would invent a disagreement.
    secondChoice: null,
    advisories: [],
    note:
      `Suggested — not applied — as ${label}. This client has coded this supplier that way ` +
      `${times === 1 ? 'once' : `${times} times`}, by hand, most recently ${ukDate(mostRecent)}, and never differently.`,
  };
}

function onChart(chart: SuggestionChart, categoryCode: string): boolean {
  return chart.accounts.some((account) => account.code === categoryCode) || chart.categories.some((category) => category.code === categoryCode);
}

/** `documents.category_code` → the emittable `Ledger: Account`, or null when off-chart. */
function analysisAccountFor(chart: SuggestionChart, categoryCode: string): string | null {
  const account = resolveAccount(chart.accounts, categoryCode);
  if (account !== null) return analysisAccount(account);
  return chart.categories.find((category) => category.code === categoryCode)?.name ?? null;
}

function labelFor(chart: SuggestionChart, categoryCode: string): string {
  return chart.categories.find((category) => category.code === categoryCode)?.name ?? analysisAccountFor(chart, categoryCode) ?? categoryCode;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `9 Aug 2026` — UK rendering of a stored UTC instant (Governance §12).
 *
 * Written here rather than imported: the only other one in the repo is private
 * to `validation-dedupe/correction-checks.ts`, and reaching across a module
 * boundary for five lines of string arithmetic would cost a public seam.
 */
function ukDate(at: Date): string {
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()] ?? '???'} ${at.getUTCFullYear()}`;
}
