import { expect, test } from 'vitest';

import { processIngestJob } from './ingest-processor.js';
import { InMemoryProcessedStore } from './processed-store.js';

function harness(): { logs: string[]; warns: string[]; deps: Parameters<typeof processIngestJob>[1] } {
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    logs,
    warns,
    deps: {
      processed: new InMemoryProcessedStore(),
      logger: { log: (m) => logs.push(m), warn: (m) => warns.push(m) },
    },
  };
}

const payload = {
  source: 'whatsapp',
  idempotencyKey: 'wamid.1',
  from: '447700900000',
  receivedAtSeconds: 1_700_000_000,
  messageType: 'image',
  caption: null,
  routing: { kind: 'unrouted' },
  stale: false,
  traceId: 'trace-abc',
};

test('processes a valid job once and logs with the traceId', async () => {
  const { logs, deps } = harness();
  await processIngestJob(payload, deps);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain('wamid.1');
  expect(logs[0]).toContain('trace-abc');
});

test('the same idempotencyKey handled twice does not double-process', async () => {
  const { logs, warns, deps } = harness();
  await processIngestJob(payload, deps);
  await processIngestJob(payload, deps);
  expect(logs).toHaveLength(1); // work happened exactly once
  expect(warns).toHaveLength(1); // the redelivery was a logged no-op
});

test('a malformed payload is rejected at the boundary (throws → BullMQ retries/DLQs)', async () => {
  const { deps } = harness();
  await expect(processIngestJob({ nonsense: true }, deps)).rejects.toThrow();
  await expect(processIngestJob({ ...payload, traceId: '' }, deps)).rejects.toThrow();
});
