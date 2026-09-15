import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../../common/db/prisma.js';
import type { Env } from '../../../config/env.js';
import { ENV } from '../../../config/env.module.js';
import { LedgerConnectionsController } from './ledger-connections.controller.js';
import { LedgerConnectionsService } from './ledger-connections.service.js';
import { LEDGER_CONNECTIONS_SERVICE } from './tokens.js';

/**
 * The ledger connection surface as a composition unit (D50).
 *
 * ⚠ **Separate from `PublishingModule` on purpose.** That module exports
 * `LEDGER_ADAPTER` and is imported by `approvals.module.ts` to build the
 * executor registry; if the connection controller lived there, importing
 * publishing for the adapter would also mount a controller, and
 * `auth-tenancy/index.ts` records what that costs — a seam that drags a
 * controller which imports back out of the composition root kills boot with
 * *"Cannot access 'X' before initialization"*. Two modules, one directory, no
 * cycle.
 *
 * ⚠ **The service is not exported and must not be.** Nothing outside this
 * module creates or destroys a ledger connection except over HTTP, for exactly
 * the reason `PublishingModule` refuses to hand the adapter to its read
 * service: a second door onto an outward act is a door somebody eventually
 * walks through without the authority check.
 *
 * The Prisma client is the shared pooled one (Governance §5.1) and is RECEIVED
 * by the service, never constructed inside it; it connects as `nt_app`, so
 * every query still has to go through `scopedDb` to see anything at all.
 */
/** This module's own Prisma symbol — `tokens.ts`'s reasoning, one token per module. */
const PRISMA_TOKEN = Symbol('LEDGER_CONNECTIONS_PRISMA');

@Module({
  controllers: [LedgerConnectionsController],
  providers: [
    {
      provide: LEDGER_CONNECTIONS_SERVICE,
      useFactory: (prisma: PrismaClient, env: Env) => new LedgerConnectionsService(prisma, env),
      inject: [PRISMA_TOKEN, ENV],
    },
    { provide: PRISMA_TOKEN, useFactory: () => getPrismaClient() },
  ],
})
export class LedgerConnectionsModule {}
