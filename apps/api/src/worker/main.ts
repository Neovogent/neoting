import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { type Job, Worker } from 'bullmq';

import { loadEnv } from '../config/env.js';
import { BullmqDeadLetterQueue } from '../modules/ingestion-routing/queue/dead-letter.js';
import { processIngestJob } from '../modules/ingestion-routing/queue/ingest-processor.js';
import { InMemoryProcessedStore } from '../modules/ingestion-routing/queue/processed-store.js';
import { INGEST_QUEUE_NAME } from '../modules/ingestion-routing/queue/queue-names.js';
import { createRedisConnection } from '../modules/ingestion-routing/queue/redis-connection.js';

/**
 * The ingest worker — a SEPARATE process from the API (staging scales them
 * independently: a queue backlog must not demand more HTTP capacity). It drains
 * the ingest queue — validate → idempotent handle → log with the job's traceId —
 * and moves jobs that exhaust their retries to the DLQ rather than losing them.
 */
function bootstrap(): void {
  const env = loadEnv();
  const logger = new Logger('worker');
  const connection = createRedisConnection(env.REDIS_URL);
  const processed = new InMemoryProcessedStore();
  const deadLetters = new BullmqDeadLetterQueue(connection);

  const worker = new Worker(
    INGEST_QUEUE_NAME,
    (job: Job) =>
      processIngestJob(job.data, {
        processed,
        logger: { log: (message) => logger.log(message), warn: (message) => logger.warn(message) },
      }),
    { connection, concurrency: 8 },
  );

  // On exhausted retries, move the job to the DLQ (Governance §7) rather than
  // letting it vanish. attemptsMade === opts.attempts means the last try failed.
  worker.on('failed', (job: Job | undefined, err: Error) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return; // more retries pending
    const traceId = (job.data as { traceId?: string }).traceId ?? 'unknown';
    void deadLetters
      .deadLetter(job.data, err.message)
      .then(() => logger.error(`job ${job.id} exhausted after ${job.attemptsMade} attempts -> DLQ (trace=${traceId})`))
      .catch((dlqErr: unknown) => logger.error(`could not DLQ job ${job.id}: ${String(dlqErr)}`));
  });

  worker.on('ready', () => logger.log(`ingest worker ready on '${INGEST_QUEUE_NAME}'`));
  worker.on('error', (err: Error) => logger.error(`worker error: ${err.message}`));
  logger.log(`ingest worker starting (redis ${env.REDIS_URL})`);
}

bootstrap();
