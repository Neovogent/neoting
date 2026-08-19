import { expect, test } from 'vitest';

import type { DocumentStore } from '../ingestion-routing/index.js';
import { DemoExtractor } from './demo-extractor.js';
import { FallbackExtractor } from './fallback-extractor.js';
import { selectExtractor } from './select-extractor.js';

const ENV = {
  EXTRACTOR: 'demo',
  BEDROCK_MODEL_ID: 'eu.anthropic.claude-opus-5',
  BEDROCK_REGION: 'eu-west-2',
} as const;

/** Never called in these tests — selection must not touch the store. */
const store = {} as DocumentStore;

test('demo mode returns the deterministic fixture extractor', () => {
  expect(selectExtractor(ENV)).toBeInstanceOf(DemoExtractor);
});

test('demo mode ignores a store — the fixture extractor never reads bytes', () => {
  expect(selectExtractor(ENV, store)).toBeInstanceOf(DemoExtractor);
});

test('bedrock mode is wrapped, so a throw degrades to fixtures rather than breaking the pipeline', () => {
  // The wrapper is the demo safety net (fallback-extractor.ts). If this ever
  // stops being a FallbackExtractor, a Bedrock outage takes extraction down.
  expect(selectExtractor({ ...ENV, EXTRACTOR: 'bedrock' }, store)).toBeInstanceOf(FallbackExtractor);
});

test('bedrock without a store fails at construction, not on first document', () => {
  // A real extractor needs the bytes. Returning something that fails later would
  // surface as an unreadable document rather than as the wiring bug it is.
  expect(() => selectExtractor({ ...ENV, EXTRACTOR: 'bedrock' })).toThrow(/needs a DocumentStore/);
});
