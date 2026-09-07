import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { type IdempotencyStore, InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { TasksController, TeamsController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';
import { TeamsService } from './teams.service.js';
import { IDEMPOTENCY_STORE, PRISMA, TASKS_SERVICE, TEAMS_SERVICE } from './tokens.js';

/**
 * The practice's checklist and the firm's org chart (review item 54).
 *
 * A module of its own rather than two more services inside
 * `clients-team-settings`, for one reason worth the file: that module already
 * holds a `TeamService` (a CLIENT's people) and a `PracticeTeamService` (the
 * firm's colleagues), and a third thing called "team" beside them is the setup
 * where the wrong one gets injected and nobody notices for a week.
 *
 * Both services take the shared pooled Prisma client (Governance §5.1),
 * *received* rather than constructed, connecting as `nt_app` — so every query
 * still has to go through `scopedDb` to see anything at all.
 *
 * No `NotificationsModule` import: the assignment notice is a `notifications`
 * ROW for item 12's bell, written through the same scoped client as the task,
 * not an email. `NotificationsService` is the outbound-email seam and nothing
 * here sends anything.
 */
@Module({
  controllers: [TasksController, TeamsController],
  providers: [
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    // ⚠ Its own store instance, like every other consumer of the in-memory one.
    // The namespaces are disjoint by caller-chosen key, so sharing would be
    // safe — but the durable-store follow-up is one change for all of them, and
    // a shared instance today would make it look like two.
    { provide: IDEMPOTENCY_STORE, useFactory: (): IdempotencyStore => new InMemoryIdempotencyStore() },
    {
      provide: TASKS_SERVICE,
      useFactory: (prisma: PrismaClient, idempotency: IdempotencyStore) => new TasksService(prisma, idempotency),
      inject: [PRISMA, IDEMPOTENCY_STORE],
    },
    {
      provide: TEAMS_SERVICE,
      useFactory: (prisma: PrismaClient, idempotency: IdempotencyStore) => new TeamsService(prisma, idempotency),
      inject: [PRISMA, IDEMPOTENCY_STORE],
    },
  ],
  exports: [TASKS_SERVICE, TEAMS_SERVICE],
})
export class TasksModule {}
