import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { ChasesController } from './chases.controller.js';
import { ChasesService } from './chases.service.js';
import { selectSmsSender } from './select-sms-sender.js';
import { CHASES_SERVICE, PRISMA, SMS_SENDER } from './tokens.js';

/**
 * The chase domain module (SoT §4 Stage 8, METH Stage 8).
 *
 * Foundational: it exposes the domain providers Stage 8/9's later work composes
 * with. Today that is the config-selected `SmsSender` (`SMS_SENDER=demo`), the
 * one provider with a runtime dependency; the composition (`composeChaseSms`),
 * the portal-link token and the detection service are PURE / scoped-client
 * functions with no Nest lifecycle, exported through `index.ts` and used
 * directly (the executor and the portal endpoints call them), not injected.
 *
 * The SMS sender is config-selected, never import-selected, so `pnpm dev` and
 * `pnpm test` write the demo outbox while Twilio would drop in behind the same
 * seam in staging — the house pattern (`selectExtractor`, `selectDocumentStore`).
 *
 * The Prisma client is the shared pooled one, *received* by any future service,
 * never constructed inside it; it connects as `nt_app`, so every query still has
 * to go through `scopedDb` to see anything at all.
 *
 * The read surfaces (`GET /v1/chases`, `/chases/{id}`, `/sms-outbox`) ARE wired
 * here now (METH Stage 8): a thin `ChasesController` over a `ChasesService` that
 * projects `chases` / `chase_messages` / `sms_log` rows onto the contract shapes,
 * every query through `scopedDb`. They are `x-nt-side-effect: none` reads — no
 * Review → Approve, no write. The `chase.send` executor still lives in the #81
 * executor home (`validation-dedupe/proposals`) and is built by the Review →
 * Approve engine's factory, not here — an executor is never a Nest provider (it
 * must stay unreachable from a controller).
 */
@Module({
  controllers: [ChasesController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    { provide: SMS_SENDER, useFactory: (env: Env) => selectSmsSender(env), inject: [ENV] },
    {
      provide: CHASES_SERVICE,
      useFactory: (prisma: PrismaClient) => new ChasesService(prisma),
      inject: [PRISMA],
    },
  ],
  exports: [SMS_SENDER],
})
export class ChaseModule {}
