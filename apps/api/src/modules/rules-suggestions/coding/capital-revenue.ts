import type { ChartAccount } from '../chart-of-accounts/account.js';
import type { CodingAdvisory, CodingEscalationReason } from './escalation.js';

/**
 * **The decision rules — the deterministic half of the coding suggestion.**
 *
 * Rules first, model for the tail, human review the default. Everything in this
 * file is the *rules first* part: pure functions over one line of a document,
 * no model, no I/O, and every branch traceable to a source an accountant can be
 * pointed at. `coding-instructions.ts` states the same rules in prose for a
 * model to follow on the tail these cannot reach; the two must not drift, and
 * `coding-instructions.test.ts` pins the overlap.
 *
 * ## The four rules that decide the hard cases
 *
 * 1. **Line-item description beats supplier identity.** A reseller sells
 *    subscriptions AND hardware AND services, frequently on one invoice, so the
 *    supplier name is the *weakest* signal on the page and is consulted only
 *    when there is no line detail at all.
 * 2. **Amount magnitude is used for exactly one thing: the capitalisation
 *    threshold.** It never chooses between two expense accounts. A large number
 *    is not evidence that a cost is a different KIND of cost.
 * 3. **Subscription and recurring language means revenue, whatever the size.**
 *    A £22,500 annual Microsoft 365 bill is not a capital item — HMRC BIM35805
 *    puts software with a useful life under two years on the revenue side, and
 *    the IFRIC agenda decision of March 2019 makes a right to *access*
 *    supplier-hosted software a service contract rather than an intangible.
 * 4. **Where a rule cannot decide, it escalates with a NAMED reason** from
 *    `escalation.ts`. There is no path here that answers nothing.
 *
 * ## The threshold is a policy, and policies are per-practice
 *
 * There is **no statutory de minimis** for capitalisation in UK GAAP or IFRS.
 * The number is the practice's own accounting policy, which is why
 * {@link CapitalisationPolicy} is an argument every caller must supply and not
 * a constant compiled into a rule. It is also tested **per unit**: two servers
 * at $6,150 are two assets of $6,150, not one purchase of $12,300, and testing
 * the line total instead capitalises things the policy says to expense.
 *
 * ## Line descriptions are untrusted content
 *
 * They come off documents strangers send. They are lower-cased and matched
 * against patterns this repository authored — **classifying a string is not
 * obeying it**, the same argument `chart-of-accounts.ts` makes for
 * `businessActivity` — and they are never concatenated into an account name, a
 * category, or a sentence rendered to a user. A line is referred to by its
 * index, never quoted back.
 */

/**
 * The named rule that decided a line, so a card can show its working (§13.3:
 * *any AI-produced result expands to its trace — inputs considered, the rule
 * that applied, model and confidence*).
 */
export const CODING_BASES = [
  'TRAINING_NEVER_CAPITAL',
  'SERVICE_CONTRACT_EXPENSED',
  'SUBSCRIPTION_TERM_UNDER_TWO_YEARS',
  'PERPETUAL_LICENCE_CAPITALISED',
  'PERPETUAL_LICENCE_BELOW_THRESHOLD',
  'SOFTWARE_TERM_NOT_STATED',
  'INSTALLATION_INTO_ASSET',
  'INSTALLATION_WITH_NO_ASSET_EXPENSED',
  'CLOUD_CONFIGURATION_EXPENSED',
  'PROFESSIONAL_SERVICES_SPLIT_REQUIRED',
  'HARDWARE_PER_UNIT_AT_OR_ABOVE_THRESHOLD',
  'HARDWARE_PER_UNIT_BELOW_THRESHOLD',
  'HARDWARE_PER_UNIT_UNSETTLED',
  'KEYWORD_MATCH_ON_CHART',
  'SUPPLIER_NAME_FALLBACK',
  'FOREIGN_TAX_LINE',
  'NOTHING_MATCHED',
  'OFF_CHART_CODE_REFUSED',
] as const;

export type CodingBasis = (typeof CODING_BASES)[number];

/** What the number does next — the §24.4.6 tier-1 distinction, per line. */
export type LineTreatment = 'CAPITAL' | 'REVENUE';

/**
 * A practice's capitalisation policy.
 *
 * ⚠ **Not a constant, on purpose.** A capitalisation threshold is an accounting
 * policy a practice sets, not a rule of law — there is no de minimis in UK GAAP
 * or IFRS — so the same monitor is capital at one firm and an overhead at
 * another. Compiling a number into the rules would make the platform's opinion
 * override the practice's, invisibly, on every document.
 */
export interface CapitalisationPolicy {
  /** Integer minor units, in {@link currency}. */
  readonly thresholdPence: number;
  /** ISO 4217 the threshold is expressed in. Compared, never converted. */
  readonly currency: string;
  /**
   * How close to the threshold, as a whole-number percentage, still counts as
   * "on it" and escalates rather than deciding. A judgement inside this band is
   * the practice's, not a rounding.
   */
  readonly boundaryBandPercent: number;
  /** Where the number came from — so a card can say "your policy" or "our default". */
  readonly source: 'PRACTICE' | 'PLATFORM_DEFAULT';
}

/**
 * The fallback used when a practice has not set a policy.
 *
 * £1,000 is a common small-practice threshold and is **stated as a default, not
 * as a standard** — the `source` field carries that distinction to the surface
 * so an accountant is never shown a capital/revenue call presented as theirs
 * when it was ours. A per-practice setting is owed; see this module's
 * `CLAUDE.md`.
 */
export const PLATFORM_DEFAULT_CAPITALISATION_POLICY: CapitalisationPolicy = {
  thresholdPence: 100_000,
  currency: 'GBP',
  boundaryBandPercent: 10,
  source: 'PLATFORM_DEFAULT',
};

/** One line of a document, as the coding rules need it. `description` is UNTRUSTED. */
export interface CodingLine {
  readonly description: string;
  /** Units on the line. Null, zero and negatives are all read as one unit. */
  readonly quantity: number | null;
  /** The line amount in integer minor units, excluding its own tax where the document separates it. */
  readonly netPence: number | null;
  /** Tax shown against this line, in integer minor units. */
  readonly taxPence: number | null;
}

/** What the rules could work out about the document as a whole, before any single line is judged. */
export interface LineContext {
  /** The codes on THIS client's chart. A rule whose target is absent refuses rather than substituting. */
  readonly chartCodes: ReadonlySet<string>;
  /** The chart's accounts, for the keyword fallback and for reading a code's tax consequence. */
  readonly accounts: readonly ChartAccount[];
  readonly policy: CapitalisationPolicy;
  /** The document's currency, for the FX advisory. Null when unread. */
  readonly currency: string | null;
  /** Does some other line on this document capitalise? Decides where installation work goes. */
  readonly hasCapitalHardware: boolean;
}

export type LineVerdict =
  | {
      readonly outcome: 'CODE';
      readonly categoryCode: string;
      readonly treatment: LineTreatment;
      readonly basis: CodingBasis;
      /** The runner-up, when the rules had one. Published top-2 accuracy runs about ten points above top-1. */
      readonly secondChoiceCode: string | null;
      readonly advisories: readonly CodingAdvisory[];
    }
  | {
      readonly outcome: 'ESCALATE';
      readonly reason: CodingEscalationReason;
      readonly basis: CodingBasis;
      readonly advisories: readonly CodingAdvisory[];
    }
  /** A tax line is not a category. It is folded into the document's tax handling instead. */
  | { readonly outcome: 'TAX_LINE'; readonly basis: CodingBasis; readonly advisories: readonly CodingAdvisory[] };

// ---------------------------------------------------------------------------
// The patterns. Authored here, matched against untrusted text — never the
// reverse.
// ---------------------------------------------------------------------------

/**
 * ⚠ Training first, and it is the one bright line in this file. IAS 16.19(c)
 * and IAS 38.69(b) both name staff training as expensed as incurred: it is
 * never part of the cost of an asset, whoever bills it and whatever it sits
 * next to on the invoice.
 */
const TRAINING = /\btrain(?:ing|er|ers)?\b|\bcourse\b|\bworkshop\b|\bcpd\b|\bcertification\b|\bknowledge transfer\b|\benablement session\b/;

/**
 * A recurring or managed service. Nothing is acquired, so nothing can be
 * capitalised — however large the contract is, and however much hardware it
 * names.
 *
 * ⚠ Split into a specific and a generic half deliberately. *"Boiler
 * maintenance"* is not IT support, and a single `\bmaintenance\b` sent every
 * plumber's invoice in the product to an IT account. The generic words only
 * fire in an IT context; the specific ones stand alone.
 */
const SUPPORT_SPECIFIC = /\bit support\b|\bmanaged service\b|\bhelp ?desk\b|\bservice desk\b|\bpatch management\b|\bsla\b/;
const SUPPORT_GENERIC = /\bsupport\b|\bmaintenance\b|\bmonitoring\b|\bwarranty\b/;
const IT_CONTEXT = /\bit\b|\bict\b|\bservers?\b|\bnetworks?\b|\bsoftware\b|\bhardware\b|\bsystems?\b|\bendpoints?\b|\bfirewalls?\b|\bcloud\b|\blicen[cs]e/;

/** Consumption of someone else's infrastructure — a service contract at any size. */
const HOSTING = /\bhost(?:ing|ed)\b|\bcloud\b|\bia+as\b|\bpaas\b|\bdata ?cent(?:re|er)\b|\bcolocation\b|\bcolo\b|\bbandwidth\b|\bvirtual machine\b|\bvps\b|\bcompute\b/;

const SOFTWARE = /\bsoftware\b|\blicen[cs]e[sd]?\b|\bsaas\b|\bm365\b|\bmicrosoft 365\b|\boffice 365\b|\bapplication\b|\bplatform\b|\bseats?\b|\buser pack\b/;

/** Recurring language. Rule 3: this means revenue regardless of the amount. */
const RECURRING =
  /\bannual(?:ly)?\b|\bmonthly\b|\byearly\b|\bquarterly\b|\bper (?:user|seat|month|year)\b|\bsubscription\b|\brenewal\b|\brecurring\b|\b12[- ]months?\b|\b1[- ]year\b|\b36[- ]months?\b/;

/** Perpetual language. Only this — never the vendor — puts a licence on the capital side. */
const PERPETUAL = /\bperpetual\b|\bone[- ]?(?:off|time) licen[cs]e\b|\bpermanent licen[cs]e\b|\blifetime licen[cs]e\b|\bowned licen[cs]e\b/;

/**
 * Work that prepares an owned asset for use — IAS 16.17(d)–(e).
 *
 * ⚠ `racking`, never a bare `rack`: "Dell PowerEdge R760 **rack** server" is a
 * server, not an installation service, and the bare word sent it to a services
 * account with a straight face.
 */
const INSTALL = /\binstall(?:ation|ing|s|ed)?\b|\bcommission(?:ing|ed)?\b|\bracking\b|\brack[- ]and[- ]stack\b|\bcabling\b|\bassembly\b|\bsite prep(?:aration)?\b|\bon[- ]?site build\b|\bphysical deployment\b/;

/** Work on software the client does not control — expensed. */
const CONFIGURE =
  /\bconfigur(?:e|ed|ation|ing)\b|\bimplementation\b|\bonboarding\b|\bset[- ]?up\b|\bdata migration\b|\bintegration\b|\bcustomi[sz](?:ation|ing|ed)\b|\btenant build\b/;

const PROFESSIONAL = /\bprofessional services\b|\bconsult(?:ing|ancy|ant|ants)\b|\bengineering services\b|\bservices\b|\bproject management\b/;

const HARDWARE =
  /\bservers?\b|\bpoweredge\b|\bproliant\b|\bswitch(?:es)?\b|\brouters?\b|\bfirewalls?\b|\blaptops?\b|\bdesktops?\b|\bworkstations?\b|\bmonitors?\b|\bnas\b|\bsan\b|\bstorage array\b|\bups\b|\baccess points?\b|\bprinters?\b|\bscanners?\b|\btablets?\b|\bappliances?\b|\bchassis\b|\benclosure\b/;

const SMALL_IT = /\bkeyboards?\b|\bmice\b|\bmouse\b|\bcables?\b|\badapters?\b|\busb\b|\bheadsets?\b|\bwebcams?\b|\btoner\b|\bcartridges?\b|\bdocking station\b/;

/**
 * A consumption-tax line. Never a category.
 *
 * ⚠ Foreign consumption tax — US sales tax, EU VAT on an EU supplier's invoice,
 * Australian GST — is **part of the cost of what was bought** and is never
 * reclaimable input VAT on a UK return. Giving it a category at all is how it
 * finds its way onto a tax control account.
 */
const TAX_LINE = /\bsales tax\b|\buse tax\b|\bstate tax\b|\bgst\b|\bhst\b|\bpst\b|\bvat\b|\bconsumption tax\b/;

/** Units on a line. Anything unusable reads as one — never as zero, which would divide the policy away. */
export function unitsOn(line: Pick<CodingLine, 'quantity'>): number {
  const quantity = line.quantity;
  if (quantity === null || !Number.isFinite(quantity) || quantity < 1) return 1;
  return Math.floor(quantity);
}

export type ThresholdVerdict = 'AT_OR_ABOVE' | 'BELOW' | 'ON_THE_LINE' | 'UNSETTLED';

/**
 * The capitalisation test — **per unit, and in integers throughout**.
 *
 * `netPence / units` is never computed: an integer division would round the
 * comparison, and a float one would put a float in a money path (R5). The test
 * is instead `netPence` against `threshold × units`, which is the same
 * comparison without either hazard.
 */
export function thresholdVerdictFor(line: CodingLine, policy: CapitalisationPolicy): ThresholdVerdict {
  const net = line.netPence;
  if (net === null || !Number.isInteger(net) || net <= 0) return 'UNSETTLED';

  const units = unitsOn(line);
  const scaledThreshold = policy.thresholdPence * units;
  // |net − T·units| · 100 ≤ T·units·band, which is |unit − T| ≤ T·band/100 with
  // no division anywhere.
  const distance = Math.abs(net - scaledThreshold) * 100;
  if (distance <= scaledThreshold * policy.boundaryBandPercent) return 'ON_THE_LINE';
  return net >= scaledThreshold ? 'AT_OR_ABOVE' : 'BELOW';
}

/** Does this line, on its own, describe hardware the policy would capitalise? */
export function capitalisesAsHardware(line: CodingLine, policy: CapitalisationPolicy): boolean {
  const text = line.description.toLowerCase();
  if (TAX_LINE.test(text) || TRAINING.test(text) || isSupport(text) || HOSTING.test(text)) return false;
  if (!HARDWARE.test(text) || SMALL_IT.test(text)) return false;
  return thresholdVerdictFor(line, policy) === 'AT_OR_ABOVE';
}

/** A support or managed-service line — specific words alone, generic words only in an IT context. */
function isSupport(text: string): boolean {
  return SUPPORT_SPECIFIC.test(text) || (SUPPORT_GENERIC.test(text) && IT_CONTEXT.test(text));
}

/**
 * Classify one line.
 *
 * The order of the branches is the rule, not an implementation detail:
 * a support contract is read before the hardware it supports, services are read
 * before the hardware they are performed on, and the term of a licence is read
 * before its price. Every one of those orderings exists because the reverse
 * produced a §24.4.6 tier-1 error from a noun.
 */
export function classifyLine(line: CodingLine, context: LineContext): LineVerdict {
  const text = line.description.toLowerCase();
  const advisories: CodingAdvisory[] = [];
  if (context.currency !== null && context.currency.toUpperCase() !== context.policy.currency.toUpperCase()) {
    advisories.push('THRESHOLD_COMPARED_WITHOUT_FX');
  }

  const code = (categoryCode: string, treatment: LineTreatment, basis: CodingBasis, secondChoiceCode: string | null = null, extra: readonly CodingAdvisory[] = []): LineVerdict => {
    if (!context.chartCodes.has(categoryCode)) {
      // Refused, never fuzzy-matched. A near miss on a chart of accounts is how
      // food costs quietly become drink costs (`drafts.ts`).
      return { outcome: 'ESCALATE', reason: 'CODE_NOT_ON_CHART', basis: 'OFF_CHART_CODE_REFUSED', advisories: [...advisories, ...extra] };
    }
    const second = secondChoiceCode !== null && context.chartCodes.has(secondChoiceCode) ? secondChoiceCode : null;
    return { outcome: 'CODE', categoryCode, treatment, basis, secondChoiceCode: second, advisories: [...advisories, ...extra] };
  };
  const escalate = (reason: CodingEscalationReason, basis: CodingBasis, extra: readonly CodingAdvisory[] = []): LineVerdict => ({
    outcome: 'ESCALATE',
    reason,
    basis,
    advisories: [...advisories, ...extra],
  });

  // 0 · A tax line is not a category.
  if (TAX_LINE.test(text)) {
    return { outcome: 'TAX_LINE', basis: 'FOREIGN_TAX_LINE', advisories };
  }

  // 1 · Training. The bright line — IAS 16.19(c), IAS 38.69(b).
  if (TRAINING.test(text)) return code('TRAINING', 'REVENUE', 'TRAINING_NEVER_CAPITAL');

  // 2 · Support and managed services, BEFORE the hardware they name.
  if (isSupport(text)) {
    return code('IT_SUPPORT_AND_MANAGED_SERVICES', 'REVENUE', 'SERVICE_CONTRACT_EXPENSED', 'SOFTWARE_AND_SUBSCRIPTIONS');
  }

  // 3 · Infrastructure consumed rather than owned. Never capital, at any amount.
  if (HOSTING.test(text)) {
    return code('HOSTING_AND_INFRASTRUCTURE', 'REVENUE', 'SERVICE_CONTRACT_EXPENSED', 'SOFTWARE_AND_SUBSCRIPTIONS');
  }

  // 4 · Software — and the term, not the vendor and not the price, decides it.
  if (SOFTWARE.test(text) || PERPETUAL.test(text)) {
    if (PERPETUAL.test(text)) {
      const verdict = thresholdVerdictFor(line, context.policy);
      if (verdict === 'ON_THE_LINE') return escalate('THRESHOLD_BOUNDARY', 'PERPETUAL_LICENCE_CAPITALISED', ['PER_UNIT_THRESHOLD_APPLIED']);
      if (verdict === 'BELOW') {
        return code('SOFTWARE_AND_SUBSCRIPTIONS', 'REVENUE', 'PERPETUAL_LICENCE_BELOW_THRESHOLD', 'FA_SOFTWARE_LICENCES', ['PER_UNIT_THRESHOLD_APPLIED']);
      }
      return code('FA_SOFTWARE_LICENCES', 'CAPITAL', 'PERPETUAL_LICENCE_CAPITALISED', 'SOFTWARE_AND_SUBSCRIPTIONS', ['PER_UNIT_THRESHOLD_APPLIED']);
    }
    if (RECURRING.test(text)) {
      // ⚠ Rule 3. No amount is consulted here and none may be added: the size of
      // an annual bill says nothing about whether it bought an asset.
      const prepaid = /\bannual(?:ly)?\b|\byearly\b|\b12[- ]months?\b|\b1[- ]year\b/.test(text);
      return code(
        'SOFTWARE_AND_SUBSCRIPTIONS',
        'REVENUE',
        'SUBSCRIPTION_TERM_UNDER_TWO_YEARS',
        'HOSTING_AND_INFRASTRUCTURE',
        prepaid ? ['ANNUAL_FEE_MAY_BE_PART_PREPAID'] : [],
      );
    }
    // ⚠ The refusal that matters most. "Veeam Backup & Replication Enterprise"
    // is capital if perpetual and revenue if annual, and the invoice has not
    // said which. Inferring from the vendor is guessing with a citation.
    return escalate('SOFTWARE_TERM_UNKNOWN', 'SOFTWARE_TERM_NOT_STATED');
  }

  // 5 · Services on the document — the hardest line, and the one that SPLITS.
  const installs = INSTALL.test(text);
  const configures = CONFIGURE.test(text);
  if (installs && configures) {
    return escalate('MIXED_CAPITAL_AND_REVENUE', 'PROFESSIONAL_SERVICES_SPLIT_REQUIRED');
  }
  if (installs) {
    return context.hasCapitalHardware
      ? code('FA_INSTALLATION_AND_COMMISSIONING', 'CAPITAL', 'INSTALLATION_INTO_ASSET', 'SOFTWARE_IMPLEMENTATION')
      : code('SOFTWARE_IMPLEMENTATION', 'REVENUE', 'INSTALLATION_WITH_NO_ASSET_EXPENSED', 'PROFESSIONAL_FEES');
  }
  if (configures) {
    // Configuration alongside a capitalised asset is the canonical split: some
    // of it prepares the asset, some of it configures the supplier's software,
    // and no single category is right for the line as written.
    return context.hasCapitalHardware
      ? escalate('MIXED_CAPITAL_AND_REVENUE', 'PROFESSIONAL_SERVICES_SPLIT_REQUIRED')
      : code('SOFTWARE_IMPLEMENTATION', 'REVENUE', 'CLOUD_CONFIGURATION_EXPENSED', 'PROFESSIONAL_FEES');
  }
  if (PROFESSIONAL.test(text)) {
    return code('PROFESSIONAL_FEES', 'REVENUE', 'KEYWORD_MATCH_ON_CHART', 'SOFTWARE_IMPLEMENTATION');
  }

  // 6 · Small IT before hardware, so a network cable is not a fixed asset.
  if (SMALL_IT.test(text)) return code('IT_EQUIPMENT_AND_CONSUMABLES', 'REVENUE', 'HARDWARE_PER_UNIT_BELOW_THRESHOLD', 'OFFICE_COSTS');

  // 7 · Hardware — the ONE place an amount is allowed to decide anything.
  if (HARDWARE.test(text)) {
    const verdict = thresholdVerdictFor(line, context.policy);
    if (verdict === 'ON_THE_LINE') return escalate('THRESHOLD_BOUNDARY', 'HARDWARE_PER_UNIT_AT_OR_ABOVE_THRESHOLD', ['PER_UNIT_THRESHOLD_APPLIED']);
    if (verdict === 'UNSETTLED') return escalate('THRESHOLD_BOUNDARY', 'HARDWARE_PER_UNIT_UNSETTLED');
    if (verdict === 'BELOW') {
      return code('IT_EQUIPMENT_AND_CONSUMABLES', 'REVENUE', 'HARDWARE_PER_UNIT_BELOW_THRESHOLD', 'FA_COMPUTER_EQUIPMENT', ['PER_UNIT_THRESHOLD_APPLIED']);
    }
    return code('FA_COMPUTER_EQUIPMENT', 'CAPITAL', 'HARDWARE_PER_UNIT_AT_OR_ABOVE_THRESHOLD', 'IT_EQUIPMENT_AND_CONSUMABLES', ['PER_UNIT_THRESHOLD_APPLIED']);
  }

  // 8 · Last: this client's OWN chart, matched on the keywords the accounts
  // already carry. No accounting rule reasoned about it — a word matched — and
  // the confidence attached to `KEYWORD_MATCH_ON_CHART` says exactly that.
  const hits = keywordMatchesOnChart(text, context.accounts).filter((hit) => context.chartCodes.has(hit));
  const best = hits[0];
  if (best !== undefined) {
    const treatment: LineTreatment = treatmentOf(best, context.accounts);
    return code(best, treatment, 'KEYWORD_MATCH_ON_CHART', hits[1] ?? null);
  }

  return escalate('NO_MATCH_ON_CHART', 'NOTHING_MATCHED');
}

/** What the number does next, read off the chart rather than assumed. */
export function treatmentOf(categoryCode: string, accounts: readonly ChartAccount[]): LineTreatment {
  return accounts.find((account) => account.code === categoryCode)?.taxConsequence === 'CAPITAL' ? 'CAPITAL' : 'REVENUE';
}

/**
 * The last resort before `NO_LINE_DETAIL`: match text against the keywords of
 * accounts on THIS client's chart.
 *
 * Deliberately weak, and deliberately last. It is the only path that consults
 * anything other than a named accounting rule, it is the only one that ever
 * looks at a supplier name, and its confidence says so.
 */
export function keywordMatchesOnChart(text: string, accounts: readonly ChartAccount[]): readonly string[] {
  const needle = ` ${text.toLowerCase()} `;
  const hits: string[] = [];
  for (const account of accounts) {
    if (account.keywords.some((keyword) => needle.includes(keyword))) hits.push(account.code);
  }
  return hits;
}
