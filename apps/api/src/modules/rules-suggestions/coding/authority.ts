import type { RuleTier } from '@neoting/contracts/model';

/**
 * **The authority order, and it is absolute** (SoT §4 Stage 4, §24.4.2, this
 * module's own CLAUDE.md invariant):
 *
 * > accountant rules → practice defaults → client context → learned history →
 * > AI inference
 *
 * Two properties are load-bearing and both are enforced here rather than
 * described:
 *
 * 1. **An explicit accountant rule beats everything below it.** Not "usually",
 *    not "unless confidence is high" — {@link authorityRank} is the only
 *    comparison, a lower rank always wins, and there is no branch anywhere in
 *    this module that lets a later rung overtake an earlier one.
 * 2. **Nothing overrides a human's correction.** That is NOT a rung on this
 *    ladder, and modelling it as one would have been the bug: a rung is
 *    something a better rung can beat. A human-confirmed coding is a **lock**
 *    on the document, checked before the ladder is consulted at all
 *    (`supplier-coding.service.ts`, `LOCKED_BY_HUMAN`).
 *
 * ## Which rungs ID actually fills, stated rather than implied
 *
 * | Rung | ID | How |
 * |---|---|---|
 * | `ACCOUNTANT_RULE` | **yes** | an active `rules` row at tier `USER`, `PAYMENT_METHOD` or `SUPPLIER_CUSTOMER`. Every one of those was written by the `rule.create` executor from a proposal a human approved — there is no other writer |
 * | `PRACTICE_DEFAULT` | **yes** | an active `rules` row at tier `ACCOUNT_DEFAULT` |
 * | `CLIENT_CONTEXT` | **no, deliberately** | the seeded chart is a *picklist*, not supplier knowledge. It can say which accounts exist and whether a supplier is new; it cannot say what a document is. A rung that guessed from the business type is a wrong code applied silently, which A6's brief names as the thing worse than a human coding it by hand |
 * | `LEARNED_HISTORY` | **yes** | this client's own prior human-confirmed coding of this supplier (§24.4.5: *every accountant correction becomes a labelled example and, where it recurs for a supplier, a deterministic rule*) |
 * | `AI_INFERENCE` | **yes, as a SUGGESTION only** | `coding/ai-suggestion.ts`. It attaches to a `REVIEW` outcome carrying `provenance: 'AI_SUGGESTED'` and a confidence — it never produces a `CODE`, so it cannot become an applied coding by accident |
 *
 * `CLIENT_CONTEXT` stays in the enum without being filled, because the order is
 * the SoT's and not this release's. Deleting a rung would make the next stage
 * renumber a thing that must not be renumbered.
 *
 * ## Why the bottom rung was switched on
 *
 * A6 left it off by name — *DO NOT build the four-tier rule engine,
 * natural-language rule parsing, or AI coding suggestions* — and the
 * consequence, once real documents arrived, was that **a first-time supplier
 * could not be coded by anything at all**: the extractor is deliberately not
 * asked to code, `CLIENT_CONTEXT` never wins, and a new supplier has neither a
 * rule nor a history. The document reached To Review with an empty category and
 * no explanation, which is worse than a suggestion an accountant can reject in
 * one click.
 *
 * ⚠ Switching it on changed **nothing above it**. Every rung ahead of it
 * returns before it is consulted, `outranks()` is unchanged, and a human's
 * correction still locks the document before the ladder is entered at all.
 */
export const CODING_AUTHORITIES = [
  'ACCOUNTANT_RULE',
  'PRACTICE_DEFAULT',
  'CLIENT_CONTEXT',
  'LEARNED_HISTORY',
  'AI_INFERENCE',
] as const;

export type CodingAuthority = (typeof CODING_AUTHORITIES)[number];

/** Lower is stronger. Index into the SoT's own ordering — there is no second table. */
export function authorityRank(authority: CodingAuthority): number {
  return CODING_AUTHORITIES.indexOf(authority);
}

/** Does `candidate` outrank `incumbent`? Strictly — an equal rung never displaces a decision already made. */
export function outranks(candidate: CodingAuthority, incumbent: CodingAuthority): boolean {
  return authorityRank(candidate) < authorityRank(incumbent);
}

/**
 * Prisma's four-tier `RuleTier` → the authority rung it occupies.
 *
 * The two ladders are not the same thing and conflating them is easy: `RuleTier`
 * orders rules **against each other** when several match one field, while
 * `CodingAuthority` orders *sources of a coding opinion* against each other.
 * Every `rules` row exists because a human approved a `rule.create` proposal —
 * the executor stamps `actionProposalId` and *no rule exists without one* — so
 * all four tiers are accountant intent. `ACCOUNT_DEFAULT` maps to
 * `PRACTICE_DEFAULT` because that is what an account-level default is.
 */
export function authorityForTier(tier: RuleTier): CodingAuthority {
  return tier === 'ACCOUNT_DEFAULT' ? 'PRACTICE_DEFAULT' : 'ACCOUNTANT_RULE';
}

/**
 * Rule precedence, most specific first — the SoT's four tiers in their stated
 * order: *user rules beat payment-method rules beat supplier/customer defaults
 * beat account defaults.*
 */
export const RULE_TIER_PRECEDENCE: readonly RuleTier[] = ['USER', 'PAYMENT_METHOD', 'SUPPLIER_CUSTOMER', 'ACCOUNT_DEFAULT'];

/** Index of a tier in {@link RULE_TIER_PRECEDENCE}; unknown tiers sort last rather than throwing. */
export function tierRank(tier: RuleTier): number {
  const at = RULE_TIER_PRECEDENCE.indexOf(tier);
  return at === -1 ? RULE_TIER_PRECEDENCE.length : at;
}
