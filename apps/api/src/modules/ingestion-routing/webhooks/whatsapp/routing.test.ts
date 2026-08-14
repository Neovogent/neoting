import { expect, test } from 'vitest';

import { decideRouting } from './routing.js';

test('a single mapping routes straight to that workspace', () => {
  const mappings = new Map<string, readonly string[]>([['447700900000', ['biz-1']]]);
  expect(decideRouting('447700900000', mappings)).toEqual({ kind: 'matched', businessId: 'biz-1' });
});

test('multiple mappings ask "Which company?"', () => {
  const mappings = new Map<string, readonly string[]>([['447700900000', ['biz-1', 'biz-2']]]);
  const decision = decideRouting('447700900000', mappings);
  expect(decision.kind).toBe('multiple');
  if (decision.kind === 'multiple') expect(decision.candidateBusinessIds).toHaveLength(2);
});

test('an unknown sender lands in Unrouted, never dropped', () => {
  const decision = decideRouting('447700900000', new Map());
  expect(decision.kind).toBe('unrouted');
});
