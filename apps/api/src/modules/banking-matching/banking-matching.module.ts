import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { BankTransactionsController } from './bank-transactions.controller.js';
import { BankTransactionsService } from './bank-transactions.service.js';
import { StatementsController } from './statements.controller.js';
import { StatementsService } from './statements.service.js';
import { BANK_TRANSACTIONS_SERVICE, PRISMA } from './tokens.js';

/**
 * The banking read surface (METH Stage 11).
 *
 * The Prisma client is the shared pooled one (Governance §5.1) and is
 * *received* by the service, never constructed inside it; it connects as
 * `nt_app`, so every query still has to go through `scopedDb` to see anything
 * at all.
 *
 * No feed adapter is wired, and that is the honest state of the demo: the
 * transactions this serves are the seeded ones, presented as a connected feed.
 * // DEMO-MOCK: TrueLayer. The real implementation is a provider adapter
 * behind a config-selected `BankFeed` seam (the house interface + fixture +
 * real pattern), writing the same `bank_transactions` rows this reads —
 * SoT §4 Stage 7, not in METH's scope.
 */
@Module({
  controllers: [BankTransactionsController, StatementsController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    // The statements read (D40/D41). No token indirection: nothing swaps this
    // implementation, and a token for a single concrete class is ceremony.
    { provide: StatementsService, useFactory: (prisma: PrismaClient) => new StatementsService(prisma), inject: [PRISMA] },
    {
      provide: BANK_TRANSACTIONS_SERVICE,
      useFactory: (prisma: PrismaClient) => new BankTransactionsService(prisma),
      inject: [PRISMA],
    },
  ],
})
export class BankingMatchingModule {}
