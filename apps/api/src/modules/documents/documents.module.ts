import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { InMemoryIdempotencyStore, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { selectDocumentStore, type DocumentStore } from '../ingestion-routing/index.js';
import { PortalModule } from '../portal/index.js';
import { DocumentManagementController } from './document-management.controller.js';
import { DocumentManagementService } from './document-management.service.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import {
  DOCUMENT_MANAGEMENT_SERVICE,
  DOCUMENT_STORE,
  DOCUMENTS_SERVICE,
  IDEMPOTENCY_STORE,
  PRISMA,
} from './tokens.js';

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
  // `getDocumentOriginal` accepts the portal bearer beside the workspace cookie
  // (`openapi.yaml`, 2 Sep 2026), so the controller needs
  // `PORTAL_SESSION_CONTEXT`. One-way: `PortalModule` does not import this one,
  // so there is no Nest cycle.
  imports: [PortalModule],
  // Two controllers on one path prefix. Order is not load-bearing here and
  // deliberately so: `DocumentManagementController` publishes only POSTs with a
  // literal final segment, and the one route where ordering WOULD matter —
  // `GET /documents/counts` versus `GET /documents/{documentId}` — is inside
  // `DocumentsController`, where declaration order settles it.
  controllers: [DocumentsController, DocumentManagementController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    { provide: DOCUMENT_STORE, useFactory: (env: Env) => selectDocumentStore(env), inject: [ENV] },
    // The process-wide in-memory store, the same one web-upload and the
    // proposal engine use. Not durable — that follow-up is shared with them —
    // and it is not what makes these two operations idempotent: the row-level
    // compare-and-swap is. See `DocumentManagementService#replayed`.
    { provide: IDEMPOTENCY_STORE, useFactory: () => new InMemoryIdempotencyStore() },
    {
      provide: DOCUMENTS_SERVICE,
      useFactory: (prisma: PrismaClient, store: DocumentStore) => new DocumentsService(prisma, store),
      inject: [PRISMA, DOCUMENT_STORE],
    },
    {
      provide: DOCUMENT_MANAGEMENT_SERVICE,
      useFactory: (prisma: PrismaClient, idempotency: IdempotencyStore) =>
        new DocumentManagementService(prisma, idempotency),
      inject: [PRISMA, IDEMPOTENCY_STORE],
    },
  ],
})
export class DocumentsModule {}
