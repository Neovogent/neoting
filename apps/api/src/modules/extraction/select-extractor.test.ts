import { expect, test } from 'vitest';

import type { DocumentStore } from '../ingestion-routing/index.js';
import { BedrockExtractor } from './bedrock-extractor.js';
import { DemoExtractor } from './demo-extractor.js';
import { selectExtractor } from './select-extractor.js';

const ENV = {
  EXTRACTOR: 'demo',
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

test('bedrock mode returns the real extractor UNWRAPPED — a failed read must not become fixture data', () => {
  // This assertion is the point of the test, not a detail of it. A
  // `FallbackExtractor` used to wrap this, so a throw from Bedrock answered with
  // `DemoExtractor`'s output for the same real client document: an invented
  // supplier, total, tax and VAT number, every field non-null, which makes
  // `resolveProcessedState` return READY. A throttle was enough to trigger it.
  // If anything ever wraps this again, that failure mode comes back.
  const extractor = selectExtractor({ ...ENV, EXTRACTOR: 'bedrock' }, store);
  expect(extractor).toBeInstanceOf(BedrockExtractor);
});

test('bedrock without a store fails at construction, not on first document', () => {
  // A real extractor needs the bytes. Returning something that fails later would
  // surface as an unreadable document rather than as the wiring bug it is.
  expect(() => selectExtractor({ ...ENV, EXTRACTOR: 'bedrock' })).toThrow(/needs a DocumentStore/);
});

test('the extractor names itself, so the audit columns cannot claim to be the fixture one', () => {
  // `extractions.extractorKind` / `.modelVersion` are the audit answer to "which
  // reader produced this value". The pipeline used to hardcode the demo
  // constants, so a genuine model read was persisted labelled `demo`.
  expect(selectExtractor(ENV).kind).toBe('demo');
  expect(selectExtractor({ ...ENV, EXTRACTOR: 'bedrock' }, store).kind).toBe('bedrock');
  // Pinned in chat-framework/models.ts, never from env — no `eu.`/`global.`
  // prefix, because an inference profile routes outside the UK (D30/ADR 0001).
  expect(selectExtractor({ ...ENV, EXTRACTOR: 'bedrock' }, store).modelVersion).toMatch(/^anthropic\./);
});
