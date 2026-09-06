import { describe, expect, test } from 'vitest';

import type { SuggestionChart } from './ai-suggestion.js';
import {
  MEMORY_BASE_CONFIDENCE,
  MEMORY_MAX_CONFIDENCE,
  memoryConfidence,
  type SupplierMemoryHistory,
  supplierMemorySuggestion,
} from './supplier-memory.js';

/**
 * **Review item 48 — supplier memory.** The three refusals are the point of
 * this file: what is NOT offered matters more than what is, because an offer
 * the correction boundary would reject is an affordance whose only outcome is a
 * 422.
 */

const CHART: SuggestionChart = {
  accounts: [],
  categories: [
    { code: 'FOOD_PURCHASES', name: 'Cost of sales: Food purchases' },
    { code: 'STAFF_WELFARE', name: 'Expenses: Staff welfare' },
  ],
};

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

function history(codes: readonly string[], dates: readonly string[] = []): SupplierMemoryHistory {
  const entries = codes.map((categoryCode, index) => ({
    categoryCode,
    receivedAt: at(dates[index] ?? `2026-0${(index % 9) + 1}-05`),
  }));
  return { entries, categoryCodes: [...new Set(codes)] };
}

describe('what is offered', () => {
  test('a supplier this client coded by hand comes back as a SUGGEST on the chart’s own code', () => {
    const answer = supplierMemorySuggestion(history(['FOOD_PURCHASES'], ['2026-08-09']), CHART);

    expect(answer?.outcome).toBe('SUGGEST');
    if (answer?.outcome !== 'SUGGEST') return;
    expect(answer.categoryCode).toBe('FOOD_PURCHASES');
    expect(answer.analysisAccount).toBe('Cost of sales: Food purchases');
    expect(answer.basis).toBe('SUPPLIER_MEMORY');
    // A remembered treatment is not a coding: §13.3's provenance class is what
    // makes a surface render it as an opinion.
    expect(answer.provenance).toBe('AI_SUGGESTED');
    expect(answer.note).toContain('9 Aug 2026');
    expect(answer.note).toContain('once');
  });

  test('⚠ the supplier’s NAME is never quoted into the note', () => {
    // It comes off a document a stranger sent, it is already on the screen
    // beside the panel, and the cheapest injection surface is the one you do
    // not have.
    const answer = supplierMemorySuggestion(history(['FOOD_PURCHASES']), CHART);
    expect(answer?.note).not.toContain('Aldgate');
    expect(answer?.note.toLowerCase()).toContain('this supplier');
  });

  test('there is no second choice — a history that answered one way every time had no runner-up', () => {
    const answer = supplierMemorySuggestion(history(['FOOD_PURCHASES', 'FOOD_PURCHASES']), CHART);
    expect(answer?.outcome === 'SUGGEST' && answer.secondChoice).toBeNull();
  });

  test('the most recent date is found rather than assumed to be first', () => {
    // `loadHistory` orders most-recent-first, but this function is on the public
    // seam and must not depend on a caller's ordering for a date it prints.
    const answer = supplierMemorySuggestion(history(['FOOD_PURCHASES', 'FOOD_PURCHASES'], ['2026-01-04', '2026-08-09']), CHART);
    expect(answer?.note).toContain('9 Aug 2026');
  });
});

describe('the confidence is CONSISTENCY, and it is bounded', () => {
  test('one hand-coding starts below the published seen-category figure, five reaches the ceiling', () => {
    expect(memoryConfidence(1)).toBe(MEMORY_BASE_CONFIDENCE);
    expect(memoryConfidence(5)).toBe(MEMORY_MAX_CONFIDENCE);
  });

  test('it rises with repetition and never past the ceiling', () => {
    const scores = [1, 2, 3, 4, 5, 20, 200].map(memoryConfidence);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1] as number);
      expect(scores[i]).toBeLessThanOrEqual(MEMORY_MAX_CONFIDENCE);
    }
  });

  test('a nonsense count cannot produce a confidence outside 0..1', () => {
    for (const times of [0, -3]) {
      const value = memoryConfidence(times);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  test('the suggestion carries the computed score, not a table lookup', () => {
    const one = supplierMemorySuggestion(history(['FOOD_PURCHASES']), CHART);
    const five = supplierMemorySuggestion(history(Array.from({ length: 5 }, () => 'FOOD_PURCHASES')), CHART);
    expect(one?.confidence).toBe(memoryConfidence(1));
    expect(five?.confidence).toBe(memoryConfidence(5));
    expect(five?.confidence).toBeGreaterThan(one?.confidence as number);
  });
});

describe('what is deliberately NOT offered', () => {
  test('no prior coding — there is nothing to remember', () => {
    expect(supplierMemorySuggestion({ entries: [], categoryCodes: [] }, CHART)).toBeNull();
  });

  test('two different codes is a disagreement, and offering the frequent one would present it as a consensus', () => {
    // §24.4.6: a change of treatment is itself worth surfacing. It falls through
    // to the tiers below, which answer from the document rather than the file.
    const mixed = history(['FOOD_PURCHASES', 'FOOD_PURCHASES', 'STAFF_WELFARE']);
    expect(supplierMemorySuggestion(mixed, CHART)).toBeNull();
  });

  test('⚠ a remembered code the chart no longer carries is NOT offered', () => {
    // Review item 48 names this. The export cannot give it a ledger prefix and
    // `assertUpdateCodingAllowed` refuses it on the way back in, so the only
    // possible outcome of offering it is a 422.
    expect(supplierMemorySuggestion(history(['RETIRED_CODE']), CHART)).toBeNull();
  });

  test('an empty chart offers nothing at all rather than everything', () => {
    expect(supplierMemorySuggestion(history(['FOOD_PURCHASES']), { accounts: [], categories: [] })).toBeNull();
  });
});
