import { describe, expect, test } from 'vitest';

import { normaliseSupplierKey, sameSupplier } from './supplier-key.js';

describe('normaliseSupplierKey', () => {
  test('groups the spellings one supplier arrives under across a year', () => {
    const spellings = ['Nisbets', 'NISBETS LTD', 'Nisbets Ltd.', 'nisbets limited', '  Nisbets  '];
    for (const spelling of spellings) expect(normaliseSupplierKey(spelling)).toBe('nisbets');
  });

  test('"&" becomes "and" before punctuation is stripped, so both spellings agree', () => {
    expect(normaliseSupplierKey('Smith & Sons')).toBe('smith and sons');
    expect(normaliseSupplierKey('Smith and Sons')).toBe('smith and sons');
  });

  test('only trailing company forms are stripped, and only whole tokens', () => {
    expect(normaliseSupplierKey('Ltdvale Supplies')).toBe('ltdvale supplies');
    expect(normaliseSupplierKey('Group Travel Ltd')).toBe('group travel');
  });

  test('never normalises a name away to nothing', () => {
    expect(normaliseSupplierKey('Group')).toBe('group');
    expect(normaliseSupplierKey('Ltd')).toBe('ltd');
  });

  test('an absent or contentless name is the empty key, not a match-anything key', () => {
    expect(normaliseSupplierKey(null)).toBe('');
    expect(normaliseSupplierKey(undefined)).toBe('');
    expect(normaliseSupplierKey('   ')).toBe('');
    expect(normaliseSupplierKey('***')).toBe('');
  });
});

describe('sameSupplier', () => {
  test('two spellings of one supplier', () => {
    expect(sameSupplier('NISBETS LTD', 'Nisbets')).toBe(true);
  });

  test('two different suppliers', () => {
    expect(sameSupplier('Nisbets', 'Costco')).toBe(false);
  });

  /**
   * The empty key must never match, or every unread supplier would be the same
   * supplier and one client's history would code another's documents.
   */
  test('the empty key matches nothing, including itself', () => {
    expect(sameSupplier(null, null)).toBe(false);
    expect(sameSupplier('', '')).toBe(false);
    expect(sameSupplier('***', '###')).toBe(false);
  });
});
