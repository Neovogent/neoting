import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../../common/db/prisma.js';
import type { Env } from '../../../config/env.js';
import { ENV } from '../../../config/env.module.js';
import { IngestQueueModule } from '../queue/ingest-queue.module.js';
import { INGEST_QUEUE } from '../webhooks/whatsapp/tokens.js';
import type { IngestQueue } from '../webhooks/whatsapp/ingest-queue.js';
import { type DocumentStore } from '../storage/document-store.js';
import { selectDocumentStore } from '../storage/select-document-store.js';
import { type IdempotencyStore, InMemoryIdempotencyStore } from './idempotency-store.js';
import { DOCUMENT_STORE, IDEMPOTENCY_STORE, PRISMA, WEB_UPLOAD_SERVICE } from './tokens.js';
import { WebUploadController } from './web-upload.controller.js';
import { WebUploadService } from './web-upload.service.js';

/**
 * Web upload (issue #76). Everything the service touches is config-selected, not
 * import-selected — `OBJECT_STORE` picks MinIO/S3 or the in-memory fixture, and
 * `INGEST_QUEUE` picks BullMQ or the fixture — so `pnpm dev` and `pnpm test` run
 * this lane offline while staging runs the real thing through the same code.
 *
 * The Prisma client is the shared pooled one (Governance §5.1) and is *received*
 * by the service, never constructed inside it; it connects as `nt_app`, so every
 * query still has to go through `scopedDb`.
 */
@Module({
  imports: [IngestQueueModule],
  controllers: [WebUploadController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    { provide: DOCUMENT_STORE, useFactory: (env: Env) => selectDocumentStore(env), inject: [ENV] },
    { provide: IDEMPOTENCY_STORE, useFactory: (): IdempotencyStore => new InMemoryIdempotencyStore() },
    {
      provide: WEB_UPLOAD_SERVICE,
      useFactory: (
        prisma: PrismaClient,
        store: DocumentStore,
        queue: IngestQueue,
        idempotency: IdempotencyStore,
        env: Env,
      ) =>
        new WebUploadService(prisma, store, queue, idempotency, {
          uploadSecret: env.UPLOAD_URL_SECRET,
          uploadTtlSeconds: env.UPLOAD_URL_TTL_SECONDS,
        }),
      inject: [PRISMA, DOCUMENT_STORE, INGEST_QUEUE, IDEMPOTENCY_STORE, ENV],
    },
  ],
})
export class WebUploadModule {}
