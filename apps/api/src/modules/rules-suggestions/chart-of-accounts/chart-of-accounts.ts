import type { BusinessTypeProfile } from '../../clients-team-settings/index.js';
import { normaliseSupplierKey } from '../supplier-key.js';
import { analysisAccount, type ChartAccount } from './account.js';
import {
  accountsMatchingCost,
  BUSINESS_PROFILES,
  type BusinessProfileId,
  coreAccounts,
  PROFILE_SELECTION_ORDER,
} from './profiles.js';

/**
 * **The chart of accounts, derived from the business-type profile** — a pure
 * function, and the whole of A6's first half (SoT §24.4.1).
 *
 * Pure on purpose. Every input is a value, the output is a value, and the same
 * profile produces byte-identical accounts on every call — which matters
 * because these strings end up in an accountant's VT import file, where VT's
 * Converter saves its mapping against the exact string it was given (§24.3.1).
 * A chart that drifted between two seeds of the same client would quietly make
 * every future import manual.
 *
 * ## The null profile, and why it is not silently papered over
 *
 * `readBusinessProfile` returns `null` for two different facts that a caller
 * must treat identically: nothing was captured at intake, or what is stored is
 * not a profile this release understands. **Every client seeded by
 * `prisma/seed.ts` reads as `null` today** — the seed writes a legacy shape
 * (`sells`, `revenueStreams`, `companyCards`, `expectedUnusual`) with no
 * `businessActivity` at all, and A11 deliberately refused to map `sells` onto
 * it because that would hand the coding engine a sentence no accountant wrote.
 * Fixing the seed is a `prisma/` change (LAW, G7).
 *
 * So this function answers `null` with the **general chart** and a `basis` of
 * `NO_PROFILE` plus a `caveat` that says so in one sentence a surface can
 * render. That is not a default dressed up as an answer:
 *
 * - a chart of accounts is a **picklist**, not a coding decision. Offering an
 *   accountant a generic UK chart costs nothing and is what every package does;
 * - **nothing in this module ever codes a document from the chart alone**
 *   (`supplier-coding.service.ts` — the `CLIENT_CONTEXT` rung never wins), so a
 *   generic chart cannot become a wrong code applied silently;
 * - and refusing to produce one would leave the accountant unable to code by
 *   hand either, which is the acceptable product A6's brief protects.
 */

export type ChartBasis =
  /** The described activity matched a specialist profile. */
  | 'PROFILE_MATCHED'
  /** A profile exists, but nothing in it matched a specialist — the general chart. */
  | 'PROFILE_UNMATCHED'
  /** No profile at all. The general chart, and the surface must say so. */
  | 'NO_PROFILE';

export interface ChartOfAccounts {
  readonly profileId: BusinessProfileId;
  readonly basis: ChartBasis;
  readonly accounts: readonly ChartAccount[];
  /**
   * Things the client listed under `typicalCosts` that no account matched.
   *
   * Reported, **never turned into accounts.** These are words a client typed
   * into a form; the `Analysis account` column of somebody's import file is not
   * where they belong. Surfacing them lets the accountant see what the client
   * said that the chart does not cover, which is the useful half.
   */
  readonly unmatchedCosts: readonly string[];
  /**
   * The suppliers the client named at intake, normalised for comparison.
   *
   * §24.4.1: *a new supplier is stated as such in the context and is
   * always-review.* This list is how "new" is decided for a client with no
   * document history yet.
   */
  readonly knownSuppliers: readonly string[];
  /** One honest sentence about where this chart came from. Meant to be rendered. */
  readonly caveat: string;
}

/** The `{ code, name }` pairs the rest of the product reads — `name` is the emittable form. */
export interface ChartCategory {
  readonly code: string;
  /**
   * ⚠ **Ledger-prefixed** — `Cost of sales: Purchases`, the exact string A7's
   * VT emitter puts in `Analysis account`.
   *
   * One string with one meaning everywhere is the point. `chat-framework`
   * renders this to the accountant when it lists the codes a rule may use, and
   * the export writes the same characters into the file; if the two ever
   * disagreed, an accountant would approve a rule naming one account and get
   * another one in their books.
   */
  readonly name: string;
}

const CAVEATS: Readonly<Record<ChartBasis, (label: string) => string>> = {
  PROFILE_MATCHED: (label) =>
    `Seeded from the business-type profile captured at intake (${label}). There is no mandated UK chart of accounts, so this is a starting point, not a claim of correctness — it is the accountant's to edit from here.`,
  PROFILE_UNMATCHED: () =>
    'A business-type profile was captured, but the described activity matched none of the seeded business types, so this is the general chart. Worth a look before coding starts.',
  NO_PROFILE: () =>
    'This client has no business-type profile, so this is a generic UK small-business chart rather than one built for them. Nothing is coded automatically from it.',
};

/**
 * Profile → chart. The only place a chart is built.
 *
 * @param profile What `readBusinessProfile` returned. `null` is a supported
 *   input with a documented answer, not an error.
 */
export function chartOfAccountsFor(profile: BusinessTypeProfile | null): ChartOfAccounts {
  const profileId = selectProfile(profile);
  const basis: ChartBasis =
    profile === null ? 'NO_PROFILE' : profileId === 'GENERAL_BUSINESS' ? 'PROFILE_UNMATCHED' : 'PROFILE_MATCHED';

  const definition = BUSINESS_PROFILES[profileId];
  const byCode = new Map<string, ChartAccount>();
  for (const account of coreAccounts()) byCode.set(account.code, account);
  for (const account of definition.additions) byCode.set(account.code, account);

  // `typicalCosts` widens the picklist — it never narrows it. Excluding an
  // account because the client did not think to mention it would leave the
  // accountant unable to code a real invoice that arrives anyway.
  const unmatchedCosts: string[] = [];
  for (const cost of profile?.typicalCosts ?? []) {
    const matched = accountsMatchingCost(cost);
    if (matched.length === 0) {
      unmatchedCosts.push(cost);
      continue;
    }
    for (const account of matched) if (!byCode.has(account.code)) byCode.set(account.code, account);
  }

  return {
    profileId,
    basis,
    accounts: [...byCode.values()],
    unmatchedCosts,
    // Normalised with the SAME function the coding ladder uses to look a
    // supplier up. Two normalisations would make "is this supplier new?"
    // answerable two ways, and the disagreement would only show up as a
    // document that failed to be flagged.
    knownSuppliers: (profile?.typicalSuppliers ?? []).map(normaliseSupplierKey).filter((key) => key !== ''),
    caveat: CAVEATS[basis](definition.label),
  };
}

/**
 * Which specialist profile the described activity is, or `GENERAL_BUSINESS`.
 *
 * ⚠ **`businessActivity` and `typicalCosts` are untrusted content** — free text
 * an accountant or a client typed. They are used here for **one** purpose:
 * choosing between four objects this repository authored. They are never
 * concatenated into an account name, never stored as a category, and never
 * reach a model through this path (`profileForModel` on A11's seam is the only
 * sanctioned way to put them in front of one, and it wraps them). Classifying a
 * string is not obeying it.
 */
function selectProfile(profile: BusinessTypeProfile | null): BusinessProfileId {
  if (profile === null) return 'GENERAL_BUSINESS';

  // Padded so a keyword ending in a space ("bar ") still matches at the end of
  // the string — "wine bar" is a bar.
  const haystack = ` ${[profile.businessActivity, ...(profile.typicalCosts ?? [])].join(' ').toLowerCase()} `;

  let best: { id: BusinessProfileId; hits: number } | null = null;
  // A FIXED order, not `Object.keys`: a tie must resolve the same way on every
  // run, or two seeds of one client could produce two different charts.
  for (const id of PROFILE_SELECTION_ORDER) {
    const hits = BUSINESS_PROFILES[id].matches.filter((keyword) => haystack.includes(keyword)).length;
    if (hits > 0 && (best === null || hits > best.hits)) best = { id, hits };
  }
  return best?.id ?? 'GENERAL_BUSINESS';
}

/** The `{ code, name }` projection, ledger-prefixed. */
export function toCategories(chart: ChartOfAccounts): readonly ChartCategory[] {
  return chart.accounts.map((account) => ({ code: account.code, name: analysisAccount(account) }));
}
