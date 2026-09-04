// Step 1 — the MODEL plans the transaction universe; this file parses its answer.
//
// The business is FIXED, not chosen: the statement is fed to the seeded
// `biz_burger` client (American Burger Ltd, industry "Restaurants",
// VAT GB334455667, company 09112233), so a ledger for any other trade would
// make the end-to-end test incoherent. What the model plans is everything
// *inside* that trade — suppliers, payroll, settlements, seasonality.
//
// ⚠ Model output is a boundary (root CLAUDE.md: "Zod at every boundary …
// model outputs"). `zod` is not resolvable from the repo root and adding it is
// on the stop-and-ask list, so the boundary is enforced by the hand-rolled
// checks below. They fail with a path, not a boolean, so the retry can feed the
// exact complaint back to the model.
//
// ⚠ NO FLOATS. Every amount is integer pence and every weighting is an integer
// PERCENT, so the whole expansion is integer arithmetic end to end.

import { askFoundry, extractJson, FABLE } from './foundry.js';

/* ── The fixed inputs ─────────────────────────────────────────────────────── */

export const FIXED = {
  name: 'American Burger Ltd',
  trade: 'single-site UK burger restaurant',
  vatNumber: 'GB334455667',
  companyNumber: '09112233',
  /** Suppliers the seed already files documents against — the statement should corroborate them. */
  knownSuppliers: ['Bidfood', 'Coca-Cola Europacific', 'British Gas', 'Just Eat', 'Deliveroo', 'Shell', 'Adobe', 'Amazon'],
} as const;

/* ── The plan shape ───────────────────────────────────────────────────────── */

export type Cadence = 'monthly' | 'quarterly' | 'fourWeekly' | 'weekly' | 'annual';
export type PayMethod = 'card' | 'directDebit' | 'fasterPayment' | 'bacs' | 'standingOrder';
export type IncomeKind = 'cardSettlement' | 'deliveryPlatform' | 'cashBanking' | 'other';

export interface RecurringRule {
  readonly id: string;
  readonly category: string;
  readonly narrative: string;
  readonly direction: 'out' | 'in';
  readonly cadence: Cadence;
  /** 1–28 for monthly/quarterly/annual. Never 29–31: not every month has one. */
  readonly dayOfMonth: number;
  /** 1 (Mon) – 5 (Fri) for weekly/fourWeekly. */
  readonly weekday: number;
  /** Which calendar months it falls in, for quarterly/annual. Empty otherwise. */
  readonly months: number[];
  readonly minPence: number;
  readonly maxPence: number;
  /** Banks do not post payroll, DDs or HMRC on a weekend; cards land any day. */
  readonly shiftToWorkingDay: boolean;
}

export interface SupplierRule {
  readonly name: string;
  /** May contain `{ref}` — replaced by a stable 4-digit card reference. */
  readonly narrative: string;
  readonly method: PayMethod;
  readonly minPence: number;
  readonly maxPence: number;
  readonly timesPerMonthMin: number;
  readonly timesPerMonthMax: number;
  readonly weekendPossible: boolean;
  /** Whether trade volume moves this supplier's spend. */
  readonly seasonal: boolean;
}

export interface IncomeRule {
  readonly name: string;
  readonly narrative: string;
  readonly kind: IncomeKind;
  /** 0 = Sunday … 6 = Saturday. The days this receipt lands. */
  readonly daysOfWeek: number[];
  /** Seven integer PERCENTS, index 0 = Sunday. This is where "weekends are busy" lives. */
  readonly dayWeightsPercent: number[];
  readonly minPence: number;
  readonly maxPence: number;
  readonly seasonal: boolean;
}

export interface Textures {
  readonly returnedDirectDebitTemplate: string;
  readonly returnedItemFeeNarrative: string;
  readonly returnedItemFeePence: number;
  readonly refundTemplate: string;
  readonly bankChargeNarrative: string;
  readonly bankChargePence: number;
  readonly interestNarrative: string;
}

export interface Plan {
  readonly business: {
    readonly type: string;
    readonly justification: string;
    readonly name: string;
    readonly addressLines: string[];
    readonly vatNumber: string;
    readonly companyNumber: string;
  };
  readonly bank: {
    readonly name: string;
    readonly brandHex: string;
    readonly branch: string;
    readonly sortCode: string;
    readonly accountNumber: string;
    readonly accountType: string;
    readonly addressLines: string[];
    readonly registeredOffice: string;
    readonly fscsNote: string;
  };
  readonly openingBalancePence: number;
  readonly recurring: RecurringRule[];
  readonly suppliers: SupplierRule[];
  readonly income: IncomeRule[];
  /** Twelve integer percents, index 0 = January. A restaurant's year. */
  readonly seasonalityPercent: number[];
  readonly textures: Textures;
}

/* ── The prompt ───────────────────────────────────────────────────────────── */

const SYSTEM =
  'You design synthetic test fixtures for a UK bookkeeping product. You answer with one JSON object and ' +
  'nothing else — no prose, no markdown fence, no commentary. Every monetary value you emit is an INTEGER ' +
  'NUMBER OF PENCE. You never emit a float, a currency symbol, or a decimal point in a money field.';

function buildPrompt(fixupNote: string | null): string {
  return `Plan the transaction universe for a synthetic UK business bank statement. This is FICTIONAL test data.

## The business is FIXED — do not choose it

- Name: ${FIXED.name}
- Trade: ${FIXED.trade}
- VAT number: ${FIXED.vatNumber}
- Company number: ${FIXED.companyNumber}

**THE COHERENCE RULE, which is the whole point of the exercise:** every single transaction this plan can
generate must be plausible for a single-site burger restaurant. No plant hire, no wholesale timber, no
consultancy fees, no agricultural anything. If a line would look wrong on a restaurant's bank statement,
it does not belong in this plan.

Invent a plausible fictional trading address (a real-sounding UK high street, town and postcode), a
plausible UK high-street bank (Barclays, NatWest, Lloyds, HSBC or Starling), and a FICTIONAL sort code and
8-digit account number. Nothing may correspond to a real person or a real account.

## What must appear

**Recurring (\`recurring\`)** — rent (standing order), business rates to the council, gas, electricity, water,
trade waste collection, pest control, commercial insurance, EPOS/till subscription, card-terminal / merchant
service fees, music licence (PPL PRS), broadband/telephone, food hygiene / EHO-adjacent subscriptions, an
equipment finance or kitchen-fit-out loan repayment, HMRC VAT QUARTERLY, HMRC PAYE monthly, and a monthly
bank service charge. Also put PAYROLL here: 8–12 named kitchen and front-of-house staff (chefs, kitchen
porters, servers, a general manager) paid monthly or four-weekly, each as its own recurring rule with
\`category: "payroll"\`.

**Suppliers (\`suppliers\`)** — 14–22 named suppliers a burger restaurant actually uses: food wholesale
(include Bidfood), butchers/meat, bakery for buns, produce, drinks (include Coca-Cola Europacific), beer,
packaging and takeaway containers, cleaning and hygiene chemicals, catering equipment, uniforms, a
cash-and-carry, a coffee supplier, sundries from a DIY/hardware chain. These are the ones that appear
${FIXED.knownSuppliers.join(', ')} in the product's own records, so include them where they fit the trade.

**Income (\`income\`)** — the card settlement from a merchant acquirer (lands most days), the three delivery
platforms as separate WEEKLY net payouts (Deliveroo, Uber Eats, Just Eat — these are highly characteristic
of this trade), and a weekly cash banking. Weekends are the busy trading days, so \`dayWeightsPercent\` must
put the weight on Friday/Saturday/Sunday takings and their settlements, not on Tuesday.

**Seasonality (\`seasonalityPercent\`)** — twelve integer percents, index 0 = January, a restaurant's year:
December strong, January weak, a summer lift.

## UK bank narrative formats

Narratives must read exactly like a UK bank statement line — UPPERCASE, with the bank's own prefix:
\`CARD PAYMENT TO BOOKER 4412\`, \`BACS CREDIT DELIVEROO UK LTD\`, \`DD BRITISH GAS LITE\`,
\`FASTER PAYMENT TO A PATEL\`, \`SO RENT MERIDIAN PROP\`, \`CHARGE : SERVICE\`, \`BGC CASH BANKING\`.
Prefixes by method: card → \`CARD PAYMENT TO\`, directDebit → \`DD\`, fasterPayment → \`FASTER PAYMENT TO\`,
bacs → \`BACS\`, standingOrder → \`SO\`. A card narrative may end with \`{ref}\` as a literal placeholder.

## Output — this exact JSON shape, and nothing else

{
  "business": { "type": string, "justification": string (ONE line, why this trade's ledger looks the way it does),
                "name": "${FIXED.name}", "addressLines": [3 or 4 strings], "vatNumber": "${FIXED.vatNumber}",
                "companyNumber": "${FIXED.companyNumber}" },
  "bank": { "name": string, "brandHex": "#rrggbb", "branch": string, "sortCode": "nn-nn-nn",
            "accountNumber": "8 digits", "accountType": string, "addressLines": [2 or 3 strings],
            "registeredOffice": string, "fscsNote": string (one sentence, FSCS protection) },
  "openingBalancePence": integer (a plausible opening balance for this business, 1500000 to 6000000),
  "recurring": [ { "id": string, "category": "rent"|"payroll"|"utility"|"rates"|"insurance"|"subscription"|
                     "finance"|"waste"|"vat"|"paye"|"bankCharge"|"licence"|"other",
                   "narrative": string, "direction": "out"|"in",
                   "cadence": "monthly"|"quarterly"|"fourWeekly"|"weekly"|"annual",
                   "dayOfMonth": integer 1-28, "weekday": integer 1-5, "months": [integers 1-12, or []],
                   "minPence": integer, "maxPence": integer, "shiftToWorkingDay": boolean } ],
  "suppliers": [ { "name": string, "narrative": string,
                   "method": "card"|"directDebit"|"fasterPayment"|"bacs"|"standingOrder",
                   "minPence": integer, "maxPence": integer,
                   "timesPerMonthMin": integer 1-12, "timesPerMonthMax": integer 1-14,
                   "weekendPossible": boolean, "seasonal": boolean } ],
  "income": [ { "name": string, "narrative": string,
                "kind": "cardSettlement"|"deliveryPlatform"|"cashBanking"|"other",
                "daysOfWeek": [integers 0-6, 0=Sunday], "dayWeightsPercent": [exactly 7 integers, 0=Sunday],
                "minPence": integer, "maxPence": integer, "seasonal": boolean } ],
  "seasonalityPercent": [exactly 12 integers, index 0 = January, each 60-160],
  "textures": { "returnedDirectDebitTemplate": string containing "{supplier}",
                "returnedItemFeeNarrative": string, "returnedItemFeePence": integer,
                "refundTemplate": string containing "{supplier}",
                "bankChargeNarrative": string, "bankChargePence": integer,
                "interestNarrative": string }
}

Constraints: \`dayOfMonth\` never exceeds 28. \`minPence\` <= \`maxPence\` everywhere. \`timesPerMonthMin\` <=
\`timesPerMonthMax\`. Every money field is an integer count of pence (£1,284.50 is 128450). "quarterly" and
"annual" rules must list their \`months\`. Scale the amounts so this restaurant's monthly takings plausibly
exceed its monthly outgoings — it is a going concern, not a failing one.${fixupNote === null ? '' : `

## Your previous answer was rejected. Fix exactly this and return the whole object again:

${fixupNote}`}

Return the JSON object only.`;
}

/* ── The boundary ─────────────────────────────────────────────────────────── */

class PlanError extends Error {}

function fail(path: string, why: string): never {
  throw new PlanError(`${path}: ${why}`);
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'expected an object');
  return value as Record<string, unknown>;
}

function str(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') fail(`${path}.${key}`, 'expected a non-empty string');
  return value;
}

function int(source: Record<string, unknown>, key: string, path: string, min: number, max: number): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(`${path}.${key}`, `expected an INTEGER (got ${JSON.stringify(value)}) — money is integer pence, never a decimal`);
  }
  if (value < min || value > max) fail(`${path}.${key}`, `expected an integer between ${min} and ${max}, got ${value}`);
  return value;
}

function bool(source: Record<string, unknown>, key: string, path: string): boolean {
  const value = source[key];
  if (typeof value !== 'boolean') fail(`${path}.${key}`, 'expected a boolean');
  return value;
}

function oneOf<T extends string>(source: Record<string, unknown>, key: string, path: string, allowed: readonly T[]): T {
  const value = source[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${path}.${key}`, `expected one of ${allowed.join(' | ')}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

function arr(source: Record<string, unknown>, key: string, path: string, min: number, max: number): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) fail(`${path}.${key}`, 'expected an array');
  if (value.length < min || value.length > max) {
    fail(`${path}.${key}`, `expected between ${min} and ${max} entries, got ${value.length}`);
  }
  return value;
}

function intArray(source: Record<string, unknown>, key: string, path: string, len: [number, number], range: [number, number]): number[] {
  const raw = arr(source, key, path, len[0], len[1]);
  return raw.map((entry, i) => {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) fail(`${path}.${key}[${i}]`, 'expected an integer');
    if (entry < range[0] || entry > range[1]) fail(`${path}.${key}[${i}]`, `expected ${range[0]}–${range[1]}, got ${entry}`);
    return entry;
  });
}

function stringArray(source: Record<string, unknown>, key: string, path: string, min: number, max: number): string[] {
  return arr(source, key, path, min, max).map((entry, i) => {
    if (typeof entry !== 'string' || entry.trim() === '') fail(`${path}.${key}[${i}]`, 'expected a non-empty string');
    return entry;
  });
}

function range(source: Record<string, unknown>, path: string, minKey: string, maxKey: string, lo: number, hi: number): [number, number] {
  const min = int(source, minKey, path, lo, hi);
  const max = int(source, maxKey, path, lo, hi);
  if (min > max) fail(path, `${minKey} (${min}) must not exceed ${maxKey} (${max})`);
  return [min, max];
}

export function validatePlan(raw: unknown): Plan {
  const root = obj(raw, 'plan');

  const businessRaw = obj(root['business'], 'plan.business');
  const business = {
    type: str(businessRaw, 'type', 'plan.business'),
    justification: str(businessRaw, 'justification', 'plan.business'),
    name: str(businessRaw, 'name', 'plan.business'),
    addressLines: stringArray(businessRaw, 'addressLines', 'plan.business', 2, 5),
    vatNumber: str(businessRaw, 'vatNumber', 'plan.business'),
    companyNumber: str(businessRaw, 'companyNumber', 'plan.business'),
  };
  if (business.name !== FIXED.name) fail('plan.business.name', `must be exactly "${FIXED.name}" — the business is fixed, not chosen`);

  const bankRaw = obj(root['bank'], 'plan.bank');
  const bank = {
    name: str(bankRaw, 'name', 'plan.bank'),
    brandHex: str(bankRaw, 'brandHex', 'plan.bank'),
    branch: str(bankRaw, 'branch', 'plan.bank'),
    sortCode: str(bankRaw, 'sortCode', 'plan.bank'),
    accountNumber: str(bankRaw, 'accountNumber', 'plan.bank'),
    accountType: str(bankRaw, 'accountType', 'plan.bank'),
    addressLines: stringArray(bankRaw, 'addressLines', 'plan.bank', 2, 4),
    registeredOffice: str(bankRaw, 'registeredOffice', 'plan.bank'),
    fscsNote: str(bankRaw, 'fscsNote', 'plan.bank'),
  };
  if (!/^#[0-9a-fA-F]{6}$/.test(bank.brandHex)) fail('plan.bank.brandHex', `expected #rrggbb, got ${bank.brandHex}`);
  if (!/^\d{2}-\d{2}-\d{2}$/.test(bank.sortCode)) fail('plan.bank.sortCode', `expected nn-nn-nn, got ${bank.sortCode}`);
  if (!/^\d{8}$/.test(bank.accountNumber)) fail('plan.bank.accountNumber', `expected 8 digits, got ${bank.accountNumber}`);

  const recurring = arr(root, 'recurring', 'plan', 15, 60).map((entry, i): RecurringRule => {
    const path = `plan.recurring[${i}]`;
    const r = obj(entry, path);
    const [minPence, maxPence] = range(r, path, 'minPence', 'maxPence', 1, 100_000_00);
    const cadence = oneOf(r, 'cadence', path, ['monthly', 'quarterly', 'fourWeekly', 'weekly', 'annual'] as const);
    const months = intArray(r, 'months', path, [0, 12], [1, 12]);
    if ((cadence === 'quarterly' || cadence === 'annual') && months.length === 0) {
      fail(`${path}.months`, `a ${cadence} rule must say which months it falls in`);
    }
    return {
      id: str(r, 'id', path),
      category: str(r, 'category', path),
      narrative: str(r, 'narrative', path),
      direction: oneOf(r, 'direction', path, ['out', 'in'] as const),
      cadence,
      dayOfMonth: int(r, 'dayOfMonth', path, 1, 28),
      weekday: int(r, 'weekday', path, 1, 5),
      months,
      minPence,
      maxPence,
      shiftToWorkingDay: bool(r, 'shiftToWorkingDay', path),
    };
  });

  const suppliers = arr(root, 'suppliers', 'plan', 10, 30).map((entry, i): SupplierRule => {
    const path = `plan.suppliers[${i}]`;
    const s = obj(entry, path);
    const [minPence, maxPence] = range(s, path, 'minPence', 'maxPence', 1, 100_000_00);
    const [timesPerMonthMin, timesPerMonthMax] = range(s, path, 'timesPerMonthMin', 'timesPerMonthMax', 0, 14);
    return {
      name: str(s, 'name', path),
      narrative: str(s, 'narrative', path),
      method: oneOf(s, 'method', path, ['card', 'directDebit', 'fasterPayment', 'bacs', 'standingOrder'] as const),
      minPence,
      maxPence,
      timesPerMonthMin,
      timesPerMonthMax,
      weekendPossible: bool(s, 'weekendPossible', path),
      seasonal: bool(s, 'seasonal', path),
    };
  });

  const income = arr(root, 'income', 'plan', 4, 12).map((entry, i): IncomeRule => {
    const path = `plan.income[${i}]`;
    const n = obj(entry, path);
    const [minPence, maxPence] = range(n, path, 'minPence', 'maxPence', 1, 500_000_00);
    return {
      name: str(n, 'name', path),
      narrative: str(n, 'narrative', path),
      kind: oneOf(n, 'kind', path, ['cardSettlement', 'deliveryPlatform', 'cashBanking', 'other'] as const),
      daysOfWeek: intArray(n, 'daysOfWeek', path, [1, 7], [0, 6]),
      dayWeightsPercent: intArray(n, 'dayWeightsPercent', path, [7, 7], [0, 400]),
      minPence,
      maxPence,
      seasonal: bool(n, 'seasonal', path),
    };
  });

  const seasonalityPercent = intArray(root, 'seasonalityPercent', 'plan', [12, 12], [40, 200]);

  const texturesRaw = obj(root['textures'], 'plan.textures');
  const textures: Textures = {
    returnedDirectDebitTemplate: str(texturesRaw, 'returnedDirectDebitTemplate', 'plan.textures'),
    returnedItemFeeNarrative: str(texturesRaw, 'returnedItemFeeNarrative', 'plan.textures'),
    returnedItemFeePence: int(texturesRaw, 'returnedItemFeePence', 'plan.textures', 1, 10_000),
    refundTemplate: str(texturesRaw, 'refundTemplate', 'plan.textures'),
    bankChargeNarrative: str(texturesRaw, 'bankChargeNarrative', 'plan.textures'),
    bankChargePence: int(texturesRaw, 'bankChargePence', 'plan.textures', 1, 50_000),
    interestNarrative: str(texturesRaw, 'interestNarrative', 'plan.textures'),
  };
  for (const [key, value] of [
    ['returnedDirectDebitTemplate', textures.returnedDirectDebitTemplate],
    ['refundTemplate', textures.refundTemplate],
  ] as const) {
    if (!value.includes('{supplier}')) fail(`plan.textures.${key}`, 'must contain the literal placeholder {supplier}');
  }

  if (!income.some((rule) => rule.kind === 'cardSettlement')) fail('plan.income', 'no cardSettlement rule — a restaurant banks its card takings');
  if (income.filter((rule) => rule.kind === 'deliveryPlatform').length < 2) {
    fail('plan.income', 'expected at least two deliveryPlatform payouts (Deliveroo / Uber Eats / Just Eat)');
  }
  for (const needed of ['payroll', 'vat', 'paye', 'rent'] as const) {
    if (!recurring.some((rule) => rule.category === needed)) fail('plan.recurring', `no rule with category "${needed}"`);
  }

  return {
    business,
    bank,
    openingBalancePence: int(root, 'openingBalancePence', 'plan', 100_000, 20_000_000),
    recurring,
    suppliers,
    income,
    seasonalityPercent,
    textures,
  };
}

/**
 * Ask Fable for the plan. ONE retry, with the exact rejection fed back — and no
 * hand-written fallback, because a plan this file invented and labelled as the
 * model's would make `out/plan.json` a lie.
 */
export async function requestPlan(): Promise<{ plan: Plan; attempts: number; raw: string }> {
  let note: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const raw = await askFoundry({ model: FABLE, system: SYSTEM, prompt: buildPrompt(note), maxTokens: 16_000 });
    try {
      return { plan: validatePlan(extractJson(raw)), attempts: attempt, raw };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (attempt === 2) throw new Error(`Fable's plan was rejected twice. Last complaint: ${detail}`);
      process.stderr.write(`  plan rejected (attempt ${attempt}): ${detail}\n  retrying once with the complaint fed back…\n`);
      note = detail;
    }
  }
  throw new Error('unreachable');
}
