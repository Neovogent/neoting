import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../../common/db/prisma.js';
import type { Env } from '../../../config/env.js';
import { ENV } from '../../../config/env.module.js';
import { selectDocumentStore, type DocumentStore } from '../../ingestion-routing/index.js';

import { CapabilityLinkController } from './capability-link.controller.js';
import { CapabilityLinkService } from './capability-link.service.js';
import { DocumentLinkService } from './document-link.service.js';
import { type CapabilityLinkRateLimiter, selectCapabilityLinkRateLimiter } from './link-rate-limit.js';
import {
  CAPABILITY_LINK_SERVICE,
  DOCUMENT_LINK_SERVICE,
  DOCUMENT_STORE,
  LINK_RATE_LIMITER,
  PRISMA,
} from './tokens.js';

/**
 * The capability-URL lane (D43, stage A8): `GET /d/{code}` plus the minting
 * service A9's export calls.
 *
 * `DocumentLinkService` is exported rather than kept private because A9 needs
 * it — the export surface asks for a link per document and writes the pair into
 * the canonical rows. `CapabilityLinkService` is not exported: nothing but this
 * module's own controller should ever resolve a code, and a second caller would
 * be a second door onto an unauthenticated read.
 *
 * The store is config-selected (`OBJECT_STORE`), never import-selected, so
 * `pnpm dev` and `pnpm test` run this lane against the in-memory fixture while
 * staging signs real S3 URLs through the same code.
 */
@Module({
  controllers: [CapabilityLinkController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    { provide: DOCUMENT_STORE, useFactory: (env: Env) => selectDocumentStore(env), inject: [ENV] },
    {
      provide: LINK_RATE_LIMITER,
      /**
       * ⚠ **`EMAIL_RATE_LIMIT` is being read as "are rate limits shared across
       * processes?", which is not what it is named.**
       *
       * It is the only switch in `config/env.ts` that answers that question,
       * and the answer is the same for both surfaces: the API runs more than
       * one ECS task, so an in-process ceiling of 300 is 300 *per task* and the
       * numbers in `link-rate-limit.ts` become fiction. A dedicated
       * `CAPABILITY_LINK_RATE_LIMIT` key is the right fix and `config/env.ts`
       * is outside stage A8's owned paths — this line is where it attaches, and
       * the module's CLAUDE.md carries it as an open item.
       */
      useFactory: (env: Env) => selectCapabilityLinkRateLimiter(env.EMAIL_RATE_LIMIT === 'redis', env.REDIS_URL),
      inject: [ENV],
    },
    {
      provide: CAPABILITY_LINK_SERVICE,
      useFactory: (prisma: PrismaClient, store: DocumentStore, limiter: CapabilityLinkRateLimiter) =>
        new CapabilityLinkService(prisma, store, limiter),
      inject: [PRISMA, DOCUMENT_STORE, LINK_RATE_LIMITER],
    },
    {
      provide: DOCUMENT_LINK_SERVICE,
      useFactory: (prisma: PrismaClient) => new DocumentLinkService(prisma),
      inject: [PRISMA],
    },
  ],
  exports: [DOCUMENT_LINK_SERVICE],
})
export class CapabilityLinkModule {}
