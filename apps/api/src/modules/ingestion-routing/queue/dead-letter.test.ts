import { expect, test } from 'vitest';

import { classifyFailure, MAX_REPLAYS } from './dead-letter.js';

test('keeps retrying while attempts remain', () => {
  expect(classifyFailure(1, 5, 0)).toBe('retry');
  expect(classifyFailure(4, 5, 0)).toBe('retry');
});

test('dead-letters an exhausted job rather than losing it', () => {
  expect(classifyFailure(5, 5, 0)).toBe('dead-letter');
});

test('quarantines a poison message once it has been replayed MAX_REPLAYS times', () => {
  expect(classifyFailure(5, 5, MAX_REPLAYS)).toBe('quarantine');
  expect(classifyFailure(5, 5, MAX_REPLAYS + 1)).toBe('quarantine');
});
