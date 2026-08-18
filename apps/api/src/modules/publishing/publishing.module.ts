import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { PublishesController } from './publishes.controller.js';
import { PublishesService } from './publishes.service.js';
import { selectLedgerAdapter } from './select-ledger-adapter.js';
import { LEDGER_ADAPTER, PRISMA, PUBLISHES_SERVICE } from './tokens.js';

/**
 * The publishing module (METH Stage 10).
 *
 * Two things, and they never meet. The **ledger adapter** is config-selected
 * (`LEDGER_ADAPTER`), never import-selected, so `pnpm dev` and `pnpm test` run
 * this lane against the deterministic demo ledger through the same code a real
 * Xero connection will use. The **read surface** (`GET /v1/publishes`) is one
 * controller over one service that only reads.
 *
 * ⚠ `PublishesService` is deliberately NOT given the adapter. A read surface
 * that could reach a ledger is a side-effect path outside Review → Approve
 * (Governance §10) waiting to be written, and the cheapest way to make that
 * impossible is for the dependency not to exist. Publishing is a
 * `publish.batch` proposal; retry is a NEW proposal over the failed item.
 *
 * `LEDGER_ADAPTER` is EXPORTED because the Review → Approve engine is its
 * first consumer: `approvals.module.ts` builds the executor registry in its own
 * `useFactory`, and the `publish.batch` executor needs an adapter handed to it.
 * That import crosses a module boundary, so it goes through `index.ts` like
 * every other cross-module name. The service and its token are NOT exported —
 * nothing outside this module lists publishes except over HTTP.
 *
 * The Prisma client is the shared pooled one (Governance §5.1) and is
 * *received* by the service, never constructed inside it; it connects as
 * `nt_app`, so every query still has to go through `scopedDb` to see anything
 * at all.
 */
@Module({
  controllers: [PublishesController],
  providers: [
    { provide: LEDGER_ADAPTER, useFactory: (env: Env) => selectLedgerAdapter(env), inject: [ENV] },
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    {
      provide: PUBLISHES_SERVICE,
      useFactory: (prisma: PrismaClient) => new PublishesService(prisma),
      inject: [PRISMA],
    },
  ],
  exports: [LEDGER_ADAPTER],
})
export class PublishingModule {}
