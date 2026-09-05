import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { DuplicatesController } from './duplicates.controller.js';
import { DuplicatesService } from './duplicates.service.js';
import { DUPLICATES_SERVICE, PRISMA } from './tokens.js';

/**
 * The validation-dedupe Nest module — born with the module's FIRST controller
 * (review item 49's `GET /v1/duplicates`). Everything else this module owns is
 * deliberately not here: the state machine, readiness and the executors are
 * pure / scoped-client functions consumed through `index.ts` (the executors by
 * the Review → Approve engine's factory — never a Nest provider, so no
 * controller can reach one; the chase-module precedent).
 *
 * The Prisma client is the shared pooled one connecting as `nt_app`, so every
 * query still has to go through `scopedDb` to see anything at all.
 */
@Module({
  controllers: [DuplicatesController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    {
      provide: DUPLICATES_SERVICE,
      useFactory: (prisma: PrismaClient) => new DuplicatesService(prisma),
      inject: [PRISMA],
    },
  ],
})
export class ValidationDedupeModule {}
