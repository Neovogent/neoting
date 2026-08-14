import { randomUUID } from 'node:crypto';

import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { currentTraceId } from '../../../common/trace/trace-context.js';
import type { IngestJob, IngestQueue } from '../webhooks/whatsapp/ingest-queue.js';
import { INGEST_QUEUE_NAME } from './queue-names.js';

const ATTEMPTS = 5;

/**
 * The real BullMQ producer behind the `IngestQueue` interface (#12). It is
 * selected by config in the module — the webhook controller enqueues through the
 * exact same interface it always did, so it does not change.
 *
 * - `jobId = idempotencyKey` (the wamid) makes the producer side idempotent:
 *   BullMQ ignores a second add of an id already in the queue.
 * - `traceId` is read from the request's AsyncLocalStorage context, so the trace
 *   born at the webhook survives into the job without the controller passing it.
 * - Capped attempts + exponential backoff; failed jobs are kept (not removed) so
 *   the worker's failed-handler can move exhausted ones to the DLQ.
 */
export class BullmqIngestQueue implements IngestQueue {
  private readonly queue: Queue;

  constructor(connection: Redis) {
    this.queue = new Queue(INGEST_QUEUE_NAME, { connection });
  }

  async enqueue(job: IngestJob): Promise<void> {
    const traceId = currentTraceId() ?? randomUUID();
    await this.queue.add(
      'whatsapp',
      { ...job, traceId },
      {
        jobId: job.idempotencyKey,
        attempts: ATTEMPTS,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
}
