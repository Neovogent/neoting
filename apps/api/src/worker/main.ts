import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError, Worker } from 'bullmq';

import { getPrismaClient } from '../common/db/prisma.js';
import { loadEnv } from '../config/env.js';
import { PrismaExtractionStep, selectExtractor } from '../modules/extraction/index.js';
import { createSharpPerceptualHasher } from '../modules/ingestion-routing/lib/dedupe/perceptual-hash.js';
import {
  selectDocumentGuard,
  selectImageNormaliser,
} from '../modules/ingestion-routing/lib/sanitisation/index.js';
import { BullmqDeadLetterQueue } from '../modules/ingestion-routing/queue/dead-letter.js';
import { PrismaDocumentSink } from '../modules/ingestion-routing/queue/document-sink.js';
import { PrismaDuplicateDetector } from '../modules/ingestion-routing/queue/duplicate-detector.js';
import { processIngestJob, TerminalJobError } from '../modules/ingestion-routing/queue/ingest-processor.js';
import { InMemoryProcessedStore } from '../modules/ingestion-routing/queue/processed-store.js';
import { INGEST_QUEUE_NAME } from '../modules/ingestion-routing/queue/queue-names.js';
import { createRedisConnection } from '../modules/ingestion-routing/queue/redis-connection.js';
import { selectMediaFetcher } from '../modules/ingestion-routing/queue/select-media-fetcher.js';
import type { MediaIntakeDeps } from '../modules/ingestion-routing/queue/whatsapp-media-intake.js';
import { selectDocumentStore } from '../modules/ingestion-routing/storage/select-document-store.js';

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
  const sink = new PrismaDocumentSink(getPrismaClient());
  const detector = new PrismaDuplicateDetector(getPrismaClient());
  // Extraction (METH Stage 4) — the step that moves a document out of RECEIVED.
  // Config-selected (`EXTRACTOR=demo`), logging through the worker's logger.
  const extractor = new PrismaExtractionStep(getPrismaClient(), selectExtractor(env), {
    logger: { log: (message) => logger.log(message), warn: (message) => logger.warn(message) },
  });

  // WhatsApp media (#79). This is the FIRST real call site for the four
  // config-selected seams below — `selectDocumentStore`, `selectImageNormaliser`,
  // `selectDocumentGuard` and the sharp hasher existed with nothing constructing
  // them, which is how a switch quietly stops being wired to anything.
  const media: MediaIntakeDeps = {
    fetcher: selectMediaFetcher(env),
    store: selectDocumentStore(env),
    perceptualHasher: createSharpPerceptualHasher(),
    imageNormaliser: selectImageNormaliser(env.IMAGE_NORMALISER),
    documentGuard: selectDocumentGuard(env.DOCUMENT_GUARD),
  };

  const worker = new Worker(
    INGEST_QUEUE_NAME,
    async (job: Job) => {
      try {
        await processIngestJob(job.data, {
          processed,
          logger: { log: (message) => logger.log(message), warn: (message) => logger.warn(message) },
          sink,
          detector,
          media,
          extractor,
        });
      } catch (error) {
        // A terminal failure — an expired media id, a missing tenancy anchor —
        // cannot be fixed by trying again. `UnrecoverableError` stops the retries
        // now, so it reaches the DLQ, and a human, on the first attempt rather
        // than after five identical ones (#79: "not an infinite retry").
        if (error instanceof TerminalJobError) throw new UnrecoverableError(error.message);
        throw error;
      }
    },
    { connection, concurrency: 8 },
  );

  // On exhausted retries, move the job to the DLQ (Governance §7) rather than
  // letting it vanish. attemptsMade === opts.attempts means the last try failed.
  worker.on('failed', (job: Job | undefined, err: Error) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    // Matched on the name, not `instanceof`: BullMQ may hand this listener an
    // error rehydrated from the job's stored failedReason, which is a plain
    // Error. A terminal job has no retries left by definition, so the
    // attempts-remaining check below must not send it back round.
    const terminal = err.name === 'UnrecoverableError';
    if (!terminal && job.attemptsMade < maxAttempts) return; // more retries pending
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
