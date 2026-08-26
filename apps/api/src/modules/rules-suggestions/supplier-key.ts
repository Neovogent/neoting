/**
 * Supplier-name normalisation — one function, used by the chart's known-supplier
 * list and by the coding ladder's history lookup.
 *
 * It exists because the same supplier arrives spelled four ways across a year of
 * documents — `NISBETS LTD`, `Nisbets Ltd.`, `Nisbets`, `nisbets limited` — and
 * a history lookup that treated those as four suppliers would never learn
 * anything. Grouping them is the whole point of §24.4.6's *consistency beats
 * theoretical correctness*: where this client has coded this supplier before,
 * that prior treatment is a strong input.
 *
 * ## ⚠ What this is NOT used for
 *
 * **A rule's `scopeKey` is never normalised.** `extraction-pipeline.ts` matches
 * an active `SUPPLIER_CUSTOMER` rule by EXACT equality between `scopeKey` and
 * the extracted `supplierName`:
 *
 * ```ts
 * db.rule.findFirst({ where: { businessId, isActive: true, tier: 'SUPPLIER_CUSTOMER',
 *                              scopeKey: extracted.supplierName } })
 * ```
 *
 * So a rule created with a normalised key (`nisbets`) is a rule that is written,
 * looks right on the review card, and then **silently never fires** — which is
 * the worst of the three possible outcomes. `rule-proposal.ts` therefore takes
 * the scope key verbatim from a document this client actually received, and
 * says so at the point it does it.
 *
 * Normalisation is for *finding* history and for *comparing* names. Matching a
 * rule is the pipeline's exact comparison, and this module does not get to have
 * an opinion about it.
 */

/**
 * Company-form suffixes stripped before comparison.
 *
 * Only trailing tokens are removed, and only whole ones: `ltd` is stripped from
 * `Nisbets Ltd` and left alone inside `Ltdvale Supplies`. `co` is here because
 * `& Co` is a real UK suffix; `uk` because `Acme UK` and `Acme` are one supplier
 * to an accountant and two to a string comparison.
 */
const COMPANY_SUFFIXES = new Set([
  'ltd',
  'limited',
  'plc',
  'llp',
  'lp',
  'cic',
  'cio',
  'cyf',
  'co',
  'company',
  'holdings',
  'group',
  'uk',
  'gb',
  'inc',
  'incorporated',
  'gmbh',
  'sa',
  'bv',
]);

/**
 * The comparison key for a supplier name, or `''` when the name carries no
 * comparable content at all.
 *
 * Deterministic and locale-free: `toLowerCase()` without a locale argument,
 * ASCII-only class stripping, no `Intl` collation. A normalisation that depended
 * on the server's locale would group suppliers differently in two regions.
 */
export function normaliseSupplierKey(name: string | null | undefined): string {
  if (name === null || name === undefined) return '';

  const tokens = name
    .toLowerCase()
    // `&` becomes `and` BEFORE punctuation is stripped, so `Smith & Sons` and
    // `Smith and Sons` land on the same key rather than on `smith sons`.
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token !== '');

  // Trailing suffixes only, and never all of them: a supplier genuinely called
  // "Group" keeps its name rather than normalising to nothing.
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (last === undefined || !COMPANY_SUFFIXES.has(last)) break;
    tokens.pop();
  }

  return tokens.join(' ');
}

/** Do two spellings name the same supplier? */
export function sameSupplier(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normaliseSupplierKey(a);
  return left !== '' && left === normaliseSupplierKey(b);
}
