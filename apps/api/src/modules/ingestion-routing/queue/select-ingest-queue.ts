import type { Env } from '../../../config/env.js';
import { FixtureIngestQueue, type IngestQueue } from '../webhooks/whatsapp/ingest-queue.js';
import { BullmqIngestQueue } from './bullmq-ingest-queue.js';
import { createRedisConnection } from './redis-connection.js';

/**
 * Pick the ingest queue implementation from config — never by import, so tests
 * and offline dev stay on the fixture while staging runs the real BullMQ. The
 * `makeBullmq` seam keeps this unit-testable without opening a Redis connection.
 */
export function selectIngestQueue(
  env: Pick<Env, 'INGEST_QUEUE' | 'REDIS_URL'>,
  makeBullmq: (redisUrl: string) => IngestQueue = (redisUrl) => new BullmqIngestQueue(createRedisConnection(redisUrl)),
): IngestQueue {
  return env.INGEST_QUEUE === 'bullmq' ? makeBullmq(env.REDIS_URL) : new FixtureIngestQueue();
}
