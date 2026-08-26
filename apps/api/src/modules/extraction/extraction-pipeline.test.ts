import { expect, test } from 'vitest';

import { categoryFromRule, extractionLatencyMs, RecordingExtractionStep } from './extraction-pipeline.js';

// The DB orchestration is proven in extraction-pipeline.integration.test.ts (it
// needs RLS + the real state machine). These cover the pure helpers and the
// fixture used by the ingest processor's own unit tests.

test('categoryFromRule reads a categoryCode from a rule sets object, else null', () => {
  expect(categoryFromRule({ categoryCode: 'COST_OF_SALES_FOOD' })).toBe('COST_OF_SALES_FOOD');
  expect(categoryFromRule({ categoryCode: '   ' })).toBeNull(); // whitespace is not a code
  expect(categoryFromRule({ other: 'x' })).toBeNull();
  expect(categoryFromRule(null)).toBeNull();
  expect(categoryFromRule(['COST_OF_SALES_FOOD'])).toBeNull(); // an array is not a sets object
  expect(categoryFromRule('COST_OF_SALES_FOOD')).toBeNull();
});

test('the simulated latency is deterministic in the byte hash and inside the 2–4 s band', () => {
  const a = extractionLatencyMs('abcd0000' + '0'.repeat(56));
  const b = extractionLatencyMs('abcd0000' + '0'.repeat(56));
  expect(a).toBe(b);
  expect(a).toBeGreaterThanOrEqual(2000);
  expect(a).toBeLessThan(4000);
  // A malformed hash must not throw or produce NaN.
  expect(extractionLatencyMs('')).toBeGreaterThanOrEqual(2000);
});

test('RecordingExtractionStep records each run for the processor tests', async () => {
  const step = new RecordingExtractionStep();
  await step.run({ documentId: 'd1', practiceId: 'p1', businessId: null, traceId: 't', finalAttempt: false });
  expect(step.runs).toHaveLength(1);
  expect(step.runs[0]?.documentId).toBe('d1');
});
