import { expect, test } from 'vitest';

import { billedToMismatch, normaliseParty } from './billedTo';
import type { ExtractedField } from './types';

const f = (label: string, value: string): ExtractedField => ({
  label,
  value,
  confidence: 0.97,
  provenance: 'bill-to block',
});

const cost = (clientName: string) => ({ kind: 'cost' as const, clientName });

test('the live case: a cost addressed to another company is named', () => {
  // The Wolseley invoice that sat in Aldgate Kitchen's inbox on 7 Sep 2026.
  expect(billedToMismatch(cost('Aldgate Kitchen Ltd'), [f('Customer', 'American Burger Ltd')])).toBe(
    'American Burger Ltd',
  );
});

test('a suffix or punctuation difference is NOT a mismatch', () => {
  for (const paper of ['Aldgate Kitchen', 'ALDGATE KITCHEN LIMITED', 'Aldgate Kitchen Ltd.', 'The Aldgate Kitchen Co']) {
    expect(billedToMismatch(cost('Aldgate Kitchen Ltd'), [f('Customer', paper)])).toBeNull();
  }
});

test('silence when there is nothing to compare', () => {
  expect(billedToMismatch(cost('Aldgate Kitchen Ltd'), [])).toBeNull();
  expect(billedToMismatch(cost('Aldgate Kitchen Ltd'), [f('Customer', '—')])).toBeNull();
  expect(billedToMismatch(cost('Aldgate Kitchen Ltd'), [f('Customer', '  ')])).toBeNull();
  // A name that is nothing BUT noise words normalises to empty — say nothing.
  expect(billedToMismatch(cost('Ltd'), [f('Customer', 'American Burger Ltd')])).toBeNull();
});

test('sales documents are never flagged — the customer is somebody else by definition', () => {
  expect(billedToMismatch({ kind: 'sales', clientName: 'Aldgate Kitchen Ltd' }, [f('Customer', 'Deliveroo')])).toBeNull();
});

test('normalisation strips company noise, not the name', () => {
  expect(normaliseParty('The Aldgate Kitchen Co. Ltd')).toBe('aldgate kitchen');
});
