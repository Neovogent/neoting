import { expect, test } from 'vitest';

import { analysisAccountChart, resolveAnalysisAccount } from '../exports-public-api/index.js';
import {
  accountCatalogue,
  analysisAccount,
  BUSINESS_PROFILE_IDS,
  BUSINESS_PROFILES,
  chartOfAccountsFor,
  toCategories,
} from '../rules-suggestions/index.js';
import { categoryLabels } from './category-labels.js';

/**
 * **The whole warrant for looking a category label up in the catalogue rather
 * than in the client's own chart.**
 *
 * `category-labels.ts` claims two things, and each is exactly the kind of claim
 * that is true on the day it is written and quietly false a year later. Both
 * are asserted here rather than trusted, because the cost of either going wrong
 * is a board and an export file naming different accounts for one document —
 * which is the defect this whole seam exists to close.
 */

test('a code names ONE account, whatever chart it is read off', () => {
  // The claim: a profile decides WHICH codes a client's chart carries, never
  // what they are called. The day somebody adds a second definition of a code
  // under a different name, this fails — and `category-labels.ts` has to become
  // a per-business read.
  const labels = categoryLabels();
  const profiles: (Parameters<typeof chartOfAccountsFor>[0])[] = [
    null,
    ...BUSINESS_PROFILE_IDS.map((id) => ({
      businessActivity: BUSINESS_PROFILES[id].matches[0] ?? '',
      typicalCosts: [],
    })),
  ];

  for (const profile of profiles) {
    for (const category of toCategories(chartOfAccountsFor(profile))) {
      expect(labels.get(category.code), `${category.code} on ${String(profile?.businessActivity ?? 'no profile')}`).toBe(
        category.name,
      );
    }
  }
});

test('the label is the SAME STRING the export file writes', () => {
  // `DocumentSummary.categoryLabel` exists so the boards stop printing the raw
  // enum while the publish review card and the VT file print the name. That is
  // only worth anything if the two are byte-identical.
  const chart = chartOfAccountsFor(null);
  const exportChart = analysisAccountChart(toCategories(chart));

  for (const account of chart.accounts) {
    expect(categoryLabels().get(account.code)).toBe(resolveAnalysisAccount(exportChart, account.code));
  }
});

test('every label is ledger-prefixed, which is what makes it readable at all', () => {
  for (const account of accountCatalogue()) {
    expect(categoryLabels().get(account.code)).toBe(analysisAccount(account));
    expect(categoryLabels().get(account.code)).toContain(': ');
  }
});

test('a code the catalogue does not carry resolves to nothing, never to a near miss', () => {
  // `documents.category_code` is free text in the schema and an accountant's
  // explicit rule may legitimately name a code no chart holds. The projection
  // then emits null and the board shows the bare code — surfacing the fact
  // rather than substituting an invented ledger, which would be a wrong nominal
  // in somebody's books.
  expect(categoryLabels().get('REPAIRS_AND_MAINTENANC')).toBeUndefined();
  expect(categoryLabels().get('jhngbhf')).toBeUndefined();
  expect(categoryLabels().get('')).toBeUndefined();
});
