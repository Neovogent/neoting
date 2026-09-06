import { buildSupplierRuleProposal } from './rule-proposal.js';
import type { SupplierCodingResult } from './supplier-coding.service.js';

/**
 * **"You've coded Aldgate Meats to Food 5 times — make it a rule?"** — review
 * item 48's follow-on, and §24.4.5's own instruction: a treatment a client
 * repeats should BECOME a deterministic rule.
 *
 * ## Why this exists when supplier memory already suggests the code
 *
 * Memory answers one document at a time and asks a human every time. A rule
 * codes the NEXT document before anybody looks at it — `extraction-pipeline.ts`
 * matches an active `SUPPLIER_CUSTOMER` rule on the way in — so it is the
 * difference between a suggestion an accountant approves forty times and a
 * decision they take once. Item 48 asks for both, *"so the two mechanisms
 * converge instead of competing"*: memory covers the tail and the first few, a
 * rule retires the repetition.
 *
 * ## ⚠ IT DECIDES NOTHING ITSELF — `buildSupplierRuleProposal` DOES
 *
 * That function has existed and been tested since A6 with no caller in the
 * product, and it already owns every refusal that matters: a rule already codes
 * this supplier (two rules at one tier would leave the newest quietly winning),
 * the decision is not the client's own prior treatment, the document is locked,
 * the supplier is new, the history disagrees with itself, or there is no exact
 * spelling to key a rule on. Re-deriving any of that here would be a second
 * opinion about the same rows, free to disagree with the card a reviewer
 * eventually sees.
 *
 * So this file adds exactly one thing on top of it: **a threshold**, and the
 * projection into the shape a surface renders.
 */

/**
 * How many hand-codings before the offer appears.
 *
 * ⚠ **A value, not a law**, and deliberately conservative. One coding is a
 * decision; two is a habit; three is a pattern worth making standing. A rule
 * OUTLIVES the document that argued for it and codes documents nobody has seen
 * yet, so the cost of offering too early — an accountant clicking through and
 * creating a standing rule off a single invoice — is much higher than the cost
 * of offering one document later. Mubashir's own example says five; three is
 * the point at which the sentence stops being about a coincidence, and the
 * count is always shown so the accountant judges the evidence rather than the
 * threshold.
 *
 * It is not a confidence gate and nothing compares a confidence to it — the
 * §13.3 invariant is untouched. It counts human decisions.
 */
export const RULE_OFFER_THRESHOLD = 3;

/** The offer, in the shape the contract's `CodingSuggestion.ruleOffer` carries. */
export interface SupplierRuleOffer {
  /** ⚠ The supplier's EXACT spelling from a document this client received. Sent verbatim or the rule never fires. */
  readonly scopeKey: string;
  readonly categoryCode: string;
  readonly analysisAccount: string | null;
  readonly times: number;
  /** One sentence, composed here. Rendered verbatim — a client that reworded it would be a second description. */
  readonly rationale: string;
  /** Other spellings in this client's history that this rule will NOT match. */
  readonly unmatchedSpellings: readonly string[];
}

/**
 * The offer for this document, or `null` — which is the usual answer.
 *
 * `null` covers every refusal `buildSupplierRuleProposal` makes plus the one
 * this file adds (too few codings to be a pattern). Nothing about a `null` is a
 * failure: most documents should not be offering to write a standing rule.
 */
export function supplierRuleOffer(result: SupplierCodingResult): SupplierRuleOffer | null {
  if (result.history.entries.length < RULE_OFFER_THRESHOLD) return null;

  const proposal = buildSupplierRuleProposal(result);
  if (!proposal.ok) return null;

  return {
    // The pair `buildSupplierRuleProposal` already validated — see its own note
    // on why they are handed over rather than read back off the payload.
    scopeKey: proposal.scopeKey,
    categoryCode: proposal.categoryCode,
    analysisAccount: proposal.analysisAccount,
    times: result.history.entries.length,
    // The proposal's own sentence, which already names the scope key, the
    // account (ledger-prefixed where the chart can) and the count, and already
    // warns when the code is off-chart. One composition, two surfaces.
    rationale: proposal.rationale,
    unmatchedSpellings: proposal.unmatchedSpellings,
  };
}
