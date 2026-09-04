import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { type IdempotencyStore, InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import { createAwsSmsTransport } from '../chase/index.js';
import { NotificationsModule, NOTIFICATIONS_SERVICE, type NotificationsService } from '../notifications/index.js';
import { ClientIntakeService } from './client-intake.service.js';
import { ClientsTeamSettingsController } from './clients-team-settings.controller.js';
import { PracticeMembersController } from './practice-members.controller.js';
import { PracticeTeamService } from './practice-team.service.js';
import { TeamService } from './team.service.js';
import { CLIENT_INTAKE_SERVICE, IDEMPOTENCY_STORE, PRACTICE_TEAM_SERVICE, PRISMA, TEAM_SERVICE } from './tokens.js';

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
 * ✅ `appOrigin` is **`env.APP_ORIGIN`** as of the practice-invite work — the
 * one line `setup-link.ts` predicted. It was a constant standing in for a key
 * `config/env.ts` did not have; the key exists (the chase lane added it), so the
 * three link builders in this app now agree with the origin the task definition
 * actually sets instead of with a literal that could silently disagree with it.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [ClientsTeamSettingsController, PracticeMembersController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    { provide: IDEMPOTENCY_STORE, useFactory: (): IdempotencyStore => new InMemoryIdempotencyStore() },
    {
      provide: CLIENT_INTAKE_SERVICE,
      useFactory: (prisma: PrismaClient, notifications: NotificationsService, idempotency: IdempotencyStore, env: Env) =>
        new ClientIntakeService(
          prisma,
          notifications,
          idempotency,
          { appOrigin: env.APP_ORIGIN },
          undefined,
          // The registration SMS (finding 3, 4 Sep 2026) — the REAL wire only.
          // Under demo/email the invite travels by email alone; the day carrier
          // registration clears, the SMS_SENDER=aws flip turns this on with no
          // code change (invite-sms.ts carries the argument).
          env.SMS_SENDER === 'aws'
            ? createAwsSmsTransport({ region: env.SMS_REGION, originationIdentity: env.SMS_ORIGINATION_IDENTITY })
            : undefined,
        ),
      inject: [PRISMA, NOTIFICATIONS_SERVICE, IDEMPOTENCY_STORE, ENV],
    },
    {
      provide: TEAM_SERVICE,
      useFactory: (prisma: PrismaClient, notifications: NotificationsService, idempotency: IdempotencyStore, env: Env) =>
        new TeamService(prisma, notifications, idempotency, { appOrigin: env.APP_ORIGIN }),
      inject: [PRISMA, NOTIFICATIONS_SERVICE, IDEMPOTENCY_STORE, ENV],
    },
    {
      // ⚠ Its own idempotency store instance, like every other consumer of the
      // in-memory one. The namespaces are disjoint by prefix
      // (`practice-members:` vs `business-members:`), so sharing would be safe —
      // but the durable-store follow-up is one change for all of them, and a
      // shared instance today would make it look like two.
      provide: PRACTICE_TEAM_SERVICE,
      useFactory: (prisma: PrismaClient, notifications: NotificationsService, idempotency: IdempotencyStore, env: Env) =>
        new PracticeTeamService(prisma, notifications, idempotency, { appOrigin: env.APP_ORIGIN }),
      inject: [PRISMA, NOTIFICATIONS_SERVICE, IDEMPOTENCY_STORE, ENV],
    },
  ],
  exports: [CLIENT_INTAKE_SERVICE, PRACTICE_TEAM_SERVICE, TEAM_SERVICE],
})
export class ClientsTeamSettingsModule {}
