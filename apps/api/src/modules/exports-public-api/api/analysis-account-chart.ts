/**
 * The client's chart of accounts, as an export needs it — and the one thing
 * that stands between `documents.category_code` and the VT `Analysis account`
 * column.
 *
 * ## What was wrong, and why this file exists
 *
 * `document-to-canonical.ts` used to pass `category_code` **straight through**,
 * so an accountant's import file carried a bare `SUBSCRIPTIONS` where VT
 * Transaction+ wants `Cost of sales: Purchases`. VT type-guesses each cell, so a
 * bare numeric code renders as a *number* rather than an account (§24.3.1), and
 * even a lettered one has to be hand-mapped in VT's Converter on every import.
 * `rules-suggestions/index.ts` names this exact consumer on its seam and has
 * carried the fix since A6; nothing called it.
 *
 * ## Why a `Map` and not an import of `resolveAccount`
 *
 * The join **is** `rules-suggestions`' — `analysisAccount(account)` is the one
 * place `Ledger: Account` is produced, and `ClientChartOfAccounts.categories`
 * is that function already applied, `{ code, name }` with `name` in the
 * emittable form. What crosses into this module is therefore the *result*, as
 * data.
 *
 * That keeps `document-to-canonical.ts` what its own header promises: **pure —
 * no database, no clock, no config**. A value import of `rules-suggestions`
 * would drag a Nest module, a Prisma factory and that module's own cross-module
 * imports into a file whose whole point is that the mapping is provable offline.
 * The chart arrives from the caller that already holds a scoped transaction
 * (`exports.service.ts` for the file, `approvals.module.ts` for the publish
 * review card), which is where a database read belongs.
 *
 * ## `null` is a real answer, and it is never a guess
 *
 * A code that is not on this client's chart resolves to nothing. It is **not**
 * matched to the near miss it is one character away from and **not** given an
 * invented ledger — `documents.category_code` is free text in the schema, an
 * accountant's explicit rule outranks the chart and may legitimately name a code
 * the chart does not carry, and a guessed ledger is a wrong nominal in somebody's
 * books. The caller falls back to the bare code and the VT emitter raises
 * `analysis-account-unprefixed` against that document, so the fact reaches the
 * accountant on the publish review card **before** the release rather than
 * inside VT afterwards.
 */

/** `documents.category_code` → the ledger-prefixed `Analysis account` string. */
export type AnalysisAccountChart = ReadonlyMap<string, string>;

/**
 * `ClientChartOfAccounts.categories` → the lookup.
 *
 * Structural over `{ code, name }` rather than typed against
 * `rules-suggestions`' `ChartCategory`, for the reason in the header: this
 * module takes the chart as data, not as a dependency.
 */
export function analysisAccountChart(
  categories: readonly { readonly code: string; readonly name: string }[],
): AnalysisAccountChart {
  return new Map(categories.map((category) => [category.code, category.name]));
}

/**
 * The `Analysis account` a category code names, or `null` when this client's
 * chart does not carry it (or when no chart was available at all).
 *
 * Exact match only. `resolveAccount` in `rules-suggestions` makes the same
 * choice for the same reason its own test gives: `category_code` is free text in
 * the schema, so a code that is not on the chart is a real thing that can be in
 * the column, and *answering `null` is what lets the caller surface it instead
 * of substituting something*.
 */
export function resolveAnalysisAccount(
  chart: AnalysisAccountChart | null,
  categoryCode: string,
): string | null {
  if (chart === null) return null;
  return chart.get(categoryCode) ?? null;
}
