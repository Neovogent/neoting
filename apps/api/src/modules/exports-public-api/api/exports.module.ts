import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../../common/db/prisma.js';
import { InMemoryIdempotencyStore, type IdempotencyStore } from '../../../common/idempotency/idempotency-store.js';
import type { Env } from '../../../config/env.js';
import { ENV } from '../../../config/env.module.js';
import { selectDocumentStore, type DocumentStore } from '../../ingestion-routing/index.js';
import { CHART_OF_ACCOUNTS_SERVICE, type ChartOfAccountsService, RulesSuggestionsModule } from '../../rules-suggestions/index.js';
import { CapabilityLinkModule } from '../links/capability-link.module.js';
import type { DocumentLinkService } from '../links/document-link.service.js';
import { DOCUMENT_LINK_SERVICE } from '../links/tokens.js';

import { ExportsController } from './exports.controller.js';
import { ExportsService } from './exports.service.js';
import { DOCUMENT_STORE, EXPORTS_SERVICE, IDEMPOTENCY_STORE, PRISMA } from './tokens.js';

/**
 * The export surface (D42, stage A9): `GET`+`POST /v1/exports`.
 *
 * It imports `CapabilityLinkModule` rather than constructing a second
 * `DocumentLinkService`, and that is not tidiness. The minter reuses a
 * document's live link instead of issuing a new one — *"the same document
 * re-exported next month must carry the SAME code, or the accountant's saved VT
 * conversion table stops matching and every import goes manual again"* — so two
 * instances would be two things holding one invariant, and the failure would
 * surface as a customer's import going manual, months later.
 *
 * The store is config-selected (`OBJECT_STORE`), never import-selected, so
 * `pnpm dev` and `pnpm test` run this lane against the in-memory fixture while
 * staging signs real S3 URLs through the same code.
 *
 * ⚠ The idempotency store is `InMemory`, per-process, and there is no durable
 * one anywhere in this repo yet (`common/idempotency/idempotency-store.ts` says
 * so, and there is no table because `prisma/` is LAW). Behind more than one API
 * task a replayed key can therefore land on a task that never saw it and
 * generate the file a second time. That fails in the safe direction here —
 * generating an export twice writes a second `exports` row and changes no
 * document state — which is exactly why this surface can live with the gap that
 * a publish could not.
 *
 * **`RulesSuggestionsModule` is imported for the CHART OF ACCOUNTS** (2 Sep
 * 2026), through `rules-suggestions/index.ts` and nothing deeper — the seam that
 * module's own header names this consumer on. It is what turns
 * `documents.category_code` into the ledger-prefixed `Analysis account` the VT
 * import needs; before it, the file carried a bare `SUBSCRIPTIONS` and VT
 * type-guessed the cell. It is injected HERE rather than constructed, for the
 * same reason `DocumentLinkService` is: one instance, one chart, one seeding
 * path (`getChartOfAccounts` writes the client's chart on first read and never
 * overwrites it) — two would be two things holding one invariant.
 */
@Module({
  imports: [CapabilityLinkModule, RulesSuggestionsModule],
  controllers: [ExportsController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    { provide: DOCUMENT_STORE, useFactory: (env: Env) => selectDocumentStore(env), inject: [ENV] },
    { provide: IDEMPOTENCY_STORE, useFactory: () => new InMemoryIdempotencyStore() },
    {
      provide: EXPORTS_SERVICE,
      useFactory: (
        prisma: PrismaClient,
        store: DocumentStore,
        links: DocumentLinkService,
        idempotency: IdempotencyStore,
        charts: ChartOfAccountsService,
      ) => new ExportsService(prisma, store, links, idempotency, undefined, charts),
      inject: [PRISMA, DOCUMENT_STORE, DOCUMENT_LINK_SERVICE, IDEMPOTENCY_STORE, CHART_OF_ACCOUNTS_SERVICE],
    },
  ],
})
export class ExportsApiModule {}
