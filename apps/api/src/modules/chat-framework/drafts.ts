import type { ScopedClient } from '../../common/db/scoped-db.js';
import type { CategoryOption } from './grounding.js';
import type { ModelTurn } from './prompts/output-schema.js';

/**
 * Turning a validated model turn into a proposal the caller can send.
 *
 * Only `rule.create` is drafted here, and the omissions are deliberate rather
 * than unfinished:
 *
 * - **`chase.send`** requires every SMS byte-for-byte *including the signed
 *   portal link*, and the contract is explicit that "composition is server-side;
 *   this payload is its output, never free-typed by a caller". The composer
 *   lives in the chase module and the signing secret is not this module's to
 *   hold. So chat returns the INTENT and the existing composer card builds the
 *   payload, exactly as it does today. Moving composition to proposal time is
 *   the known seam that also fixes the dead SMS link — it is a separate change,
 *   not a thing to half-do here.
 * - **`publish.batch`** requires a server-computed preview (count, gross, VAT)
 *   that Read review renders. The publishing module computes it. A preview
 *   assembled by a chat model would be a number a human approves without it
 *   ever having been derived from the ledger — which is the specific failure
 *   §9.4 forbids.
 *
 * What both share: the model names the *intent*, real code assembles the
 * *numbers*. That division is the whole safety property, and it is why this
 * file is short.
 */

export interface RuleDraftResult {
  readonly ok: true;
  readonly draft: {
    readonly kind: 'rule.create';
    readonly businessId: string;
    readonly payload: {
      readonly tier: 'SUPPLIER_CUSTOMER';
      readonly scopeKey: string;
      readonly sets: { categoryCode: string; vatTreatment?: string };
    };
  };
  readonly categoryName: string;
}

export interface RuleDraftRejection {
  readonly ok: false;
  /** Shown to the accountant. Names what is wrong and what would fix it. */
  readonly reason: string;
}

/**
 * Build a `rule.create` proposal request from a model turn.
 *
 * Two checks the model does not get to skip:
 *
 * 1. **The category must be on the client's own synced list.** A code that is
 *    not is refused outright — not corrected, not fuzzy-matched. Fuzzy-matching
 *    a chart of accounts is how a client's food costs quietly become drink
 *    costs, and the accountant approving it has no way to see that happened.
 * 2. **The supplier is re-cased from the client's real documents.** The
 *    single-tier match compares `scopeKey` against `extraction.supplierName`
 *    exactly, so "bidfood" typed in chat must become "Bidfood" as it appears on
 *    the invoices — otherwise the rule is created, looks right on screen, and
 *    silently never fires.
 */
export async function buildRuleDraft(
  db: ScopedClient,
  businessId: string,
  turn: ModelTurn,
  categories: readonly CategoryOption[],
): Promise<RuleDraftResult | RuleDraftRejection> {
  const rule = turn.rule;
  if (rule === undefined) {
    return { ok: false, reason: 'That did not name both a supplier and a category, so there is no rule to make yet.' };
  }

  if (categories.length === 0) {
    return {
      ok: false,
      reason: 'This client has no synced chart of accounts yet, so a coding rule has nothing to code against.',
    };
  }

  const category = categories.find((option) => option.code === rule.categoryCode);
  if (category === undefined) {
    const known = categories.map((option) => option.name).join(', ');
    return {
      ok: false,
      reason: `I could not match that category on this client's chart of accounts. The available ones are: ${known}.`,
    };
  }

  const scopeKey = await resolveSupplierCasing(db, businessId, rule.supplier);

  return {
    ok: true,
    categoryName: category.name,
    draft: {
      kind: 'rule.create',
      businessId,
      payload: {
        tier: 'SUPPLIER_CUSTOMER',
        scopeKey,
        sets: {
          categoryCode: category.code,
          ...(rule.vatTreatment === undefined ? {} : { vatTreatment: rule.vatTreatment }),
        },
      },
    },
  };
}

/**
 * The supplier name as this client's documents actually spell it.
 *
 * Falls back to title case when no document names that supplier yet — which is
 * a legitimate case (teaching a rule ahead of the first invoice) and the reason
 * this returns a value rather than refusing.
 */
async function resolveSupplierCasing(db: ScopedClient, businessId: string, spoken: string): Promise<string> {
  const match = await db.document.findFirst({
    where: { businessId, supplierName: { equals: spoken, mode: 'insensitive' } },
    select: { supplierName: true },
    orderBy: { receivedAt: 'desc' },
  });

  return match?.supplierName ?? titleCase(spoken);
}

function titleCase(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((word) => (word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}
