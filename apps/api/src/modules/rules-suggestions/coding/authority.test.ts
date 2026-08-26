import { describe, expect, test } from 'vitest';

import { RuleTier } from '@neoting/contracts/model';

import {
  authorityForTier,
  authorityRank,
  CODING_AUTHORITIES,
  outranks,
  RULE_TIER_PRECEDENCE,
  tierRank,
} from './authority.js';

describe('the authority order is the SoT’s, in the SoT’s order', () => {
  test('accountant rules → practice defaults → client context → learned history → AI', () => {
    expect([...CODING_AUTHORITIES]).toEqual([
      'ACCOUNTANT_RULE',
      'PRACTICE_DEFAULT',
      'CLIENT_CONTEXT',
      'LEARNED_HISTORY',
      'AI_INFERENCE',
    ]);
  });

  test('an explicit accountant rule outranks every other rung', () => {
    for (const other of CODING_AUTHORITIES) {
      if (other === 'ACCOUNTANT_RULE') continue;
      expect(outranks('ACCOUNTANT_RULE', other)).toBe(true);
      expect(outranks(other, 'ACCOUNTANT_RULE')).toBe(false);
    }
  });

  test('learned history never outranks a rule, and AI never outranks anything', () => {
    expect(outranks('LEARNED_HISTORY', 'ACCOUNTANT_RULE')).toBe(false);
    expect(outranks('LEARNED_HISTORY', 'PRACTICE_DEFAULT')).toBe(false);
    for (const other of CODING_AUTHORITIES) {
      if (other === 'AI_INFERENCE') continue;
      expect(outranks('AI_INFERENCE', other)).toBe(false);
    }
  });

  test('an equal rung never displaces a decision already made', () => {
    for (const authority of CODING_AUTHORITIES) expect(outranks(authority, authority)).toBe(false);
  });

  test('rank is strictly increasing down the ladder', () => {
    for (let i = 1; i < CODING_AUTHORITIES.length; i += 1) {
      const previous = CODING_AUTHORITIES[i - 1] as (typeof CODING_AUTHORITIES)[number];
      const current = CODING_AUTHORITIES[i] as (typeof CODING_AUTHORITIES)[number];
      expect(authorityRank(current)).toBeGreaterThan(authorityRank(previous));
    }
  });
});

describe('RuleTier maps onto the ladder without the two being confused', () => {
  test('every rule tier is accountant intent — a rule exists only because one was approved', () => {
    expect(authorityForTier('USER')).toBe('ACCOUNTANT_RULE');
    expect(authorityForTier('PAYMENT_METHOD')).toBe('ACCOUNTANT_RULE');
    expect(authorityForTier('SUPPLIER_CUSTOMER')).toBe('ACCOUNTANT_RULE');
  });

  test('an account default is the practice-default rung', () => {
    expect(authorityForTier('ACCOUNT_DEFAULT')).toBe('PRACTICE_DEFAULT');
  });

  test('the mapping is total over the contract’s enum', () => {
    for (const tier of Object.values(RuleTier)) {
      expect(CODING_AUTHORITIES).toContain(authorityForTier(tier));
    }
  });
});

describe('rule precedence within the rules themselves', () => {
  test('user beats payment-method beats supplier/customer beats account default', () => {
    expect([...RULE_TIER_PRECEDENCE]).toEqual(['USER', 'PAYMENT_METHOD', 'SUPPLIER_CUSTOMER', 'ACCOUNT_DEFAULT']);
    expect(tierRank('USER')).toBeLessThan(tierRank('PAYMENT_METHOD'));
    expect(tierRank('PAYMENT_METHOD')).toBeLessThan(tierRank('SUPPLIER_CUSTOMER'));
    expect(tierRank('SUPPLIER_CUSTOMER')).toBeLessThan(tierRank('ACCOUNT_DEFAULT'));
  });

  test('it covers every tier the contract admits — a new one would sort last, never first', () => {
    for (const tier of Object.values(RuleTier)) expect(RULE_TIER_PRECEDENCE).toContain(tier);
    expect(tierRank('SOMETHING_NEW' as never)).toBe(RULE_TIER_PRECEDENCE.length);
  });
});
