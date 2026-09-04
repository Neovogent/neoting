import { Module } from '@nestjs/common';

import { getPrismaClient, type PrismaClient } from '../../common/db/prisma.js';
import { InMemoryIdempotencyStore, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import type { EmailRateLimiter } from './email-rate-limit.js';
import type { EmailSender } from './email-sender.js';
import { NotificationsInboxController } from './inbox.controller.js';
import { NotificationsInboxService } from './inbox.service.js';
import { NotificationsService } from './notifications.service.js';
import { selectEmailRateLimiter, selectEmailSender } from './select-email-sender.js';
import {
  EMAIL_RATE_LIMITER,
  EMAIL_SENDER,
  IDEMPOTENCY_STORE,
  NOTIFICATIONS_INBOX_SERVICE,
  NOTIFICATIONS_SERVICE,
  PRISMA,
} from './tokens.js';

/**
 * The notifications module (S2, SoT §4 Stage 8.8) — outbound transactional
 * email, and the first thing in this repository that sends any.
 *
 * **One controller since 5 Sep 2026 (review item 12), and only because the
 * contract moved first.** The long-standing "No controller" rule here was
 * conditional on `openapi.yaml` publishing no notifications endpoint; it now
 * publishes two (`listNotifications`, `markNotificationsRead` — the in-app
 * inbox the bell reads), so `NotificationsInboxController` exists. The OUTBOUND
 * half is unchanged: `NotificationsService` still exists to be INJECTED — by
 * A1's practice signup, A11's client intake, A2's sign-in and A14's
 * chase-by-email, each of which owns its own contracted surface — and still
 * writes nothing to the database. The inbox half READS the `notifications`
 * table (and is `readAt`'s first writer); the two halves share a module because
 * they share a name and a domain, not a code path.
 *
 * It is registered in `app.module.ts` today, before any of those consumers
 * exist, deliberately: a provider graph that is only assembled when its first
 * consumer lands is a provider graph whose wiring bugs are found by that
 * consumer's author. Booting it now means `EMAIL_SENDER=ses` is proven to
 * construct — credentials, region, configuration set and all — by the deploy
 * rather than by the first client invite.
 *
 * **No Prisma client, and that is not an omission either.** This module writes
 * nothing. There is no email-outbox table and adding one is `prisma/`, which is
 * LAW and not in the S0 batch — see the long note on `EmailSender` for why the
 * constraint turned out to be the right shape: the durable record of why a
 * message was sent already belongs to the caller (`invites`, `otp_sessions`,
 * `chases`), and a transport-owned second copy would be a second opinion about
 * what was sent.
 *
 * Both providers are **config-selected, never import-selected** — the house
 * pattern (`selectExtractor`, `selectSmsSender`, `selectDocumentStore`). So
 * `pnpm dev` and `pnpm test` run the identical composition, rate-limit and
 * envelope path against an in-memory outbox, while staging sends through SES
 * with no call site changed.
 */
@Module({
  controllers: [NotificationsInboxController],
  providers: [
    { provide: EMAIL_SENDER, useFactory: (env: Env) => selectEmailSender(env), inject: [ENV] },
    { provide: EMAIL_RATE_LIMITER, useFactory: (env: Env) => selectEmailRateLimiter(env), inject: [ENV] },
    {
      provide: NOTIFICATIONS_SERVICE,
      useFactory: (sender: EmailSender, limiter: EmailRateLimiter) => new NotificationsService(sender, limiter),
      inject: [EMAIL_SENDER, EMAIL_RATE_LIMITER],
    },
    // The inbox half (review item 12). The Prisma client is the shared pooled
    // one, received never constructed; the replay store is the process-wide
    // in-memory one every other ingest-class mutation uses (not durable — that
    // follow-up is shared with them, and the writes are natively idempotent).
    { provide: PRISMA, useFactory: () => getPrismaClient() },
    { provide: IDEMPOTENCY_STORE, useFactory: () => new InMemoryIdempotencyStore() },
    {
      provide: NOTIFICATIONS_INBOX_SERVICE,
      useFactory: (prisma: PrismaClient, idempotency: IdempotencyStore) =>
        new NotificationsInboxService(prisma, idempotency),
      inject: [PRISMA, IDEMPOTENCY_STORE],
    },
  ],
  exports: [NOTIFICATIONS_SERVICE, EMAIL_SENDER],
})
export class NotificationsModule {}
