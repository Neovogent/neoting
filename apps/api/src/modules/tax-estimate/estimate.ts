/**
 * The tax estimate (D52) — pure. Documents + bank evidence + the country's
 * rules → an ESTIMATE of the VAT/GST return or of company tax for one period,
 * with a range and a completeness score.
 *
 * ⚠ **An estimate, never a return.** Nothing here is submittable and the
 * surfaces say so on every screen and printout (SoT §25). The range is the
 * honest part: bank money with no receipt or invoice could hide tax either
 * way, so it widens the range rather than being guessed into the central
 * figure.
 *
 * Money is integer pence (minor units — cents for A$) throughout. Ratios are
 * applied as integer multiplications followed by ONE Math.round, never as a
 * decimal constant (R5).
 */

export type Country = 'GB' | 'AU';
export type EstimateKind = 'VAT' | 'COMPANY_TAX';
export type VatScheme = 'STANDARD' | 'FLAT_RATE';

/** The facts about a category the estimate needs, from the chart of accounts. */
export interface AccountFacts {
  readonly code: string;
  readonly ledger: string;
  readonly vatTreatment: string;
  readonly taxConsequence: string;
}

export interface EstimateDocument {
  readonly id: string;
  readonly label: string;
  /** `YYYY-MM-DD`, already inside the period. */
  readonly date: string;
  readonly inbox: 'SALES' | 'COSTS';
  readonly creditNote: boolean;
  readonly totalPence: number;
  readonly taxPence: number | null;
  /** READY or PUBLISHED: a person has been through it. */
  readonly reviewed: boolean;
  /** Null when uncategorised or the code is not on the chart. */
  readonly account: AccountFacts | null;
}

/** The period's bank lines, already narrowed to money that could carry tax. */
export interface BankFacts {
  readonly coveredDays: number;
  readonly debitsPence: number;
  readonly creditsPence: number;
  readonly unevidencedDebitsPence: number;
  readonly unevidencedCreditsPence: number;
}

export interface EstimateInput {
  readonly country: Country;
  readonly kind: EstimateKind;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly vatRegistered: boolean;
  readonly vatScheme: VatScheme;
  /** Flat Rate Scheme percentage in basis points (1650 = 16.5%). UK only. */
  readonly flatRateBasisPoints: number | null;
  readonly legalStructure: string | null;
  readonly documents: readonly EstimateDocument[];
  readonly bank: BankFacts | null;
  readonly skipped: {
    readonly otherCurrency: number;
    readonly undated: number;
  };
}

export interface EstimateFigure {
  readonly code: string;
  readonly label: string;
  readonly amountPence: number;
}

export interface EstimateLine {
  readonly documentId: string;
  readonly label: string;
  readonly date: string;
  readonly inbox: 'SALES' | 'COSTS';
  readonly grossPence: number;
  readonly taxPence: number;
  readonly treatment: string;
}

export interface Estimate {
  readonly country: Country;
  readonly kind: EstimateKind;
  readonly currency: 'GBP' | 'AUD';
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly applicable: boolean;
  readonly figures: readonly EstimateFigure[];
  /** Positive = to pay; negative = to reclaim (VAT/GST only). */
  readonly result: {
    readonly amountPence: number;
    readonly lowPence: number;
    readonly highPence: number;
  };
  readonly completeness: {
    readonly scorePercent: number;
    readonly statementCoveragePercent: number;
    readonly evidencedPercent: number;
    readonly reviewedPercent: number;
    readonly unevidencedDebitsPence: number;
    readonly unevidencedCreditsPence: number;
  };
  readonly notes: readonly string[];
  readonly assumptions: readonly string[];
  readonly lines: readonly EstimateLine[];
}

/** VAT 20%, GST 10% — the standard rate the bank-side range is drawn with. */
const STANDARD_RATE: Record<Country, number> = { GB: 20, AU: 10 };
const CURRENCY: Record<Country, 'GBP' | 'AUD'> = { GB: 'GBP', AU: 'AUD' };

/** UK Corporation Tax limits for a 12-month period, in pence (FY2023 onwards). */
const CT_LOWER_LIMIT_PENCE = 5_000_000;
const CT_UPPER_LIMIT_PENCE = 25_000_000;
/** FRS: input VAT is reclaimable only on a capital purchase of £2,000 or more, VAT included. */
const FRS_CAPITAL_THRESHOLD_PENCE = 200_000;
/** AU small-business instant asset write-off, per asset (ex GST) — an assumption, stated on the estimate. */
const AU_WRITE_OFF_THRESHOLD_PENCE = 2_000_000;

const NOT_A_COMPANY = new Set(['SOLE_TRADER', 'PARTNERSHIP']);

export function estimate(input: EstimateInput): Estimate {
  const completeness = completenessOf(input);
  const partial = input.kind === 'VAT' ? vatEstimate(input) : companyTaxEstimate(input);
  return {
    country: input.country,
    kind: input.kind,
    currency: CURRENCY[input.country],
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    applicable: partial.applicable,
    figures: partial.figures,
    result: partial.result,
    completeness,
    notes: [...partial.notes, ...evidenceNotes(input, partial.kindWords), ...skippedNotes(input)],
    assumptions: partial.assumptions,
    lines: partial.lines,
  };
}

interface Partial {
  readonly applicable: boolean;
  readonly figures: EstimateFigure[];
  readonly result: Estimate['result'];
  readonly notes: string[];
  readonly assumptions: string[];
  readonly lines: EstimateLine[];
  readonly kindWords: KindWords;
}

/** What the bank-side sentences say about each direction, per kind. */
interface KindWords {
  readonly outMissing: (taxPence: number) => string;
  readonly inMissing: (taxPence: number) => string;
  readonly outTax: number;
  readonly inTax: number;
}

// ── VAT / GST ────────────────────────────────────────────────────────────────

function vatEstimate(input: EstimateInput): Partial {
  const c = input.country;
  const tax = c === 'GB' ? 'VAT' : 'GST';
  const money = (p: number) => formatMoney(p, c);
  const flat = c === 'GB' && input.vatScheme === 'FLAT_RATE' && input.flatRateBasisPoints !== null;
  const bps = input.flatRateBasisPoints ?? 0;

  let output = 0;
  let input4 = 0;
  let salesNet = 0;
  let salesGross = 0;
  let purchasesNet = 0;
  let capitalGross = 0;
  let otherCostsGross = 0;
  let blocked = 0;
  let flatCapitalInput = 0;
  let nullTaxSales = 0;
  let nullTaxCosts = 0;
  let uncategorised = 0;
  let noTaxRead = 0;
  const lines: EstimateLine[] = [];

  for (const doc of input.documents) {
    const sign = doc.creditNote ? -1 : 1;
    const gross = sign * Math.abs(doc.totalPence);
    const docTax = doc.taxPence === null ? 0 : sign * Math.abs(doc.taxPence);
    if (doc.taxPence === null) noTaxRead += 1;
    let treatment: string;

    if (doc.inbox === 'SALES') {
      output += docTax;
      salesNet += gross - docTax;
      salesGross += gross;
      if (doc.taxPence === null) nullTaxSales += gross;
      treatment = 'Sale';
    } else {
      const capital = doc.account?.ledger === 'Fixed assets';
      if (capital) capitalGross += gross;
      else otherCostsGross += gross;
      purchasesNet += gross - docTax;
      if (doc.account === null) uncategorised += 1;
      if (doc.account?.vatTreatment === 'BLOCKED') {
        blocked += docTax;
        treatment = `Purchase — ${tax} not reclaimable`;
      } else {
        input4 += docTax;
        if (doc.taxPence === null) nullTaxCosts += gross;
        if (flat && capital && Math.abs(gross) >= FRS_CAPITAL_THRESHOLD_PENCE) flatCapitalInput += docTax;
        treatment = capital ? 'Capital purchase' : doc.account === null ? 'Purchase — uncategorised' : 'Purchase';
      }
    }
    lines.push({
      documentId: doc.id,
      label: doc.label,
      date: doc.date,
      inbox: doc.inbox,
      grossPence: gross,
      taxPence: docTax,
      treatment,
    });
  }

  if (flat) {
    output = Math.round((salesGross * bps) / 10000);
    input4 = flatCapitalInput;
  }

  const rate = STANDARD_RATE[c];
  const unevidencedIn = input.bank?.unevidencedCreditsPence ?? 0;
  const unevidencedOut = input.bank?.unevidencedDebitsPence ?? 0;
  const missingOutput = flat ? Math.round((unevidencedIn * bps) / 10000) : taxShare(unevidencedIn, rate) + taxShare(nullTaxSales, rate);
  const missingInput = flat ? 0 : taxShare(unevidencedOut, rate) + taxShare(nullTaxCosts, rate);

  const central = output - input4;
  const notes: string[] = [];
  const assumptions: string[] = [];
  const kindWords: KindWords = {
    outTax: missingInput,
    inTax: missingOutput,
    outMissing: (p) => `If they carried ${tax}, up to ${money(p)} more could be reclaimed.`,
    inMissing: (p) => `If those are taxable sales, up to ${money(p)} more ${tax} would be due.`,
  };

  if (!input.vatRegistered) {
    return {
      applicable: false,
      figures: [],
      result: { amountPence: 0, lowPence: 0, highPence: 0 },
      notes: [
        `This client isn't recorded as ${tax}-registered, so there is no ${tax} return to estimate. Change it in the client's settings if that's wrong.`,
      ],
      assumptions: [],
      lines,
      kindWords,
    };
  }

  if (blocked !== 0) notes.push(`${money(blocked)} of ${tax} on purchases that can't be reclaimed (such as entertaining) was left out.`);
  if (uncategorised > 0)
    notes.push(
      `${uncategorised} purchase${uncategorised === 1 ? ' has' : 's have'} no category, so the usual ${tax} treatment was assumed.`,
    );
  if (noTaxRead > 0)
    notes.push(
      `${noTaxRead} document${noTaxRead === 1 ? ' has' : 's have'} no ${tax} amount read; treated as zero, and the range allows for it.`,
    );

  assumptions.push('Accruals basis: documents count by their own date. Cash accounting would use payment dates instead.');
  assumptions.push(`Each category's usual ${tax} treatment, as the client's chart of accounts states it.`);

  let figures: EstimateFigure[];
  if (c === 'GB') {
    if (flat) {
      assumptions.push(
        `Flat Rate Scheme at ${percentText(bps)}: box 1 is that share of VAT-inclusive turnover; input VAT is reclaimed only on capital purchases of £2,000 or more.`,
      );
    }
    assumptions.push('No sales to or purchases from the EU under the Northern Ireland protocol (boxes 2, 8 and 9 are zero).');
    const box3 = output;
    figures = [
      {
        code: '1',
        label: 'VAT due on sales and other outputs',
        amountPence: output,
      },
      {
        code: '2',
        label: 'VAT due on acquisitions from the EU',
        amountPence: 0,
      },
      { code: '3', label: 'Total VAT due', amountPence: box3 },
      {
        code: '4',
        label: 'VAT reclaimed on purchases and other inputs',
        amountPence: input4,
      },
      {
        code: '5',
        label: 'Net VAT to pay to HMRC or reclaim',
        amountPence: Math.abs(box3 - input4),
      },
      {
        code: '6',
        label: 'Total value of sales, excluding VAT',
        amountPence: wholePounds(flat ? salesGross : salesNet),
      },
      {
        code: '7',
        label: 'Total value of purchases, excluding VAT',
        amountPence: wholePounds(purchasesNet),
      },
      {
        code: '8',
        label: 'Total value of goods supplied to the EU',
        amountPence: 0,
      },
      {
        code: '9',
        label: 'Total value of acquisitions from the EU',
        amountPence: 0,
      },
    ];
  } else {
    assumptions.push('GST at 10%. Categories marked as having no claimable GST are left out of 1B.');
    assumptions.push(
      'Australian GST codes are approximated from the chart of accounts; GST-free and input-taxed sales are not split out (G2/G3).',
    );
    figures = [
      {
        code: 'G1',
        label: 'Total sales (including any GST)',
        amountPence: salesGross,
      },
      {
        code: 'G10',
        label: 'Capital purchases (including any GST)',
        amountPence: capitalGross,
      },
      {
        code: 'G11',
        label: 'Non-capital purchases (including any GST)',
        amountPence: otherCostsGross,
      },
      { code: '1A', label: 'GST on sales', amountPence: output },
      { code: '1B', label: 'GST on purchases', amountPence: input4 },
    ];
  }

  return {
    applicable: true,
    figures,
    result: {
      amountPence: central,
      lowPence: central - missingInput,
      highPence: central + missingOutput,
    },
    notes,
    assumptions,
    lines,
    kindWords,
  };
}

// ── Company tax ──────────────────────────────────────────────────────────────

function companyTaxEstimate(input: EstimateInput): Partial {
  const c = input.country;
  const money = (p: number) => formatMoney(p, c);
  const rate = STANDARD_RATE[c];
  const days = periodDays(input.periodStart, input.periodEnd);

  let income = 0;
  let allowable = 0;
  let unknown = 0;
  let disallowed = 0;
  let prepaid = 0;
  let capitalCentral = 0;
  let capitalOther = 0; // AU: assets over the write-off threshold — deducted in the low bound only
  let cars = 0;
  const lines: EstimateLine[] = [];

  for (const doc of input.documents) {
    const sign = doc.creditNote ? -1 : 1;
    const gross = sign * Math.abs(doc.totalPence);
    const docTax = doc.taxPence === null ? 0 : sign * Math.abs(doc.taxPence);
    let treatment: string;

    if (doc.inbox === 'SALES') {
      income += gross - (input.vatRegistered ? docTax : 0);
      treatment = 'Income';
    } else {
      // A registered business reclaims the tax, so its cost is net; a blocked
      // category (or an unregistered business) bears the tax as cost.
      const reclaimed = input.vatRegistered && doc.account?.vatTreatment !== 'BLOCKED';
      const basis = gross - (reclaimed ? docTax : 0);
      const account = doc.account;
      if (account === null) {
        unknown += basis;
        treatment = 'Expense — uncategorised (assumed deductible)';
      } else if (account.taxConsequence === 'DISALLOWABLE') {
        disallowed += basis;
        treatment = 'Not deductible';
      } else if (account.taxConsequence === 'CAPITAL' || account.ledger === 'Fixed assets') {
        if (c === 'GB') {
          if (account.code === 'FA_MOTOR_VEHICLES') {
            cars += basis;
            treatment = 'Car — 18% writing-down allowance';
          } else {
            capitalCentral += basis;
            treatment = 'Capital — Annual Investment Allowance';
          }
        } else if (Math.abs(basis) < AU_WRITE_OFF_THRESHOLD_PENCE) {
          capitalCentral += basis;
          treatment = 'Capital — instant asset write-off';
        } else {
          capitalOther += basis;
          treatment = 'Capital — depreciated (not deducted here)';
        }
      } else if (account.ledger === 'Current assets') {
        prepaid += basis;
        treatment = 'Prepayment — not this period';
      } else {
        allowable += basis;
        treatment = 'Expense';
      }
    }
    lines.push({
      documentId: doc.id,
      label: doc.label,
      date: doc.date,
      inbox: doc.inbox,
      grossPence: gross,
      taxPence: docTax,
      treatment,
    });
  }

  const carAllowance = Math.round((cars * 18) / 100);
  const capitalAllowances = capitalCentral + carAllowance;
  const profit = income - allowable - unknown - capitalAllowances;

  const net = (gross: number) => gross - (input.vatRegistered ? taxShare(gross, rate) : 0);
  const missingIncome = net(input.bank?.unevidencedCreditsPence ?? 0);
  const missingExpenses = net(input.bank?.unevidencedDebitsPence ?? 0);
  // Worst case: unexplained money in was taxable income, uncategorised costs
  // were not deductible, and (AU) no capital write-off applies. Best case: the
  // unexplained money out was deductible, and (AU) every asset was written off.
  const profitHigh = profit + missingIncome + unknown + (c === 'AU' ? capitalCentral : 0);
  const profitLow = profit - missingExpenses - (c === 'AU' ? capitalOther : 0);

  const taxOn = (p: number) => (c === 'GB' ? corporationTax(p, days) : auCompanyTax(p));
  const central = taxOn(profit);

  const notes: string[] = [];
  const assumptions: string[] = [];
  const kindWords: KindWords = {
    outTax: taxOn(profit) - taxOn(profit - missingExpenses),
    inTax: taxOn(profit + missingIncome) - taxOn(profit),
    outMissing: (p) => `If they were business expenses, tax could be up to ${money(p)} lower.`,
    inMissing: (p) => `If that was taxable income, tax could be up to ${money(p)} higher.`,
  };

  if (input.legalStructure !== null && NOT_A_COMPANY.has(input.legalStructure)) {
    return {
      applicable: false,
      figures: [],
      result: { amountPence: 0, lowPence: 0, highPence: 0 },
      notes: [
        "This client isn't a company, so company tax doesn't apply. A sole trader's or partner's profit is taxed as personal income, which this estimate doesn't cover.",
      ],
      assumptions: [],
      lines,
      kindWords,
    };
  }

  if (disallowed !== 0)
    notes.push(`${money(disallowed)} of costs that aren't tax-deductible (such as client entertaining or fines) was left out.`);
  if (unknown !== 0)
    notes.push(`${money(unknown)} of costs have no category; assumed deductible, and the range allows for them not being.`);
  if (prepaid !== 0) notes.push(`${money(prepaid)} of prepayments belong to a later period and were not deducted.`);
  if (profit < 0) notes.push(`The documents show a loss of ${money(-profit)} for the period, so no company tax is estimated.`);

  let figures: EstimateFigure[];
  if (c === 'GB') {
    const limitsDays = Math.min(days, 365);
    assumptions.push('No associated companies, and not a large company paying by quarterly instalments.');
    assumptions.push(
      `19% up to ${money(prorate(CT_LOWER_LIMIT_PENCE, limitsDays))} of profit, 25% above ${money(prorate(CT_UPPER_LIMIT_PENCE, limitsDays))}, with marginal relief between (limits for a ${limitsDays}-day period).`,
    );
    assumptions.push(
      'Plant and machinery fully deducted by the Annual Investment Allowance; cars at the 18% main-pool writing-down allowance.',
    );
    assumptions.push(
      "Only what is in Neo is counted: payroll, directors' pay, interest and other adjustments outside these documents are not.",
    );
    figures = [
      {
        code: 'TURNOVER',
        label: 'Turnover (excluding VAT)',
        amountPence: income,
      },
      {
        code: 'EXPENSES',
        label: 'Allowable expenses',
        amountPence: allowable + unknown,
      },
      {
        code: 'CAPITAL_ALLOWANCES',
        label: 'Capital allowances',
        amountPence: capitalAllowances,
      },
      {
        code: 'DISALLOWED',
        label: 'Costs not deductible (added back)',
        amountPence: disallowed,
      },
      { code: 'PROFIT', label: 'Taxable profit', amountPence: profit },
      { code: 'TAX', label: 'Corporation Tax', amountPence: central },
    ];
  } else {
    assumptions.push('Base rate entity (aggregated turnover under A$50 million, mostly trading income): 25%. Otherwise the rate is 30%.');
    assumptions.push(
      'Capital purchases under A$20,000 deducted in full (instant asset write-off); larger assets are not depreciated here. Whether the write-off applies depends on the income year, so the range covers both.',
    );
    assumptions.push('Only what is in Neo is counted: wages, super, interest and other adjustments outside these documents are not.');
    figures = [
      {
        code: 'INCOME',
        label: 'Assessable income (excluding GST)',
        amountPence: income,
      },
      {
        code: 'DEDUCTIONS',
        label: 'Deductible expenses',
        amountPence: allowable + unknown,
      },
      {
        code: 'CAPITAL_DEDUCTIONS',
        label: 'Capital write-offs',
        amountPence: capitalCentral,
      },
      {
        code: 'NON_DEDUCTIBLE',
        label: 'Non-deductible expenses',
        amountPence: disallowed,
      },
      { code: 'TAXABLE_INCOME', label: 'Taxable income', amountPence: profit },
      { code: 'TAX', label: 'Company tax at 25%', amountPence: central },
    ];
  }

  return {
    applicable: true,
    figures,
    result: {
      amountPence: central,
      lowPence: taxOn(profitLow),
      highPence: taxOn(profitHigh),
    },
    notes,
    assumptions,
    lines,
    kindWords,
  };
}

/**
 * UK Corporation Tax for one accounting period, from 1 April 2023: 19% at or
 * below the lower limit, 25% at or above the upper, and between them 25% less
 * marginal relief of 3/200 × (upper − profit). Limits are pro-rated for a
 * period shorter than 12 months. Assumes no associated companies and no exempt
 * distributions (so augmented profits = taxable profits).
 */
export function corporationTax(profitPence: number, days: number): number {
  if (profitPence <= 0) return 0;
  const d = Math.min(days, 365);
  const lower = prorate(CT_LOWER_LIMIT_PENCE, d);
  const upper = prorate(CT_UPPER_LIMIT_PENCE, d);
  if (profitPence <= lower) return Math.round((profitPence * 19) / 100);
  if (profitPence >= upper) return Math.round((profitPence * 25) / 100);
  return Math.round((profitPence * 25) / 100) - Math.round(((upper - profitPence) * 3) / 200);
}

/** AU company tax at the base-rate-entity rate. */
export function auCompanyTax(profitPence: number): number {
  return profitPence <= 0 ? 0 : Math.round((profitPence * 25) / 100);
}

// ── Completeness and the evidence notes ──────────────────────────────────────

function completenessOf(input: EstimateInput): Estimate['completeness'] {
  const days = periodDays(input.periodStart, input.periodEnd);
  const bank = input.bank;
  const coverage = bank === null ? 0 : Math.floor((Math.min(bank.coveredDays, days) * 100) / days);
  const money = bank === null ? 0 : bank.debitsPence + bank.creditsPence;
  const unevidenced = bank === null ? 0 : bank.unevidencedDebitsPence + bank.unevidencedCreditsPence;
  const evidenced = money > 0 ? Math.floor(((money - unevidenced) * 100) / money) : coverage > 0 ? 100 : 0;

  let value = 0;
  let reviewedValue = 0;
  for (const doc of input.documents) {
    value += Math.abs(doc.totalPence);
    if (doc.reviewed) reviewedValue += Math.abs(doc.totalPence);
  }
  const reviewed = value > 0 ? Math.floor((reviewedValue * 100) / value) : 0;

  // The score is how much of the period's MONEY is evidenced: statement
  // coverage × the evidenced share. Review status is shown beside it, not
  // multiplied in — an unreviewed document is AI-read, usually correctly, and
  // multiplying it in made almost every real practice score near zero.
  return {
    scorePercent: Math.floor((coverage * evidenced) / 100),
    statementCoveragePercent: coverage,
    evidencedPercent: evidenced,
    reviewedPercent: reviewed,
    unevidencedDebitsPence: bank?.unevidencedDebitsPence ?? 0,
    unevidencedCreditsPence: bank?.unevidencedCreditsPence ?? 0,
  };
}

function evidenceNotes(input: EstimateInput, words: KindWords): string[] {
  const c = input.country;
  const money = (p: number) => formatMoney(p, c);
  const notes: string[] = [];
  const bank = input.bank;
  const days = periodDays(input.periodStart, input.periodEnd);
  if (bank === null) {
    notes.push('There is no bank statement for this period, so nothing shows what might be missing. Upload one to tighten the estimate.');
  } else {
    if (bank.coveredDays < days) notes.push(`Bank statements cover ${bank.coveredDays} of the period's ${days} days.`);
    if (bank.unevidencedDebitsPence > 0) {
      notes.push(`${money(bank.unevidencedDebitsPence)} of payments out have no receipt or invoice. ${words.outMissing(words.outTax)}`);
    }
    if (bank.unevidencedCreditsPence > 0) {
      notes.push(`${money(bank.unevidencedCreditsPence)} of money in has no sales invoice. ${words.inMissing(words.inTax)}`);
    }
  }
  const inReview = input.documents.filter((d) => !d.reviewed).length;
  if (inReview > 0)
    notes.push(`${inReview} document${inReview === 1 ? ' is' : 's are'} still waiting for review; the AI-read figures may change.`);
  if (input.documents.length === 0) notes.push('No documents are dated in this period.');
  return notes;
}

function skippedNotes(input: EstimateInput): string[] {
  const notes: string[] = [];
  const { otherCurrency, undated } = input.skipped;
  const home = CURRENCY[input.country];
  if (otherCurrency > 0)
    notes.push(
      `${otherCurrency} document${otherCurrency === 1 ? ' is' : 's are'} not in ${home} and ${otherCurrency === 1 ? 'was' : 'were'} left out.`,
    );
  if (undated > 0)
    notes.push(
      `${undated} document${undated === 1 ? ' has' : 's have'} no date, so ${undated === 1 ? 'it' : 'they'} could not be placed in a period.`,
    );
  return notes;
}

// ── Small helpers ────────────────────────────────────────────────────────────

/** The tax inside a tax-inclusive amount at `rate`% — 1/6 for 20%, 1/11 for 10%. */
export function taxShare(grossPence: number, rate: number): number {
  return Math.round((grossPence * rate) / (100 + rate));
}

/** Days from start to end, both included. Dates are `YYYY-MM-DD`. */
export function periodDays(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

function prorate(limitPence: number, days: number): number {
  return Math.round((limitPence * days) / 365);
}

/** Truncate toward zero to whole pounds/dollars, staying in minor units. */
function wholePounds(pence: number): number {
  const kept = pence - (pence % 100);
  return kept === 0 ? 0 : kept;
}

function percentText(basisPoints: number): string {
  const whole = (basisPoints - (basisPoints % 100)) / 100;
  const rest = basisPoints % 100;
  return rest === 0 ? `${whole}%` : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}%`;
}

/** `£1,234.56` / `-A$12.00`, from integer minor units. Integer maths only. */
export function formatMoney(pence: number, country: Country): string {
  const abs = Math.abs(pence);
  const units = (abs - (abs % 100)) / 100;
  const symbol = country === 'GB' ? '£' : 'A$';
  return `${pence < 0 ? '-' : ''}${symbol}${units.toLocaleString('en-GB')}.${String(abs % 100).padStart(2, '0')}`;
}
