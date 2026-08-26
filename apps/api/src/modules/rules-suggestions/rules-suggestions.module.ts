import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { ChartOfAccountsService } from './chart-of-accounts/chart-of-accounts.service.js';
import { SupplierCodingService } from './coding/supplier-coding.service.js';
import { CHART_OF_ACCOUNTS_SERVICE, PRISMA, SUPPLIER_CODING_SERVICE } from './tokens.js';

/**
 * The chart of accounts and the coding ladder (A6).
 *
 * ## No controller, and that is the finding rather than an omission
 *
 * **The S0 contract publishes no rules or chart-of-accounts endpoints.** There
 * is no `GET /businesses/{id}/accounts`, no `/rules`, no `/suggestions` — the
 * whole path list is in `openapi.yaml` and none of them are there. Inventing
 * public API is a contract change approved before a PR opens (G7), not a
 * stage's decision, so this module ships as **providers only**, exactly as A11
 * shipped its settings surface and A7 shipped its emitter.
 *
 * That is not the same as shipping nothing usable. The chart is written into
 * `reference_syncs`, which `chat-framework` already reads, so the accountant-
 * facing half of A6 works through a surface that exists today.
 *
 * ## What it imports, and what it deliberately does not
 *
 * Nothing. `clients-team-settings/index.ts` is consumed for two **pure
 * functions** (`readBusinessProfile`, `BusinessTypeProfile`) which need no
 * provider, so importing the whole module for them would create a module
 * dependency with no runtime reason to exist. The Prisma client is the shared
 * pooled one (Governance §5.1), received by each service rather than
 * constructed inside it; it connects as `nt_app`, so every query still has to
 * go through `scopedDb` to see anything at all.
 */
@Module({
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    {
      provide: CHART_OF_ACCOUNTS_SERVICE,
      useFactory: (prisma: PrismaClient) => new ChartOfAccountsService(prisma),
      inject: [PRISMA],
    },
    {
      provide: SUPPLIER_CODING_SERVICE,
      useFactory: (prisma: PrismaClient, charts: ChartOfAccountsService) => new SupplierCodingService(prisma, charts),
      inject: [PRISMA, CHART_OF_ACCOUNTS_SERVICE],
    },
  ],
  exports: [CHART_OF_ACCOUNTS_SERVICE, SUPPLIER_CODING_SERVICE],
})
export class RulesSuggestionsModule {}
