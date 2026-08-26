import { z } from 'zod';

/**
 * One account on a client's chart, and the **exact string A7's VT emitter
 * writes into `Analysis account`** (SoT §24.3.1, §24.4.1).
 *
 * ## Why an account is a ledger and a name, and never one string
 *
 * VT Transaction+'s Universal Input Sheet wants two different renderings of the
 * same account in two different columns:
 *
 * | Column | Form | Example |
 * |---|---|---|
 * | `Primary account` | the account **name only**, no prefix | `Nisbets Ltd` |
 * | `Analysis account` | the name **with its ledger prefix** | `Cost of sales: Purchases` |
 *
 * Storing `"Cost of sales: Purchases"` as one opaque string would make the
 * unprefixed form a `split(': ')` at the emitter — and a name that happens to
 * contain a colon would then silently lose half of itself inside somebody's
 * accounting software. So the two parts are two fields, {@link analysisAccount}
 * is the only place they are joined, and {@link ChartAccountSchema} refuses a
 * colon in either part so the join is reversible.
 *
 * ## Why the chart carries VAT and tax flags at all
 *
 * SoT §24.4.6 is explicit, and it is the reason this file is not just
 * `{ code, name }`: *a UK small-business chart of accounts is organised not by
 * what kind of thing is this but by what the number has to do next.* The
 * disallowables, the capital items and the VAT-atypical items each need their
 * own code, because those are the only distinctions anyone outside the business
 * enforces. Cosmetic errors (telephone posted to electricity) cost nothing
 * statutory; a capital item expensed, a disallowable buried in an ordinary
 * overhead, or a wrong VAT rate each cost real money.
 *
 * These flags **gate nothing**. They are review ordering and reviewer context —
 * a reason a card says "this one matters" — and they are never a licence to
 * code something automatically.
 */

/**
 * The ledgers this release seeds into. Deliberately the four an income-and-
 * expenditure chart needs: ID codes purchase documents and sales documents, so
 * a balance-sheet ledger beyond `Fixed assets` (which exists because §24.4.6's
 * tier-1 error is capital-versus-revenue) would be a picklist entry no ID
 * document can legitimately land on.
 *
 * ⚠ These strings travel **into an accountant's VT import file**. VT's
 * Converter saves the mapping against the exact string it was given, so
 * renaming one silently makes every future import manual for every client
 * already using it (§24.3.1). Treat this array as data with a migration cost.
 */
export const LEDGERS = ['Sales', 'Cost of sales', 'Expenses', 'Fixed assets'] as const;

export type Ledger = (typeof LEDGERS)[number];

/**
 * What the VAT on this account normally looks like — §24.4.6 tier 3, the tier
 * that lands directly on a VAT return and therefore directly on a liability.
 *
 * `VARIES` is a first-class answer and not a cop-out: for construction
 * subcontractors, food, and card-and-platform fees the correct rate is on the
 * invoice and depends on facts no chart can hold. Naming that is honest;
 * defaulting it to `STANDARD` would be a guess wearing a fact's clothes.
 */
export const VAT_TREATMENTS = ['STANDARD', 'ZERO_OR_EXEMPT', 'OUTSIDE_SCOPE', 'BLOCKED', 'VARIES'] as const;

export type VatTreatment = (typeof VAT_TREATMENTS)[number];

/**
 * What the number has to do next in the tax computation — §24.4.6 tiers 1 and 2.
 *
 * - `ALLOWABLE` — an ordinary deduction.
 * - `DISALLOWABLE` — **must be separately identifiable for the corporation-tax
 *   add-back.** It does not mean "not a real cost": charitable donations are
 *   relieved, just not as a trading deduction, and they still need their own
 *   code so the computation can find them.
 * - `CAPITAL` — a fixed asset, not an expense. The repairs-versus-improvements
 *   judgement, which §24.4.6 calls out as genuinely hard.
 */
export const TAX_CONSEQUENCES = ['ALLOWABLE', 'DISALLOWABLE', 'CAPITAL'] as const;

export type TaxConsequence = (typeof TAX_CONSEQUENCES)[number];

/**
 * A colon is what separates ledger from account in the emitted form, so neither
 * half may contain one. A leading or trailing space is refused for the same
 * reason `Primary account` is passed through byte-for-byte: an invisible
 * character changes VT's Converter key.
 */
const NAME_PART = z
  .string()
  .min(1)
  .refine((value) => !value.includes(':'), 'A ledger or account name may not contain a colon — it is the separator.')
  .refine((value) => value.trim() === value, 'A ledger or account name may not have leading or trailing space.');

export const ChartAccountSchema = z.object({
  /**
   * What lands in `documents.category_code`.
   *
   * ⚠ `category_code` is **free text in `prisma/schema.prisma`** — no enum, no
   * foreign key — and it stays that way this release (`prisma/` is LAW, G7).
   * These codes are therefore a convention this module owns and nothing in the
   * database enforces, which is exactly why {@link resolveAccount} returns
   * `null` for an unknown one rather than throwing: a code that is not on the
   * chart is a real thing that can be in the column.
   *
   * The convention is `SCREAMING_SNAKE`, matching the values already in the
   * repository (`OFFICE_EQUIPMENT`, `COST_OF_SALES_FOOD`, `GENERAL_EXPENSES`).
   */
  code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Account codes are SCREAMING_SNAKE, matching the values already in the column.'),
  ledger: z.enum(LEDGERS),
  name: NAME_PART,
  vatTreatment: z.enum(VAT_TREATMENTS),
  taxConsequence: z.enum(TAX_CONSEQUENCES),
  /**
   * Lower-case fragments matched against what the client typed in
   * `typicalCosts` at intake.
   *
   * ⚠ **This is the only thing client free text is ever used for here.** A
   * keyword match *selects* an account we authored; it never *creates* one. The
   * account name is what ends up in the `Analysis account` column of an
   * accountant's import file, and a string a client typed has no business
   * being there — the words are theirs, the chart is ours.
   */
  keywords: z.array(z.string()).readonly(),
  /**
   * Why this account is worth a second look, when it is — §24.4.6's hierarchy
   * rendered as one sentence a reviewer can read. Absent on the accounts where
   * a mistake is cosmetic.
   */
  reviewNote: z.string().optional(),
});

export type ChartAccount = z.infer<typeof ChartAccountSchema>;

/**
 * **The A7 contract.** `Analysis account` in the Universal Input Sheet must
 * carry the ledger prefix — literally `Cost of sales: Purchases` — and this is
 * the one function that produces it.
 *
 * `exports-public-api`'s VT emitter raises `analysis-account-unprefixed` for a
 * bare name, because VT may not match it to a nominal without the prefix. Every
 * account on every chart this module seeds is emittable in that exact form, and
 * `account.test.ts` asserts it over the whole catalogue rather than over an
 * example.
 */
export function analysisAccount(account: Pick<ChartAccount, 'ledger' | 'name'>): string {
  return `${account.ledger}: ${account.name}`;
}

/** The inverse, for reading a stored `Analysis account` back apart. Null when it carries no prefix. */
export function splitAnalysisAccount(value: string): { ledger: string; name: string } | null {
  const at = value.indexOf(': ');
  if (at <= 0) return null;
  return { ledger: value.slice(0, at), name: value.slice(at + 2) };
}

/** The account a `documents.category_code` names, or `null` when the column holds something off-chart. */
export function resolveAccount(accounts: readonly ChartAccount[], categoryCode: string | null): ChartAccount | null {
  if (categoryCode === null) return null;
  return accounts.find((account) => account.code === categoryCode) ?? null;
}
