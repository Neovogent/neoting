import { describe, expect, test } from 'vitest';

import {
  analysisAccount,
  ChartAccountSchema,
  LEDGERS,
  resolveAccount,
  splitAnalysisAccount,
} from './account.js';
import { accountCatalogue, BUSINESS_PROFILES, coreAccounts, PROFILE_SELECTION_ORDER } from './profiles.js';

/**
 * **The A7 contract, asserted over the whole catalogue rather than an example.**
 *
 * `exports-public-api`'s VT emitter needs `Analysis account` in `Ledger: Account`
 * form — literally `Cost of sales: Purchases` — and raises a warning for a bare
 * name because VT may not match it to a nominal without the prefix. If any
 * account this module can seed were unemittable, the failure would land inside
 * an accountant's software rather than in a stack trace here.
 */
describe('the emittable form A7 needs', () => {
  test('every account in the catalogue renders as "Ledger: Account"', () => {
    const catalogue = accountCatalogue();
    expect(catalogue.length).toBeGreaterThan(20);

    for (const account of catalogue) {
      const emitted = analysisAccount(account);
      expect(emitted).toBe(`${account.ledger}: ${account.name}`);
      // The exact shape the emitter's `analysisAccountUnprefixed` check looks for.
      expect(emitted).toMatch(/^[^:]+: [^:]+$/);
      expect(emitted.trim()).toBe(emitted);
    }
  });

  test('the SoT’s own two examples come out verbatim', () => {
    expect(analysisAccount({ ledger: 'Cost of sales', name: 'Purchases' })).toBe('Cost of sales: Purchases');
    expect(analysisAccount({ ledger: 'Expenses', name: 'Motor expenses' })).toBe('Expenses: Motor expenses');
  });

  test('the split is the exact inverse, so nothing is lost on the way back', () => {
    for (const account of accountCatalogue()) {
      const parts = splitAnalysisAccount(analysisAccount(account));
      expect(parts).toEqual({ ledger: account.ledger, name: account.name });
    }
  });

  test('a bare name has no prefix to split, and says so rather than guessing one', () => {
    expect(splitAnalysisAccount('Purchases')).toBeNull();
    expect(splitAnalysisAccount(': Purchases')).toBeNull();
  });
});

describe('the schema refuses what would corrupt the emitted string', () => {
  const valid = {
    code: 'COS_PURCHASES',
    ledger: 'Cost of sales' as const,
    name: 'Purchases',
    vatTreatment: 'STANDARD' as const,
    taxConsequence: 'ALLOWABLE' as const,
    keywords: ['purchase'],
  };

  test('accepts a well-formed account', () => {
    expect(ChartAccountSchema.safeParse(valid).success).toBe(true);
  });

  test('refuses a colon in the account name — it is the separator', () => {
    expect(ChartAccountSchema.safeParse({ ...valid, name: 'Purchases: goods' }).success).toBe(false);
  });

  test('refuses padding, which would change VT’s Converter key invisibly', () => {
    expect(ChartAccountSchema.safeParse({ ...valid, name: ' Purchases' }).success).toBe(false);
    expect(ChartAccountSchema.safeParse({ ...valid, name: 'Purchases ' }).success).toBe(false);
  });

  test('refuses a code that is not the SCREAMING_SNAKE convention already in the column', () => {
    expect(ChartAccountSchema.safeParse({ ...valid, code: 'cos purchases' }).success).toBe(false);
    expect(ChartAccountSchema.safeParse({ ...valid, code: '1_PURCHASES' }).success).toBe(false);
  });

  test('every catalogue account passes its own schema', () => {
    for (const account of accountCatalogue()) {
      const parsed = ChartAccountSchema.safeParse(account);
      expect(parsed.success, `${account.code} failed: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    }
  });
});

describe('the catalogue itself', () => {
  test('a code means one account, everywhere', () => {
    const catalogue = accountCatalogue();
    expect(new Set(catalogue.map((a) => a.code)).size).toBe(catalogue.length);
  });

  test('no two accounts share an emitted name — VT maps on the string', () => {
    const emitted = accountCatalogue().map(analysisAccount);
    expect(new Set(emitted).size).toBe(emitted.length);
  });

  test('every ledger used is one of the four declared', () => {
    for (const account of accountCatalogue()) expect(LEDGERS).toContain(account.ledger);
  });

  /**
   * §24.4.6, as a test rather than a paragraph: *a catch-all "sundry" code is
   * where misclassification hides.* An uncertain document belongs in To Review,
   * where it is visible, not in a bucket that looks coded.
   */
  test('there is no catch-all bucket', () => {
    for (const account of accountCatalogue()) {
      expect(account.code).not.toMatch(/SUNDRY|MISC|OTHER_EXPENSE|GENERAL_EXPENSE|UNCATEGORISED/);
      expect(account.name.toLowerCase()).not.toContain('sundry');
      expect(account.name.toLowerCase()).not.toContain('miscellaneous');
    }
  });

  /**
   * §24.4.6 again: the disallowables, the capital items and the VAT-atypical
   * items must each have their own code, because those are the only
   * distinctions anyone outside the business enforces.
   */
  test('the core carries the distinctions the outside world enforces', () => {
    const codes = coreAccounts().map((a) => a.code);
    for (const required of [
      'BUSINESS_ENTERTAINING',
      'STAFF_WELFARE',
      'CHARITABLE_DONATIONS',
      'POLITICAL_DONATIONS',
      'FINES_AND_PENALTIES',
      'DEPRECIATION',
      'PRIVATE_USE',
    ]) {
      expect(codes).toContain(required);
    }
    // Business entertaining is BOTH disallowable and blocked for input VAT.
    const entertaining = coreAccounts().find((a) => a.code === 'BUSINESS_ENTERTAINING');
    expect(entertaining?.taxConsequence).toBe('DISALLOWABLE');
    expect(entertaining?.vatTreatment).toBe('BLOCKED');
    // Staff welfare is a DIFFERENT code and is allowable — the split every
    // major package ships, and the one §24.4.6 names.
    expect(coreAccounts().find((a) => a.code === 'STAFF_WELFARE')?.taxConsequence).toBe('ALLOWABLE');
  });

  test('every capital item sits in the Fixed assets ledger, and nothing else does', () => {
    for (const account of accountCatalogue()) {
      expect(account.taxConsequence === 'CAPITAL').toBe(account.ledger === 'Fixed assets');
    }
  });

  test('specialist profiles are additions to the core, never replacements', () => {
    const coreCodes = new Set(coreAccounts().map((a) => a.code));
    for (const id of PROFILE_SELECTION_ORDER) {
      for (const account of BUSINESS_PROFILES[id].additions) {
        expect(coreCodes.has(account.code), `${id} redefines core account ${account.code}`).toBe(false);
      }
    }
  });
});

describe('resolveAccount', () => {
  test('finds an account by the code that lands in documents.category_code', () => {
    expect(resolveAccount(accountCatalogue(), 'COS_PURCHASES')?.name).toBe('Purchases');
  });

  /**
   * `category_code` is free text in the schema — no enum, no foreign key — so a
   * code that is not on the chart is a real thing that can be in the column.
   * Answering `null` is what lets the caller surface it instead of substituting
   * a nominal nobody chose.
   */
  test('answers null for an off-chart code rather than guessing a nominal', () => {
    expect(resolveAccount(accountCatalogue(), 'SOMETHING_AN_OLD_SEED_WROTE')).toBeNull();
    expect(resolveAccount(accountCatalogue(), null)).toBeNull();
  });
});
