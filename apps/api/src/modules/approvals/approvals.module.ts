import { Module } from '@nestjs/common';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { selectSmsSender } from '../chase/index.js';
import { analysisAccountChart, previewExportEntries } from '../exports-public-api/index.js';
import { PrismaDuplicateDetector } from '../ingestion-routing/index.js';
import { LEDGER_ADAPTER, type LedgerAdapter, previewPublishBatch, PublishingModule } from '../publishing/index.js';
import { ChartOfAccountsService } from '../rules-suggestions/index.js';
import { buildExecutorRegistry, type ExportEntryPreviewer, type PublishGateway } from '../validation-dedupe/index.js';
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
      useFactory: (prisma: PrismaClient, env: Env, ledger: LedgerAdapter) => {
        // ONE gateway object for both halves: the executor re-validates the
        // batch with it and the post-commit follow-up publishes through it.
        const publishing: PublishGateway = { ledger, previewPublishBatch };

        /**
         * The entry the accountant is authorising — **the export's own emitter,
         * over the export's own chart of accounts.**
         *
         * Two public seams meet here and nowhere else, which is this file's
         * whole job. `exports-public-api` owns what a VT row looks like;
         * `rules-suggestions` owns the chart, and `analysisAccount()` inside it
         * is the ONE place `Cost of sales: Purchases` is produced. Without the
         * chart the card would show a bare `SUBSCRIPTIONS` and an
         * `analysis-account-unprefixed` warning for a document the export file
         * will carry ledger-prefixed and unremarked — a review card raising an
         * alarm about a defect that no longer exists, which is how a reviewer
         * learns to skip the warnings that matter.
         *
         * ⚠ **It resolves against the batch's OWN client, in the executor's own
         * transaction** (`resolve` takes a `ScopedClient` for exactly this), so
         * the chart and the documents are one read at one moment. A batch with
         * no routed client resolves nothing; so does a chart that cannot be
         * read. Both degrade to the bare code plus the warning — the honest
         * failure — rather than to a refused release, because a picklist is not
         * worth blocking a month's books over.
         */
        const charts = new ChartOfAccountsService(prisma);
        const exportEntryPreview: ExportEntryPreviewer = async (db: ScopedClient, target, documents) => {
          const businessId = documents[0]?.businessId ?? null;
          if (businessId === null) return previewExportEntries(target, documents, null);
          try {
            const chart = await charts.resolve(db, businessId);
            return previewExportEntries(target, documents, analysisAccountChart(chart.categories));
          } catch {
            return previewExportEntries(target, documents, null);
          }
        };

        return new ActionProposalsService(
          prisma,
          // The chase.send executor "sends" through the config-selected sender
          // (SMS_SENDER=demo → the outbox writer; no Twilio) — built here, not
          // given a token, so no executor is reachable from a controller.
          buildExecutorRegistry({
            smsSender: selectSmsSender(env),
            publishing,
            exportEntryPreview,
          }),
          new PrismaDuplicateDetector(prisma),
          publishing,
          new InMemoryIdempotencyStore(),
          // chase.send composition at creation: the engine signs the portal
          // link into the reviewed body (compose-chase-send.ts has the story).
          { portalLinkSecret: env.PORTAL_LINK_SECRET, appOrigin: env.APP_ORIGIN },
          // The entry preview, from the EXPORT's own emitter (D42's sole
          // egress). Composed here rather than in the executor for the same
          // mechanical reason `previewPublishBatch` is: the composition root is
          // the only place allowed to know two public seams at once — and since
          // the chart of accounts joined it, that is three.
          exportEntryPreview,
        );
      },
      inject: [PRISMA, ENV, LEDGER_ADAPTER],
    },
  ],
})
export class ApprovalsModule {}
