import { expect, test } from 'vitest';

import { currentTraceId, runWithTrace } from './trace-context.js';

test('exposes the traceId inside the context and nothing outside', () => {
  expect(currentTraceId()).toBeUndefined();
  const seen = runWithTrace('t-123', () => currentTraceId());
  expect(seen).toBe('t-123');
  expect(currentTraceId()).toBeUndefined();
});

test('the trace context survives across an await (so the enqueue inside a handler sees it)', async () => {
  const seen = await runWithTrace('t-async', async () => {
    await Promise.resolve();
    return currentTraceId();
  });
  expect(seen).toBe('t-async');
});
