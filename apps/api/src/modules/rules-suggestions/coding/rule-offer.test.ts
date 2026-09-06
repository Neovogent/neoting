import { describe, expect, test } from 'vitest';

import { RULE_OFFER_THRESHOLD, supplierRuleOffer } from './rule-offer.js';
import type { SupplierCodingResult } from './supplier-coding.service.js';

/**
 * **Review item 48's follow-on** — *"after the same treatment repeats N times,
 * OFFER to formalise it as a rule"*.
 *
 * The interesting assertions are the silences. An offer writes nothing by
 * itself, but it is one click from a STANDING rule that codes documents nobody
 * has looked at yet, so the cases where it must not appear matter more than the
 * one where it does.
 */

const CHART = {
  accounts: [],
  categories: [{ code: 'COS_FOOD_AND_DRINK', name: 'Cost of sales: Food and drink' }],
} as unknown as SupplierCodingResult['chart'];

const entry = (n: number, code = 'COS_FOOD_AND_DRINK', spelling = 'Aldgate Meats Ltd') => ({
  documentId: `d${n}`,
  supplierName: spelling,
  categoryCode: code,
  receivedAt: new Date(`2026-0${(n % 9) + 1}-05T00:00:00Z`),
});

function result(over: {
  times?: number;
  authority?: string;
  outcome?: string;
  spellings?: string[];
  categoryCodes?: string[];
} = {}): SupplierCodingResult {
  const times = over.times ?? RULE_OFFER_THRESHOLD;
  const entries = Array.from({ length: times }, (_, i) => entry(i + 1));
  return {
    businessId: 'biz_1',
    chart: CHART,
    history: {
      entries,
      categoryCodes: over.categoryCodes ?? ['COS_FOOD_AND_DRINK'],
      spellings: over.spellings ?? ['Aldgate Meats Ltd'],
    },
    decision: {
      outcome: over.outcome ?? 'CODE',
      authority: over.authority ?? 'LEARNED_HISTORY',
      categoryCode: 'COS_FOOD_AND_DRINK',
      analysisAccount: 'Cost of sales: Food and drink',
      sourceRuleId: null,
      supplier: { name: 'Aldgate Meats Ltd', key: 'aldgate meats', isNew: false },
      nearMissRuleScopeKeys: [],
      reason: 'coded by hand',
    },
  } as unknown as SupplierCodingResult;
}

describe('when the offer appears', () => {
  test('at the threshold, naming the account, the count and the EXACT scope key', () => {
    const offer = supplierRuleOffer(result());

    expect(offer).not.toBeNull();
    expect(offer?.times).toBe(RULE_OFFER_THRESHOLD);
    expect(offer?.categoryCode).toBe('COS_FOOD_AND_DRINK');
    expect(offer?.analysisAccount).toBe('Cost of sales: Food and drink');
    expect(offer?.rationale).toContain('Aldgate Meats Ltd');
    expect(offer?.rationale).toContain('Cost of sales: Food and drink');
  });

  /**
   * ⚠ The single detail that breaks this feature silently. The pipeline matches
   * a rule by EXACT string equality, so a normalised or title-cased key produces
   * a rule that is written, renders correctly, is approved — and never fires,
   * with nothing reporting it.
   */
  test('⚠ the scope key is the spelling a document actually carried, untouched', () => {
    const offer = supplierRuleOffer(result({ spellings: ['ALDGATE MEATS LTD', 'Aldgate Meats'] }));
    expect(offer?.scopeKey).toBe('ALDGATE MEATS LTD');
  });

  test('other spellings are REPORTED rather than pretended to be covered', () => {
    // A rule that appears to work and half does is worse than two rules.
    const offer = supplierRuleOffer(result({ spellings: ['Aldgate Meats Ltd', 'ALDGATE MEATS', 'Aldgate Meats'] }));
    expect(offer?.unmatchedSpellings).toEqual(['ALDGATE MEATS', 'Aldgate Meats']);
  });
});

describe('when it deliberately does not', () => {
  test('one coding below the threshold — a decision is not yet a pattern', () => {
    expect(supplierRuleOffer(result({ times: RULE_OFFER_THRESHOLD - 1 }))).toBeNull();
  });

  test('⚠ a rule ALREADY codes this supplier — two at one tier leaves the newest quietly winning', () => {
    expect(supplierRuleOffer(result({ authority: 'ACCOUNTANT_RULE' }))).toBeNull();
  });

  test('the treatment is not the client’s own — nothing is inferred into a standing rule', () => {
    expect(supplierRuleOffer(result({ authority: 'PRACTICE_DEFAULT' }))).toBeNull();
  });

  test('the ladder did not settle on one code at all', () => {
    expect(supplierRuleOffer(result({ outcome: 'REVIEW' }))).toBeNull();
  });

  test('there is no exact spelling to key a rule on, so no rule is offered', () => {
    expect(supplierRuleOffer(result({ spellings: [] }))).toBeNull();
    expect(supplierRuleOffer(result({ spellings: ['   '] }))).toBeNull();
  });

  test('a locked document offers nothing — a person already decided', () => {
    const locked = result();
    expect(
      supplierRuleOffer({
        ...locked,
        decision: { outcome: 'LOCKED', lock: 'HUMAN_CORRECTION', categoryCode: 'COS_FOOD_AND_DRINK' },
      } as unknown as SupplierCodingResult),
    ).toBeNull();
  });
});

describe('the threshold itself', () => {
  test('is a value, and offers only ever grow with repetition', () => {
    // Not a confidence gate: it counts human decisions. Below it, silence;
    // at and above it, the same offer carrying a bigger count.
    for (let times = 1; times < RULE_OFFER_THRESHOLD; times += 1) {
      expect(supplierRuleOffer(result({ times }))).toBeNull();
    }
    for (const times of [RULE_OFFER_THRESHOLD, RULE_OFFER_THRESHOLD + 4]) {
      expect(supplierRuleOffer(result({ times }))?.times).toBe(times);
    }
  });
});
