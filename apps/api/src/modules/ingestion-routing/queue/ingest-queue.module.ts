import { Module } from '@nestjs/common';

import type { Env } from '../../../config/env.js';
import { ENV } from '../../../config/env.module.js';
import { INGEST_QUEUE } from '../webhooks/whatsapp/tokens.js';
import { selectIngestQueue } from './select-ingest-queue.js';

/**
 * The ONE ingest-queue producer for the API process, provided and exported so
 * every inbound lane shares it (#76 added the second: web upload alongside the
 * WhatsApp webhook).
 *
 * Nest providers are per-module, so declaring the factory in each lane's own
 * module would build a `BullmqIngestQueue` per lane and therefore a Redis
 * connection per lane — invisible while `INGEST_QUEUE=fixture`, and a growing
 * connection count the moment it is not. Selection stays config-driven
 * (`INGEST_QUEUE=fixture|bullmq`), never import-driven.
 */
@Module({
  providers: [{ provide: INGEST_QUEUE, useFactory: (env: Env) => selectIngestQueue(env), inject: [ENV] }],
  exports: [INGEST_QUEUE],
})
export class IngestQueueModule {}
