import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError, Worker } from 'bullmq';

import { InMemoryAiBudget, RedisAiBudget } from '../common/ai-budget.js';
import { getPrismaClient } from '../common/db/prisma.js';
import { loadEnv } from '../config/env.js';
import { PrismaChaseAutoClose } from '../modules/chase/index.js';
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
import { PrismaStatementStep, selectTableReader } from '../modules/banking-matching/index.js';
import { selectDocumentStore } from '../modules/ingestion-routing/storage/select-document-store.js';
import { PrismaUploadSanitisationStep } from '../modules/ingestion-routing/web-upload/prisma-upload-sanitisation.js';

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
  // The object store, built ONCE and shared: the ingest pipeline persists through
  // it and — since METH Stage 15 — `EXTRACTOR=bedrock` reads the bytes back
  // through it to send the image to Claude. Two instances would be two clients
  // against the same bucket for no reason.
  const documentStore = selectDocumentStore(env);
  // The per-firm daily AI spend ceiling (§9.7, S5). Built with the SAME
  // selection rule as `chat-framework/chat.module.ts` — Redis where there is
  // one, an in-process ledger otherwise — because it is the SAME ledger: one
  // firm, one daily number, whether the spend came from chat or from reading a
  // document. Redis is what makes it one number across the two processes; the
  // in-memory fallback still enforces a ceiling rather than silently having none.
  //
  // ⚠ This is why extraction is metered at all. `BedrockExtractor` built its own
  // Bedrock client and answered to no budget, so `EXTRACTOR=bedrock` on staging
  // was unbounded model spend on a live environment.
  const aiBudget =
    env.INGEST_QUEUE === 'bullmq'
      ? RedisAiBudget.fromUrl(env.REDIS_URL, env.AI_DAILY_BUDGET_PENCE)
      : new InMemoryAiBudget(env.AI_DAILY_BUDGET_PENCE);
  // Extraction (METH Stage 4, real since Stage 15) — the step that moves a
  // document out of RECEIVED. Config-selected: `EXTRACTOR=demo` is fixture
  // profiles, `bedrock` actually reads the image. Logs through the worker's logger.
  const extractor = new PrismaExtractionStep(getPrismaClient(), selectExtractor(env, documentStore, aiBudget), {
    logger: { log: (message) => logger.log(message), warn: (message) => logger.warn(message) },
  });
  // Auto-close on inbound match (chase, METH Stage 8) — runs after extraction for
  // a routed document; closes an open chase whose transaction the document
  // matches, writes the chase event + the accountant's notification.
  const autoClose = new PrismaChaseAutoClose(getPrismaClient());

  // WhatsApp media (#79). This is the FIRST real call site for the four
  // config-selected seams below — `selectDocumentStore`, `selectImageNormaliser`,
  // `selectDocumentGuard` and the sharp hasher existed with nothing constructing
  // them, which is how a switch quietly stops being wired to anything.
  const media: MediaIntakeDeps = {
    fetcher: selectMediaFetcher(env),
    store: documentStore,
    perceptualHasher: createSharpPerceptualHasher(),
    imageNormaliser: selectImageNormaliser(env.IMAGE_NORMALISER),
    documentGuard: selectDocumentGuard(env.DOCUMENT_GUARD),
  };

  // Web + portal uploads (Stage A3). ⚠ THE SAME normaliser and guard the
  // WhatsApp path above gets — the two are built from the same selectors on the
  // same env, because "wire the same sanitisation" is the whole of this stage
  // and two differently-configured pipelines would be the bug in a new costume.
  // Until this existed, `imageNormaliser` and `documentGuard` were handed to the
  // WhatsApp media path ONLY, which is why an uploaded iPhone photo kept its
  // HEIC encoding and its GPS coordinates all the way into extraction.
  const uploadSanitiser = new PrismaUploadSanitisationStep(
    getPrismaClient(),
    {
      store: documentStore,
      perceptualHasher: createSharpPerceptualHasher(),
      imageNormaliser: selectImageNormaliser(env.IMAGE_NORMALISER),
      documentGuard: selectDocumentGuard(env.DOCUMENT_GUARD),
    },
    { logger: { log: (message) => logger.log(message), warn: (message) => logger.warn(message) } },
  );

  // Statement import (D40/D41). Shares `documentStore` with extraction — the
  // statement's bytes are the SAME object extraction already read, so a second
  // store would be a second answer to "where are this document's bytes".
  const statementLogger = { log: (message: string) => logger.log(message), warn: (message: string) => logger.warn(message) };
  const tableReader = selectTableReader(env, statementLogger);
  logger.log(`statement reader: ${env.STATEMENT_READER}`);
  const statements = new PrismaStatementStep(getPrismaClient(), documentStore, {
    logger: statementLogger,
    ...(tableReader === undefined ? {} : { tables: tableReader }),
  });

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
          uploadSanitiser,
          extractor,
          autoClose,
          statements,
          // Extraction claims the document into PROCESSING and is the only thing
          // that moves it out, so it has to know whether anyone will call it
          // again: with retries left a throw stays PROCESSING for the next
          // attempt, on the last one it becomes FAILED with a visible reason
          // rather than stranding the document (S5).
          //
          // ⚠ Mirrors BullMQ's OWN predicate, inverted. `Job.shouldRetryJob`
          // retries while `attemptsMade + 1 < opts.attempts` (bullmq@6.1.1), and
          // `attemptsMade` counts PREVIOUS attempts — it is 0 during the first
          // run. Writing the same arithmetic here rather than a guess at the
          // semantics is what keeps the off-by-one honest.
          finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
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
