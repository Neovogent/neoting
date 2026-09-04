/**
 * **The closed set of reasons this module may decline to code a document, and
 * the closed set of things it may say about a coding it does offer.**
 *
 * ## Why a named reason and not a null
 *
 * A first-time supplier used to produce nothing at all: the extractor is not
 * asked to code (`bedrock-extraction-schema.ts` — *coding is the rules
 * engine's job*), the `AI_INFERENCE` rung was switched off, and a supplier with
 * no rule and no history therefore fell out of the ladder with an empty
 * category and no explanation. On screen that is an empty field, which tells an
 * accountant nothing about what is missing or what would fix it.
 *
 * A model that answers *"no category"* is less useful than one that answers a
 * best guess with a confidence and a named reason, or an explicit escalation
 * naming what it needs. **So there is no bare-null path out of this module's
 * suggestion rung** — every answer is either a `SUGGEST` carrying a code and a
 * confidence, or an `ESCALATE` carrying one of the reasons below.
 *
 * ## Why the sets are CLOSED
 *
 * A free-text reason cannot be rendered as a specific affordance, cannot be
 * counted, and cannot be tested. A closed set can: the UI can turn
 * `SOFTWARE_TERM_UNKNOWN` into *"is this a subscription or a perpetual
 * licence?"* with two buttons, and a regression that starts escalating every
 * document is visible as a shift in one histogram. Adding a value here is a
 * deliberate act with a test behind it.
 */

/**
 * Why a document could not be coded, in **severity order** — the first reason
 * present on any line is the one the document reports.
 *
 * The order is load-bearing and is not alphabetical: a document whose
 * arithmetic does not reconcile must not be categorised at all, so that reason
 * outranks every question about which account a line belongs to.
 */
export const CODING_ESCALATION_REASONS = [
  /**
   * **The document does not add up, so nothing about it may be coded yet.**
   *
   * The invoice that prompted this work states a subtotal of $52,550.00, a tax
   * rate of 8.875% and a total of $54,352.51 — an implied 3.43%. Whatever is
   * wrong (a misread figure, a credit nobody typed, a genuinely wrong invoice),
   * a category assigned on top of it is a category assigned to a number that is
   * not the number. This is a hard stop, checked before any classification runs.
   */
  'ARITHMETIC_MISMATCH',
  /**
   * This client has no chart of accounts to code against, so every code would
   * be off-chart by construction. `chart-of-accounts.service.ts` normally
   * guarantees one; this is the honest answer when it could not.
   */
  'NO_CHART_OF_ACCOUNTS',
  /**
   * A code was named that this client's chart does not carry, and it is
   * **refused rather than fuzzy-matched**.
   *
   * The same stance `drafts.ts` takes for a chat-drafted rule, and for the same
   * reason it gives: *fuzzy-matching a chart of accounts is how a client's food
   * costs quietly become drink costs, and the accountant approving it has no
   * way to see that happened.* A near miss is not a small error — it is an
   * invisible one.
   */
  'CODE_NOT_ON_CHART',
  /**
   * The document carries no line detail and its supplier name matches nothing,
   * so there is no description to code from. Line-item description beats
   * supplier identity; with neither there is nothing to beat anything with.
   */
  'NO_LINE_DETAIL',
  /**
   * **A software line whose term the document does not state.**
   *
   * The single most consequential unknown on an IT invoice. The same product
   * name is capital when the licence is perpetual (an intangible; plant for UK
   * tax under CAA 2001 s.71) and revenue when it is an annual subscription
   * (HMRC BIM35805's under-two-years test; a right of access is a service
   * contract per the IFRIC agenda decision of March 2019). The two invoices can
   * be identical apart from one word.
   *
   * ⚠ **Refuse and ask. Never infer the term from the vendor** — the same
   * vendor sells both, often on the same document.
   */
  'SOFTWARE_TERM_UNKNOWN',
  /**
   * One line contains both capital and revenue work and has to be **split**.
   *
   * "Professional services — setup and configuration" is the canonical case:
   * installing and testing hardware capitalises into the asset (IAS 16.17(d)–
   * (e)), configuring the supplier's hosted software is expensed, and training
   * is never capitalisable at all (IAS 16.19(c), IAS 38.69(b)). No single
   * category is right, and picking the larger half would be picking by
   * magnitude.
   */
  'MIXED_CAPITAL_AND_REVENUE',
  /**
   * The lines are individually codeable and land on **more than one account of
   * the same kind**, which `documents.category_code` — one nullable string —
   * cannot represent.
   *
   * This is not a limitation of the rules; it is the schema's. The candidate
   * codes travel with the escalation so the accountant sees the split that was
   * found rather than an empty field. See this module's `CLAUDE.md` for the
   * `DocumentLine` proposal that would let it be answered instead of reported.
   */
  'MULTIPLE_CATEGORIES_ON_ONE_DOCUMENT',
  /**
   * A per-unit amount sitting on the practice's capitalisation threshold.
   *
   * There is no statutory de minimis in UK GAAP or IFRS — the threshold is the
   * practice's own accounting policy — so an item within a few percent of it is
   * a judgement, not a calculation, and a rule that resolved it by rounding
   * would be inventing the policy it is supposed to apply.
   */
  'THRESHOLD_BOUNDARY',
  /**
   * Nothing on this client's chart matched the line descriptions, and no rule
   * or prior coding names the supplier.
   *
   * Reported rather than approximated: a code chosen because it was the closest
   * of a bad set is the failure mode `CODE_NOT_ON_CHART` exists to prevent,
   * arrived at from the other direction.
   */
  'NO_MATCH_ON_CHART',
  /**
   * A first-time supplier with no rule, no history, and nothing on the document
   * specific enough to decide.
   *
   * §24.4.1 makes a new supplier always-review, and the published numbers
   * support it: category accuracy on an unseen category runs at roughly a fifth
   * of its seen-category level, and around a third zero-shot for a brand-new
   * company. This is the terminal reason — the one that guarantees the rung has
   * an answer even when nothing else applied.
   */
  'NEW_SUPPLIER_NO_HISTORY',
] as const;

export type CodingEscalationReason = (typeof CODING_ESCALATION_REASONS)[number];

/** Lower is more severe. Index into the declared order — there is no second table. */
export function escalationSeverity(reason: CodingEscalationReason): number {
  return CODING_ESCALATION_REASONS.indexOf(reason);
}

/** The more severe of two reasons. A document reports the worst thing found on it. */
export function moreSevere(a: CodingEscalationReason, b: CodingEscalationReason): CodingEscalationReason {
  return escalationSeverity(a) <= escalationSeverity(b) ? a : b;
}

/**
 * What the accountant is being asked for — one sentence per reason, written to
 * be rendered next to the empty field rather than logged.
 *
 * Deliberately says what would RESOLVE it, not what went wrong. "This line does
 * not say whether the licence is perpetual or annual" is a question someone can
 * answer in five seconds; "could not determine category" is not.
 */
export const ESCALATION_PROMPTS: Readonly<Record<CodingEscalationReason, string>> = {
  ARITHMETIC_MISMATCH:
    'The figures on this document do not reconcile, so nothing here is coded yet. Check the subtotal, the tax and the total against the paper before anything is posted.',
  NO_CHART_OF_ACCOUNTS: 'This client has no chart of accounts yet, so there is nothing to code against.',
  CODE_NOT_ON_CHART:
    'The account suggested is not on this client’s chart, so it was refused rather than matched to the nearest one. Pick from the chart, or add the account first.',
  NO_LINE_DETAIL: 'This document has no line detail to code from, and its supplier is not one anything here recognises.',
  SOFTWARE_TERM_UNKNOWN:
    'This is software, and the document does not say whether the licence is perpetual or a subscription — which is the whole capital-versus-revenue question. The vendor cannot answer it: the same product is sold both ways.',
  MIXED_CAPITAL_AND_REVENUE:
    'One line covers both capital and revenue work — installing hardware capitalises, configuring hosted software does not, and training never does. It needs splitting before it can be coded.',
  MULTIPLE_CATEGORIES_ON_ONE_DOCUMENT:
    'The lines belong to more than one account, and a document carries a single category. The candidates found are listed; coding it needs the lines split.',
  THRESHOLD_BOUNDARY:
    'The per-unit amount could not be settled against this practice’s capitalisation threshold — it sits on the line, or the document does not give an amount to test. That threshold is an accounting policy rather than a rule of law, so the call is the accountant’s.',
  NO_MATCH_ON_CHART: 'Nothing on this client’s chart matches what this document describes, and nothing was guessed at.',
  NEW_SUPPLIER_NO_HISTORY:
    'This is a first document from this supplier, and nothing on it is specific enough to code on its own. Coding it once is what teaches the next one.',
};

/**
 * Things worth saying about a coding that WAS offered.
 *
 * An advisory never blocks and never changes the code — it is the *"and note
 * that…"* half of a suggestion, and it exists because several of the rules
 * below have a consequence somewhere other than the category column.
 */
export const CODING_ADVISORIES = [
  /**
   * **Foreign consumption tax is part of the cost, never a tax control
   * account.** US sales tax, EU VAT charged by an EU supplier, Australian GST:
   * none of it is reclaimable input VAT on a UK return, so posting it to the
   * VAT account is a direct overstatement of a reclaim.
   */
  'FOREIGN_TAX_IN_COST',
  /**
   * ⚠ And the counter-intuitive half: where the UK **reverse charge** applies to
   * a service bought from overseas, the foreign tax that formed part of the cost
   * *increases* the value the reverse charge is calculated on (HMRC VATPOSS14600).
   * It is not reclaimable and it is not ignorable.
   */
  'REVERSE_CHARGE_INCREASES_BASE',
  /**
   * A fee paid up front for a period that will straddle the year end. The whole
   * invoice codes to the expense account; the accountant journals the unexpired
   * portion to `PREPAYMENTS` at the year end. Stated, never done automatically.
   */
  'ANNUAL_FEE_MAY_BE_PART_PREPAID',
  /**
   * The capitalisation threshold was applied **per unit, not per line**. Two
   * servers at $6,150 are two assets of $6,150 — the line total of $12,300 is
   * not the thing being tested against the policy.
   */
  'PER_UNIT_THRESHOLD_APPLIED',
  /**
   * The document is in a currency other than the one the threshold is expressed
   * in, and **no conversion was applied**. Comparing 6,150 USD against a
   * threshold written in GBP is comparing two different numbers; saying so beats
   * silently applying an FX rate nobody chose on a date nobody recorded.
   */
  'THRESHOLD_COMPARED_WITHOUT_FX',
  /**
   * §24.4.1: a new supplier is stated as such and is always-review. Here it is
   * also the reason the confidence is lower than the same rule would carry for a
   * supplier this client has bought from before.
   */
  'NEW_SUPPLIER',
] as const;

export type CodingAdvisory = (typeof CODING_ADVISORIES)[number];

/** One sentence per advisory, written to be rendered under the suggested code. */
export const ADVISORY_NOTES: Readonly<Record<CodingAdvisory, string>> = {
  FOREIGN_TAX_IN_COST:
    'The tax on this document is a foreign consumption tax. It is part of the cost of what was bought and is never reclaimable input VAT — it must not reach a tax control account.',
  REVERSE_CHARGE_INCREASES_BASE:
    'If the UK reverse charge applies to this supply, that foreign tax still increases the value the reverse charge is calculated on (HMRC VATPOSS14600) even though none of it is reclaimable.',
  ANNUAL_FEE_MAY_BE_PART_PREPAID:
    'This is an annual fee paid up front. If the period straddles the year end, the unexpired part is a prepayment — a year-end journal, not a different category for the invoice.',
  PER_UNIT_THRESHOLD_APPLIED:
    'The capitalisation threshold was tested per unit, not against the line total: several identical items are several assets, not one.',
  THRESHOLD_COMPARED_WITHOUT_FX:
    'This document is not in the currency the capitalisation threshold is written in, and no exchange rate was applied. Check the threshold call in the document’s own currency.',
  NEW_SUPPLIER: 'This client has not bought from this supplier before, so there is no prior treatment to be consistent with.',
};
