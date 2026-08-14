import IORedis, { type Redis } from 'ioredis';

/**
 * A Redis connection for BullMQ. `maxRetriesPerRequest: null` is mandatory —
 * BullMQ blocks on `BRPOPLPUSH` and ioredis' default request-retry cap would
 * abort those long polls.
 */
export function createRedisConnection(url: string): Redis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}
