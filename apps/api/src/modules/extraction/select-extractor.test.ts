import { expect, test } from 'vitest';

import { DemoExtractor } from './demo-extractor.js';
import { selectExtractor } from './select-extractor.js';

test('demo mode returns the deterministic fixture extractor', () => {
  expect(selectExtractor({ EXTRACTOR: 'demo' })).toBeInstanceOf(DemoExtractor);
});
