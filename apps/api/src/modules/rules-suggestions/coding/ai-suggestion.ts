import { analysisAccount, type ChartAccount, resolveAccount } from '../chart-of-accounts/account.js';
import {
  type CapitalisationPolicy,
  capitalisesAsHardware,
  classifyLine,
  type CodingBasis,
  type CodingLine,
  keywordMatchesOnChart,
  type LineTreatment,
  PLATFORM_DEFAULT_CAPITALISATION_POLICY,
  treatmentOf,
} from './capital-revenue.js';
import type { SupplierContext } from './coding-decision.js';
import {
  ADVISORY_NOTES,
  type CodingAdvisory,
  type CodingEscalationReason,
  ESCALATION_PROMPTS,
  moreSevere,
} from './escalation.js';

/**
 * **The `AI_INFERENCE` rung** — the bottom of the authority ladder, and the
 * answer to a first-time supplier that used to be nothing at all.
 *
 * ## What was actually broken
 *
 * Three facts composed into a document that could not be coded by anything:
 *
 * 1. the extractor is deliberately not asked to code
 *    (`bedrock-extraction-schema.ts`: *coding is the rules engine's job*);
 * 2. `AI_INFERENCE` was switched off by name, and `CLIENT_CONTEXT` with it;
 * 3. so only a deterministic supplier rule could code a document — and a
 *    **first-time supplier has no rule.**
 *
 * The result was an empty category, an empty reason, and a document that could
 * not reach Ready with nothing on screen saying why. This rung closes it.
 *
 * ## What it is NOT
 *
 * It is not a coding. `outcome: 'SUGGEST'` carries `provenance: 'AI_SUGGESTED'`
 * and a confidence precisely so a surface renders it as an opinion (§13.3:
 * *every value displays its provenance class — human-confirmed, deterministic,
 * AI-suggested with confidence*). Accepting it is still a
 * `document.update-coding` proposal a human approves; nothing on this path
 * writes `documents.category_code`, and the ladder above it is untouched — an
 * accountant's rule, a practice default and this client's own learned history
 * all return before it is ever consulted, and a human's correction locks the
 * document before the ladder runs at all.
 *
 * ## The accuracy ceiling this is designed around
 *
 * Intuit's published research puts QuickBooks' production categorisation model
 * at **62.5% top-1**, **20.8%** where the category is unseen for that company,
 * and **36%** zero-shot for a brand-new company. Every vendor "99%" in this
 * market traces to OCR *extraction*, not categorisation. So: rules first, a
 * model only for the tail, human review the default, and a **second choice**
 * offered wherever the rules had a runner-up — published top-2 accuracy runs
 * about ten points above top-1, which is the single cheapest accuracy the
 * interface can buy.
 *
 * ⚠ **The confidence gates nothing.** `modules/extraction`'s invariant holds
 * here too — *thresholds come from eval measurements, never from model
 * self-reported confidence* — so no branch in this repository may compare it to
 * a number. It exists to be displayed.
 */

/** A chart, structurally — `ClientChartOfAccounts` satisfies it without this file importing the service. */
export interface SuggestionChart {
  readonly accounts: readonly ChartAccount[];
  /** `{ code, name }` with `name` already ledger-prefixed. */
  readonly categories: readonly { readonly code: string; readonly name: string }[];
}

/** What the rung is given about the document. Every string on it is untrusted content. */
export interface CodingEvidence {
  readonly supplier: SupplierContext;
  /** ISO 4217 as read off the document, or null. */
  readonly currency: string | null;
  /** Gross total in integer minor units. */
  readonly totalPence: number | null;
  /** Tax in integer minor units. */
  readonly taxPence: number | null;
  readonly lines: readonly CodingLine[];
}

/** An empty evidence set — the honest input for a document nothing has been read off yet. */
export const NO_CODING_EVIDENCE: CodingEvidence = {
  supplier: { name: null, key: '', isNew: false },
  currency: null,
  totalPence: null,
  taxPence: null,
  lines: [],
};

interface SuggestionBase {
  /** Always this rung. Stated on the value so a caller cannot mistake it for a stronger one. */
  readonly authority: 'AI_INFERENCE';
  /** SoT §13.3 / the contract's `ProvenanceClass`. Never `DETERMINISTIC`, whatever decided it. */
  readonly provenance: 'AI_SUGGESTED';
  /** The named rule that decided it — §13.3's "show the working". */
  readonly basis: CodingBasis;
  readonly advisories: readonly CodingAdvisory[];
  /** One sentence for the card. Never contains a line description or a JSON blob. */
  readonly note: string;
}

export type AiCodingSuggestion =
  | (SuggestionBase & {
      readonly outcome: 'SUGGEST';
      readonly categoryCode: string;
      /** The ledger-prefixed form, or null when the chart cannot prefix it. */
      readonly analysisAccount: string | null;
      /** 0..1, for DISPLAY. Nothing branches on it. */
      readonly confidence: number;
      readonly treatment: LineTreatment;
      readonly secondChoice: {
        readonly categoryCode: string;
        readonly analysisAccount: string | null;
        readonly confidence: number;
      } | null;
    })
  | (SuggestionBase & {
      readonly outcome: 'ESCALATE';
      /** From the closed set. **This is what replaces the null.** */
      readonly reason: CodingEscalationReason;
      /**
       * Codes the lines pointed at, when they pointed at several. Present so the
       * accountant sees the split that was found rather than an empty field;
       * empty when nothing matched at all.
       */
      readonly candidateCategoryCodes: readonly string[];
      /** Null, and honestly so: there is no coding to be confident about. */
      readonly confidence: null;
    });

/**
 * Confidence per named rule, for display.
 *
 * The numbers are anchored to the published ceiling rather than invented: 62.5%
 * top-1 is the population figure for a production categoriser, so a rule that
 * *names an accounting authority* sits above it, a keyword match sits at it,
 * and a supplier-name guess sits well below. Bases that only ever appear on an
 * escalation carry 0 because no coding is offered with them.
 */
const CONFIDENCE_BY_BASIS: Readonly<Record<CodingBasis, number>> = {
  // Bright lines. IAS 16.19(c) / IAS 38.69(b) admit no judgement at all.
  TRAINING_NEVER_CAPITAL: 0.9,
  // A named authority decided it and the document stated what the rule needed.
  SUBSCRIPTION_TERM_UNDER_TWO_YEARS: 0.8,
  SERVICE_CONTRACT_EXPENSED: 0.75,
  PERPETUAL_LICENCE_CAPITALISED: 0.75,
  HARDWARE_PER_UNIT_AT_OR_ABOVE_THRESHOLD: 0.75,
  // A named authority, but resting on the practice's own policy number.
  PERPETUAL_LICENCE_BELOW_THRESHOLD: 0.65,
  HARDWARE_PER_UNIT_BELOW_THRESHOLD: 0.65,
  INSTALLATION_INTO_ASSET: 0.65,
  CLOUD_CONFIGURATION_EXPENSED: 0.65,
  INSTALLATION_WITH_NO_ASSET_EXPENSED: 0.55,
  // At the published population figure: a word matched, nothing was reasoned.
  KEYWORD_MATCH_ON_CHART: 0.5,
  // Below it, deliberately. Supplier identity is the weakest signal on a page.
  SUPPLIER_NAME_FALLBACK: 0.35,
  // Escalation-only bases. No coding is offered, so no confidence is claimed.
  SOFTWARE_TERM_NOT_STATED: 0,
  PROFESSIONAL_SERVICES_SPLIT_REQUIRED: 0,
  HARDWARE_PER_UNIT_UNSETTLED: 0,
  FOREIGN_TAX_LINE: 0,
  NOTHING_MATCHED: 0,
  OFF_CHART_CODE_REFUSED: 0,
};

/**
 * What a new supplier costs the confidence.
 *
 * §24.4.1 makes a new supplier always-review, and §24.4.7 puts accuracy on an
 * unseen category at roughly a fifth of its seen-category level. The penalty is
 * a display honesty, not a gate.
 */
export const NEW_SUPPLIER_CONFIDENCE_PENALTY = 0.1;

/** Nothing offered is ever shown as less certain than this — below it, escalating is the honest answer. */
export const CONFIDENCE_FLOOR = 0.3;

/**
 * What the runner-up is worth.
 *
 * Published top-2 accuracy runs about ten points above top-1, so the second
 * choice carries that increment. It is the value of *offering* an alternative,
 * not a claim that the alternative is 10% likely on its own.
 */
export const SECOND_CHOICE_CONFIDENCE = 0.1;

/**
 * Rounding slack for the arithmetic check, in minor units: a penny for the
 * document plus a penny per line, because each line can carry its own rounding.
 */
function toleranceFor(lineCount: number): number {
  return 1 + lineCount;
}

/**
 * **Does the document add up?** Checked before anything is categorised.
 *
 * The invoice that prompted this work does not: a subtotal of $52,550.00 at a
 * stated 8.875% is $57,213.81, and the document says $54,352.51. A category
 * assigned on top of that is a category assigned to a number that is not the
 * number, so this is a hard stop rather than a warning.
 *
 * It accepts any of the three readings a real invoice can have, and fails only
 * when **none** of them reconciles — so it does not manufacture a mismatch out
 * of not knowing whether a line total was quoted net or gross:
 *
 * 1. line totals are gross and already include their tax;
 * 2. line totals are net and each line states its own tax;
 * 3. line totals are net and the tax is stated once in the header.
 */
export function documentReconciles(evidence: CodingEvidence): boolean {
  const { totalPence, taxPence, lines } = evidence;
  if (totalPence === null || lines.length === 0) return true;
  if (lines.some((line) => line.netPence === null)) return true;

  const linesNet = lines.reduce((sum, line) => sum + (line.netPence ?? 0), 0);
  const linesTax = lines.reduce((sum, line) => sum + (line.taxPence ?? 0), 0);
  const tolerance = toleranceFor(lines.length);

  const candidates = [linesNet, linesNet + linesTax, linesNet + (taxPence ?? 0)];
  return candidates.some((candidate) => Math.abs(candidate - totalPence) <= tolerance);
}

/** `documents.category_code` → the emittable `Ledger: Account`, or null when it is off-chart. */
function analysisAccountFor(chart: SuggestionChart, categoryCode: string): string | null {
  const account = resolveAccount(chart.accounts, categoryCode);
  if (account !== null) return analysisAccount(account);
  return chart.categories.find((category) => category.code === categoryCode)?.name ?? null;
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(CONFIDENCE_FLOOR, Math.round(value * 100) / 100));
}

/**
 * The suggestion for one document.
 *
 * ⚠ **There is no `null` return and no `undefined` branch.** Every path ends in
 * a `SUGGEST` carrying a code, a confidence and a named basis, or an `ESCALATE`
 * carrying a named reason from the closed set. That is the property the whole
 * of `escalation.ts` exists to make true, and `ai-suggestion.test.ts` asserts it
 * exhaustively rather than by example.
 */
export function suggestCoding(
  evidence: CodingEvidence,
  chart: SuggestionChart,
  policy: CapitalisationPolicy = PLATFORM_DEFAULT_CAPITALISATION_POLICY,
): AiCodingSuggestion {
  const advisories = new Set<CodingAdvisory>();
  if (evidence.supplier.isNew) advisories.add('NEW_SUPPLIER');

  // Foreign consumption tax is part of the cost and is never reclaimable input
  // VAT — but where the UK reverse charge applies it still increases the value
  // the charge is calculated on (HMRC VATPOSS14600). Both are said, because
  // saying only the first invites the second to be got wrong.
  const foreignCurrency = evidence.currency !== null && evidence.currency.toUpperCase() !== 'GBP';
  if (foreignCurrency && (evidence.taxPence ?? 0) !== 0) {
    advisories.add('FOREIGN_TAX_IN_COST');
    advisories.add('REVERSE_CHARGE_INCREASES_BASE');
  }

  const escalation = (reason: CodingEscalationReason, basis: CodingBasis, candidates: readonly string[] = []): AiCodingSuggestion => ({
    outcome: 'ESCALATE',
    authority: 'AI_INFERENCE',
    provenance: 'AI_SUGGESTED',
    basis,
    reason,
    candidateCategoryCodes: candidates,
    confidence: null,
    advisories: [...advisories],
    note: noteFor(ESCALATION_PROMPTS[reason], advisories),
  });

  if (chart.accounts.length === 0 && chart.categories.length === 0) {
    return escalation('NO_CHART_OF_ACCOUNTS', 'NOTHING_MATCHED');
  }

  // ⚠ Arithmetic BEFORE classification. A correct system hard-stops on the sums
  // before it tries to code anything.
  if (!documentReconciles(evidence)) return escalation('ARITHMETIC_MISMATCH', 'NOTHING_MATCHED');

  const chartCodes = new Set<string>([...chart.accounts.map((a) => a.code), ...chart.categories.map((c) => c.code)]);

  if (evidence.lines.length === 0) {
    return supplierFallback(evidence, chart, advisories, escalation);
  }

  const hasCapitalHardware = evidence.lines.some((line) => capitalisesAsHardware(line, policy));
  const context = { chartCodes, accounts: chart.accounts, policy, currency: evidence.currency, hasCapitalHardware };

  let worst: { reason: CodingEscalationReason; basis: CodingBasis } | null = null;
  const coded: { categoryCode: string; treatment: LineTreatment; basis: CodingBasis; secondChoiceCode: string | null }[] = [];
  let sawTaxLine = false;

  for (const line of evidence.lines) {
    const verdict = classifyLine(line, context);
    for (const advisory of verdict.advisories) advisories.add(advisory);
    if (verdict.outcome === 'TAX_LINE') {
      sawTaxLine = true;
      advisories.add('FOREIGN_TAX_IN_COST');
      if (foreignCurrency) advisories.add('REVERSE_CHARGE_INCREASES_BASE');
      continue;
    }
    if (verdict.outcome === 'ESCALATE') {
      worst = worst === null ? { reason: verdict.reason, basis: verdict.basis } : { reason: moreSevere(worst.reason, verdict.reason), basis: worst.basis };
      continue;
    }
    coded.push(verdict);
  }

  const distinct = [...new Set(coded.map((entry) => entry.categoryCode))];

  // A line nobody could code outranks a document whose remaining lines agree:
  // an invoice is coded as a whole or not at all while `category_code` is one
  // column, and reporting the easy half would hide the hard one.
  if (worst !== null) return escalation(worst.reason, worst.basis, distinct);

  if (coded.length === 0) {
    if (sawTaxLine) return escalation('NO_LINE_DETAIL', 'FOREIGN_TAX_LINE');
    return supplierFallback(evidence, chart, advisories, escalation);
  }

  if (distinct.length > 1) {
    const treatments = new Set(coded.map((entry) => entry.treatment));
    // Capital and revenue on one document is a different, worse problem from
    // two overheads on one document: the first misstates a deduction and a
    // capital allowance, the second misstates a line of a P&L.
    return treatments.size > 1
      ? escalation('MIXED_CAPITAL_AND_REVENUE', 'PROFESSIONAL_SERVICES_SPLIT_REQUIRED', distinct)
      : escalation('MULTIPLE_CATEGORIES_ON_ONE_DOCUMENT', 'NOTHING_MATCHED', distinct);
  }

  const winner = coded[0] as (typeof coded)[number];
  return suggestion(winner.categoryCode, winner.treatment, winner.basis, winner.secondChoiceCode, chart, evidence, advisories);
}

/**
 * The one path that consults a supplier name, and it is last for a reason: a
 * reseller sells subscriptions AND hardware AND services, so who sent the
 * invoice says far less about the coding than what is on it.
 */
function supplierFallback(
  evidence: CodingEvidence,
  chart: SuggestionChart,
  advisories: Set<CodingAdvisory>,
  escalation: (reason: CodingEscalationReason, basis: CodingBasis, candidates?: readonly string[]) => AiCodingSuggestion,
): AiCodingSuggestion {
  const name = evidence.supplier.name;
  const hits = name === null ? [] : keywordMatchesOnChart(name, chart.accounts);
  if (hits.length === 0) {
    return escalation(evidence.supplier.isNew ? 'NEW_SUPPLIER_NO_HISTORY' : 'NO_LINE_DETAIL', 'NOTHING_MATCHED');
  }
  const first = hits[0] as string;
  return suggestion(first, treatmentOf(first, chart.accounts), 'SUPPLIER_NAME_FALLBACK', hits[1] ?? null, chart, evidence, advisories);
}

function suggestion(
  categoryCode: string,
  treatment: LineTreatment,
  basis: CodingBasis,
  secondChoiceCode: string | null,
  chart: SuggestionChart,
  evidence: CodingEvidence,
  advisories: Set<CodingAdvisory>,
): AiCodingSuggestion {
  const penalty = evidence.supplier.isNew ? NEW_SUPPLIER_CONFIDENCE_PENALTY : 0;
  const confidence = clampConfidence(CONFIDENCE_BY_BASIS[basis] - penalty);
  const account = chart.categories.find((category) => category.code === categoryCode);
  const label = account?.name ?? analysisAccountFor(chart, categoryCode) ?? categoryCode;

  return {
    outcome: 'SUGGEST',
    authority: 'AI_INFERENCE',
    provenance: 'AI_SUGGESTED',
    basis,
    categoryCode,
    analysisAccount: analysisAccountFor(chart, categoryCode),
    confidence,
    treatment,
    secondChoice:
      secondChoiceCode === null
        ? null
        : {
            categoryCode: secondChoiceCode,
            analysisAccount: analysisAccountFor(chart, secondChoiceCode),
            confidence: SECOND_CHOICE_CONFIDENCE,
          },
    advisories: [...advisories],
    note: noteFor(`Suggested — not applied — as ${label}, on ${BASIS_SENTENCES[basis]}`, advisories),
  };
}

/** One sentence per named rule, so the card explains itself without a legend. */
const BASIS_SENTENCES: Readonly<Record<CodingBasis, string>> = {
  TRAINING_NEVER_CAPITAL: 'the rule that training is never capitalisable (IAS 16.19(c), IAS 38.69(b)).',
  SERVICE_CONTRACT_EXPENSED: 'the rule that consuming a supplier’s service or infrastructure acquires nothing, so nothing can be capitalised.',
  SUBSCRIPTION_TERM_UNDER_TWO_YEARS:
    'the rule that a subscription is revenue whatever it costs — HMRC BIM35805’s under-two-years test, and a right of access being a service contract (IFRIC, March 2019).',
  PERPETUAL_LICENCE_CAPITALISED:
    'the rule that a perpetual licence lasting two years or more is capital (HMRC BIM35805; CAA 2001 s.71 treats software as plant).',
  PERPETUAL_LICENCE_BELOW_THRESHOLD: 'a perpetual licence below this practice’s capitalisation threshold, tested per unit.',
  HARDWARE_PER_UNIT_AT_OR_ABOVE_THRESHOLD: 'hardware at or above this practice’s capitalisation threshold, tested per unit rather than per line.',
  HARDWARE_PER_UNIT_BELOW_THRESHOLD: 'hardware below this practice’s capitalisation threshold, tested per unit rather than per line.',
  INSTALLATION_INTO_ASSET: 'the rule that installing and testing an asset capitalises into it (IAS 16.17(d)–(e)).',
  INSTALLATION_WITH_NO_ASSET_EXPENSED: 'installation work with no capitalised asset on the document for it to attach to.',
  CLOUD_CONFIGURATION_EXPENSED: 'the rule that configuring the supplier’s hosted software creates no asset the client controls, so it is expensed.',
  PROFESSIONAL_SERVICES_SPLIT_REQUIRED: 'a services line that covers both capital and revenue work.',
  SOFTWARE_TERM_NOT_STATED: 'a software line whose term the document does not state — the one thing that decides capital from revenue.',
  HARDWARE_PER_UNIT_UNSETTLED: 'hardware with no per-unit amount to test against the capitalisation policy.',
  KEYWORD_MATCH_ON_CHART: 'a keyword match against this client’s own chart — a word matched, nothing was reasoned.',
  SUPPLIER_NAME_FALLBACK: 'the supplier’s name alone, because the document carried no line detail. The weakest signal on a page.',
  FOREIGN_TAX_LINE: 'a tax line, which is part of the cost rather than a category of its own.',
  NOTHING_MATCHED: 'nothing on this client’s chart.',
  OFF_CHART_CODE_REFUSED: 'a code this client’s chart does not carry, which is refused rather than matched to the nearest one.',
};

/** The sentence, plus any advisories, joined for a card. Never a JSON blob. */
function noteFor(lead: string, advisories: ReadonlySet<CodingAdvisory> | readonly CodingAdvisory[]): string {
  const list = [...advisories];
  if (list.length === 0) return lead;
  return [lead, ...list.map((advisory) => ADVISORY_NOTES[advisory])].join(' ');
}
