import type { ScopedClient } from '../db/scoped-db.js';

/**
 * `memberships.hide_financial_fields`, finally applied (rush/admin; SoT §3.3:
 * "non-finance submitters see their submission, not the coding").
 *
 * One rule, three consumers: the response interceptor (documents, extractions,
 * duplicates, proposals, bank matches), the refusal of whole financial
 * surfaces, and chat grounding.
 */

/** Does this actor hold any membership flagged non-finance? Read inside the caller's `scopedDb`. */
export async function actorHidesFinancials(db: ScopedClient, userId: string): Promise<boolean> {
  // `memberships` carries no RLS; the userId comes from the verified session.
  // Every membership of a scoped colleague carries the same flag (acceptance
  // and edits write them together), so "any" is the acting membership's answer.
  const flagged = await db.membership.findFirst({ where: { userId, hideFinancialFields: true }, select: { id: true } });
  return flagged !== null;
}

/** Whole surfaces a non-finance member is refused: every row on them IS a figure. */
export const FINANCIAL_ONLY_PREFIXES: readonly string[] = ['/v1/bank-transactions', '/v1/statements', '/v1/exports'];

/** Coding keys nulled wherever they appear. Every `*Pence` key is nulled too. */
const CODING_KEYS = new Set(['categoryCode', 'categoryLabel', 'taxCode', 'vatRate', 'vatTreatment', 'nominalCode', 'accountCode', 'codingSuggestion']);

/** A currency amount inside free text — `£1,299.00`, `GBP 12.50`, `-£5`. */
const MONEY_IN_TEXT = /(?:[£$€]|\b(?:GBP|USD|EUR)\s?)-?\d[\d,]*(?:\.\d+)?/g;
export const MASK = '•••';

function isFinancialKey(key: string): boolean {
  return key.endsWith('Pence') || CODING_KEYS.has(key);
}

/**
 * Deep copy with every amount and coding value removed. Keys keep their
 * place (nulled, never deleted) so the contract's nullable fields still parse;
 * an `ExtractedField`-shaped value keeps its provenance and loses its `value`.
 * Money written into prose (review cards, failure notes, chat answers) is
 * masked. Pure — tested in `financial-visibility.test.ts`.
 */
export function redactFinancial(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(MONEY_IN_TEXT, MASK);
  if (Array.isArray(value)) return value.map(redactFinancial);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'lineItems') out[key] = Array.isArray(child) ? [] : null;
    else if (isFinancialKey(key)) {
      out[key] =
        child !== null && typeof child === 'object' && !Array.isArray(child) && 'value' in child
          ? { ...(child as Record<string, unknown>), value: null }
          : null;
    } else out[key] = redactFinancial(child);
  }
  return out;
}
