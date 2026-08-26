import { z } from 'zod';

import type { RuleCreatePayload } from '@neoting/contracts/model';

import type { SupplierCodingResult } from './supplier-coding.service.js';

/**
 * A learned coding → a **`rule.create` proposal**, so the second invoice from a
 * supplier codes itself.
 *
 * ## Why this produces a proposal and not a rule
 *
 * Governance §10: no state change outside the ActionProposal / Review → Approve
 * path. A standing rule that will code every future document from a supplier is
 * about as consequential as a coding decision gets, and the contract already
 * says so in its own words — *a rule never activates from an unapproved
 * utterance, however plain-English the request was.* The `rule.create` executor
 * stamps `actionProposalId` on the row precisely so that no rule can exist
 * without the approval that made it.
 *
 * So this file builds a **payload**. The caller sends it to
 * `POST /v1/action-proposals`, a human reads the review card (which
 * `render-summary.ts` already renders in full — tier, scope, and every field it
 * sets, *because a reviewer must see what will start coding their client's
 * documents*), and approval is what activates it.
 *
 * ## The one detail that silently breaks this if it is got wrong
 *
 * ⚠ **`scopeKey` is the supplier's exact spelling, taken from a document this
 * client actually received.** `extraction-pipeline.ts` matches by exact string
 * equality:
 *
 * ```ts
 * where: { businessId, isActive: true, tier: 'SUPPLIER_CUSTOMER', scopeKey: extracted.supplierName }
 * ```
 *
 * A normalised, title-cased or hand-typed key produces a rule that is written,
 * renders correctly on the review card, is approved by a human — and then never
 * fires. Nothing reports it. The document simply keeps arriving uncoded, and
 * the accountant concludes the feature does not work.
 */

/** What a caller posts to `POST /v1/action-proposals`. */
export interface SupplierRuleProposal {
  readonly ok: true;
  readonly kind: 'rule.create';
  readonly businessId: string;
  readonly payload: RuleCreatePayload;
  /** The ledger-prefixed account the rule codes to, or null when the code is off-chart. */
  readonly analysisAccount: string | null;
  /** One sentence for whoever is being asked to approve it. */
  readonly rationale: string;
  /**
   * Other spellings of this supplier in the client's history that this rule
   * will NOT match. Empty in the ordinary case. Non-empty means a second rule
   * is wanted, and saying so beats a rule that appears to work and half does.
   */
  readonly unmatchedSpellings: readonly string[];
}

export interface SupplierRuleRefusal {
  readonly ok: false;
  /** Why there is nothing to propose. Written to be shown, not logged. */
  readonly reason: string;
}

/**
 * The payload shape, parsed before it leaves.
 *
 * The return type of {@link buildSupplierRulePayload} is the **generated**
 * `RuleCreatePayload`, so a contract change to the shape is a compile error
 * here rather than a 400 at runtime. This schema is the runtime half of the
 * same guarantee — "Zod at every boundary" applies to the boundary we are
 * handing something to, not only to the ones we receive from.
 */
const SupplierRulePayloadSchema = z.object({
  tier: z.literal('SUPPLIER_CUSTOMER'),
  scopeKey: z.string().min(1),
  sets: z.object({ categoryCode: z.string().min(1) }).strict(),
});

/**
 * Build the proposal, or explain why there is none.
 *
 * Refuses in three cases, and each refusal is the right answer rather than a
 * limitation:
 *
 * 1. **A rule already codes this supplier.** Proposing a second one would
 *    create two rules at the same tier for the same scope, where the newest
 *    silently wins. If the existing rule is wrong, changing it is an edit, not
 *    a duplicate.
 * 2. **The decision is not the client's own prior treatment.** A rule is a
 *    standing instruction and the only thing this release will offer to make
 *    one from is a human's confirmed coding. Nothing is inferred.
 * 3. **The document is locked, the supplier is new, or the history disagrees
 *    with itself.** In all three the honest answer is To Review.
 */
export function buildSupplierRuleProposal(result: SupplierCodingResult): SupplierRuleProposal | SupplierRuleRefusal {
  const { decision, history, chart, businessId } = result;

  if (decision.outcome === 'LOCKED') {
    return {
      ok: false,
      reason:
        decision.lock === 'HUMAN_CORRECTION'
          ? 'This coding was set by a person. Turning their decision into a standing rule is a separate thing to ask them, not something to infer from the correction.'
          : 'This document is released or archived; its coding is fixed and there is no rule to learn from it here.',
    };
  }

  if (decision.outcome === 'REVIEW') {
    return { ok: false, reason: decision.reason };
  }

  if (decision.authority !== 'LEARNED_HISTORY') {
    return {
      ok: false,
      reason: `A rule already codes this supplier to ${decision.categoryCode}. Changing it is an edit to that rule, not a second rule at the same tier — two would leave the newest quietly winning.`,
    };
  }

  // The exact spelling, from the most recent document this client received.
  // `history.spellings` is ordered most-recent-first by `loadHistory`.
  const scopeKey = history.spellings[0];
  if (scopeKey === undefined || scopeKey.trim() === '') {
    return {
      ok: false,
      reason: 'There is no document naming this supplier to take an exact scope key from, and a rule keyed on anything else would never fire.',
    };
  }

  const payload = buildSupplierRulePayload(scopeKey, decision.categoryCode);
  SupplierRulePayloadSchema.parse(payload);

  const account = chart.categories.find((category) => category.code === decision.categoryCode);
  const times = history.entries.length;

  return {
    ok: true,
    kind: 'rule.create',
    businessId,
    payload,
    analysisAccount: decision.analysisAccount,
    rationale: `Code ${scopeKey} to ${account?.name ?? decision.categoryCode} from now on. This client has coded them that way ${times === 1 ? 'once' : `${times} times`}, by hand, and never differently.${account === undefined ? ' ⚠ That code is not on this client’s chart of accounts, so the export cannot give it a ledger prefix.' : ''}`,
    unmatchedSpellings: history.spellings.slice(1),
  };
}

/**
 * The payload itself.
 *
 * Annotated with the **generated** `RuleCreatePayload` so drift in
 * `openapi.yaml` fails the build here rather than at a runtime 400. `conditions`
 * is deliberately omitted, not nulled: the contract makes it optional, ID
 * evaluates none of them, and a null would look like an intention that had been
 * cleared.
 */
export function buildSupplierRulePayload(scopeKey: string, categoryCode: string): RuleCreatePayload {
  return { tier: 'SUPPLIER_CUSTOMER', scopeKey, sets: { categoryCode } };
}
