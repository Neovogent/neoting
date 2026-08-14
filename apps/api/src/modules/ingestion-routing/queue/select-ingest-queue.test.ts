import { expect, test } from 'vitest';

import { FixtureIngestQueue, type IngestQueue } from '../webhooks/whatsapp/ingest-queue.js';
import { selectIngestQueue } from './select-ingest-queue.js';

test('fixture mode returns the in-memory fixture (offline default)', () => {
  const queue = selectIngestQueue({ INGEST_QUEUE: 'fixture', REDIS_URL: 'redis://unused' });
  expect(queue).toBeInstanceOf(FixtureIngestQueue);
});

test('bullmq mode builds the real queue from REDIS_URL — no Redis opened in the test', () => {
  const stub: IngestQueue = { async enqueue() {} };
  let seenUrl = '';
  const queue = selectIngestQueue(
    { INGEST_QUEUE: 'bullmq', REDIS_URL: 'redis://host:6379' },
    (url) => {
      seenUrl = url;
      return stub;
    },
  );
  expect(queue).toBe(stub);
  expect(seenUrl).toBe('redis://host:6379');
});
