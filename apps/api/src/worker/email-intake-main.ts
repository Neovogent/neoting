import 'reflect-metadata';

import { Logger } from '@nestjs/common';

import { loadEnv } from '../config/env.js';
import { drainEmailSource } from '../modules/ingestion-routing/email/inbound/email-intake-runner.js';
import { selectEmailSource } from '../modules/ingestion-routing/email/inbound/select-email-source.js';
import { PostalMimeEmailParser } from '../modules/ingestion-routing/email/postal-mime-email-parser.js';
import { createSharpPerceptualHasher } from '../modules/ingestion-routing/lib/dedupe/perceptual-hash.js';
import { selectDocumentGuard, selectImageNormaliser } from '../modules/ingestion-routing/lib/sanitisation/index.js';
import { selectIngestQueue } from '../modules/ingestion-routing/queue/select-ingest-queue.js';
import { selectDocumentStore } from '../modules/ingestion-routing/storage/select-document-store.js';

/**
 * The inbound-email poller — a SEPARATE process from the API and the ingest
 * worker (issue #78). It polls the configured `EmailSource` (MailHog on a laptop,
 * the SES receipt prefix in staging, a fixture in tests), runs each raw email
 * through the finished `processEmail` lane, and acks only the ones it handled.
 *
 * Everything hostile is behind a boundary: the MIME parser, the sanitisation
 * pipeline, and — via the runner — the trace context the enqueued jobs inherit.
 * A per-email failure costs one email; a poll failure is logged and retried on
 * the next tick, never crashing the loop.
 */
const POLL_INTERVAL_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = new Logger('email-intake');
  const source = selectEmailSource(env);

  const deps = {
    parser: new PostalMimeEmailParser(),
    queue: selectIngestQueue(env),
    logger: { log: (message: string) => logger.log(message), warn: (message: string) => logger.warn(message) },
    store: selectDocumentStore(env),
    imageNormaliser: selectImageNormaliser(env.IMAGE_NORMALISER),
    documentGuard: selectDocumentGuard(env.DOCUMENT_GUARD),
    perceptualHasher: createSharpPerceptualHasher(),
    // Warned-once set persists across polls, so a stuck email does not re-warn.
    warned: new Set<string>(),
  };

  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  logger.log(`email intake poller starting (source=${env.EMAIL_SOURCE}, interval=${POLL_INTERVAL_MS}ms)`);
  while (running) {
    try {
      const summary = await drainEmailSource(source, deps);
      if (summary.processed + summary.unresolved + summary.failed > 0) {
        logger.log(
          `drained: ${summary.processed} processed, ${summary.unresolved} unresolved, ${summary.failed} failed`,
        );
      }
    } catch (error) {
      logger.error(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  logger.log('email intake poller stopped');
}

void bootstrap();
