import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { selectDocumentStore, type DocumentStore } from '../ingestion-routing/index.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { DOCUMENT_STORE, DOCUMENTS_SERVICE, PRISMA } from './tokens.js';

/**
 * The documents read surface (issue #77).
 *
 * The store is config-selected (`OBJECT_STORE`), never import-selected, so
 * `pnpm dev` and `pnpm test` run this lane against the in-memory fixture while
 * staging signs real S3 URLs through the same code.
 *
 * The Prisma client is the shared pooled one (Governance §5.1) and is *received*
 * by the service, never constructed inside it; it connects as `nt_app`, so every
 * query still has to go through `scopedDb` to see anything at all.
 */
@Module({
  controllers: [DocumentsController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    { provide: DOCUMENT_STORE, useFactory: (env: Env) => selectDocumentStore(env), inject: [ENV] },
    {
      provide: DOCUMENTS_SERVICE,
      useFactory: (prisma: PrismaClient, store: DocumentStore) => new DocumentsService(prisma, store),
      inject: [PRISMA, DOCUMENT_STORE],
    },
  ],
})
export class DocumentsModule {}
