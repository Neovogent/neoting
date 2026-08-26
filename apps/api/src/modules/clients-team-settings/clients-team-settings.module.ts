import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { type IdempotencyStore, InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { NotificationsModule, NOTIFICATIONS_SERVICE, type NotificationsService } from '../notifications/index.js';
import { ClientIntakeService } from './client-intake.service.js';
import { ClientsTeamSettingsController } from './clients-team-settings.controller.js';
import { DEFAULT_APP_ORIGIN } from './setup-link.js';
import { TeamService } from './team.service.js';
import { CLIENT_INTAKE_SERVICE, IDEMPOTENCY_STORE, PRISMA, TEAM_SERVICE } from './tokens.js';

/**
 * Client intake, the client's team, and the settings shell (A11).
 *
 * `NotificationsModule` is imported for one provider — `NOTIFICATIONS_SERVICE`,
 * the seam every outbound email in the product goes through. Injected, never
 * constructed: the transport and the rate limiter are config-selected, and a
 * hand-built `NotificationsService` is one that quietly ignores `EMAIL_SENDER`.
 *
 * The Prisma client is the shared pooled one (Governance §5.1) and is *received*
 * by each service, never constructed inside it; it connects as `nt_app`, so
 * every query still has to go through `scopedDb` to see anything at all.
 *
 * ⚠ `appOrigin` is a **constant**, not configuration, because `config/env.ts`
 * carries no public web origin and `config/` is not this stage's to change. It
 * is passed in here so promoting it to an environment variable is one line —
 * see `setup-link.ts`.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [ClientsTeamSettingsController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    { provide: IDEMPOTENCY_STORE, useFactory: (): IdempotencyStore => new InMemoryIdempotencyStore() },
    {
      provide: CLIENT_INTAKE_SERVICE,
      useFactory: (prisma: PrismaClient, notifications: NotificationsService, idempotency: IdempotencyStore) =>
        new ClientIntakeService(prisma, notifications, idempotency, { appOrigin: DEFAULT_APP_ORIGIN }),
      inject: [PRISMA, NOTIFICATIONS_SERVICE, IDEMPOTENCY_STORE],
    },
    {
      provide: TEAM_SERVICE,
      useFactory: (prisma: PrismaClient, notifications: NotificationsService, idempotency: IdempotencyStore) =>
        new TeamService(prisma, notifications, idempotency, { appOrigin: DEFAULT_APP_ORIGIN }),
      inject: [PRISMA, NOTIFICATIONS_SERVICE, IDEMPOTENCY_STORE],
    },
  ],
  exports: [CLIENT_INTAKE_SERVICE, TEAM_SERVICE],
})
export class ClientsTeamSettingsModule {}
