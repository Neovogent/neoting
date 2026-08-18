import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { PrismaDuplicateDetector } from '../ingestion-routing/index.js';
import { buildExecutorRegistry } from '../validation-dedupe/index.js';
import { ActionProposalsController } from './action-proposals.controller.js';
import { ActionProposalsService } from './action-proposals.service.js';
import { ACTION_PROPOSALS_SERVICE, PRISMA } from './tokens.js';

/**
 * The Review → Approve engine module (METH S3, issue #122).
 *
 * The executor registry and the dedupe detector are built INSIDE the service
 * factory and never given tokens — the seam the registry's own comment
 * describes: no executor is reachable from a controller, because nothing
 * injectable ever names one. executors.test.ts pins the import half of that;
 * keeping these out of the providers list is this module's half.
 *
 * Both collaborators come through their modules' public seams
 * (`validation-dedupe/index.ts`, `ingestion-routing/index.ts`), so the lane
 * map holds: the engine composes modules, it does not reach into them.
 *
 * The idempotency store is the shared in-memory implementation — per-process,
 * same honest limitation as web-upload's, same durable-store follow-up.
 */
@Module({
  controllers: [ActionProposalsController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    {
      provide: ACTION_PROPOSALS_SERVICE,
      useFactory: (prisma: PrismaClient) =>
        new ActionProposalsService(prisma, buildExecutorRegistry(), new PrismaDuplicateDetector(prisma), new InMemoryIdempotencyStore()),
      inject: [PRISMA],
    },
  ],
})
export class ApprovalsModule {}
