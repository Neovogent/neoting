import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { PrismaDuplicateDetector } from '../ingestion-routing/index.js';
import { LEDGER_ADAPTER, type LedgerAdapter, previewPublishBatch, PublishingModule } from '../publishing/index.js';
import { buildExecutorRegistry, type PublishGateway } from '../validation-dedupe/index.js';
import { ActionProposalsController } from './action-proposals.controller.js';
import { ActionProposalsService } from './action-proposals.service.js';
import { ACTION_PROPOSALS_SERVICE, PRISMA } from './tokens.js';

/**
 * The Review → Approve engine module (METH S3, issue #122).
 *
 * The executor registry, the dedupe detector and the publishing gateway are
 * built INSIDE the service factory and never given tokens — the seam the
 * registry's own comment describes: no executor is reachable from a
 * controller, because nothing injectable ever names one. executors.test.ts
 * pins the import half of that; keeping these out of the providers list is
 * this module's half.
 *
 * Every collaborator comes through its module's public seam
 * (`validation-dedupe/index.ts`, `ingestion-routing/index.ts`,
 * `publishing/index.ts`), so the lane map holds: the engine composes modules,
 * it does not reach into them.
 *
 * **Why publishing arrives in two pieces** (METH S10). The `LedgerAdapter` is
 * config-selected — `LEDGER_ADAPTER=demo` today, the real Xero client later —
 * so it must come through DI, which is why `PublishingModule` is imported at
 * all. `previewPublishBatch` is a pure function of three integers with no
 * configuration to choose, so it is imported. Both are handed to the
 * `publish.batch` executor as ONE `PublishGateway` rather than imported by it:
 * publishing imports validation-dedupe (the publish minimum IS the readiness
 * rule), so a runtime import back would close a cycle between two public
 * seams. The composition root is the place that is allowed to know both.
 *
 * The idempotency store is the shared in-memory implementation — per-process,
 * same honest limitation as web-upload's, same durable-store follow-up.
 */
@Module({
  imports: [PublishingModule],
  controllers: [ActionProposalsController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    {
      provide: ACTION_PROPOSALS_SERVICE,
      useFactory: (prisma: PrismaClient, ledger: LedgerAdapter) => {
        // ONE gateway object for both halves: the executor re-validates the
        // batch with it and the post-commit follow-up publishes through it.
        const publishing: PublishGateway = { ledger, previewPublishBatch };
        return new ActionProposalsService(
          prisma,
          buildExecutorRegistry({ publishing }),
          new PrismaDuplicateDetector(prisma),
          publishing,
          new InMemoryIdempotencyStore(),
        );
      },
      inject: [PRISMA, LEDGER_ADAPTER],
    },
  ],
})
export class ApprovalsModule {}
