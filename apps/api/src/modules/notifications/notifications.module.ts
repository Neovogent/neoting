import { Module } from '@nestjs/common';

import type { Env } from '../../config/env.js';
import { ENV } from '../../config/env.module.js';
import type { EmailRateLimiter } from './email-rate-limit.js';
import type { EmailSender } from './email-sender.js';
import { NotificationsService } from './notifications.service.js';
import { selectEmailRateLimiter, selectEmailSender } from './select-email-sender.js';
import { EMAIL_RATE_LIMITER, EMAIL_SENDER, NOTIFICATIONS_SERVICE } from './tokens.js';

/**
 * The notifications module (S2, SoT §4 Stage 8.8) — outbound transactional
 * email, and the first thing in this repository that sends any.
 *
 * **No controller, and that is not an omission.** Nothing in `openapi.yaml`
 * publishes a notifications endpoint, and `packages/contracts` is LAW (G7):
 * adding one is a contract-change issue, not a file. This module exists to be
 * INJECTED — by A1's practice signup, A11's client intake, A2's sign-in and
 * A14's chase-by-email, each of which owns its own contracted surface and calls
 * `NotificationsService` from it.
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
  providers: [
    { provide: EMAIL_SENDER, useFactory: (env: Env) => selectEmailSender(env), inject: [ENV] },
    { provide: EMAIL_RATE_LIMITER, useFactory: (env: Env) => selectEmailRateLimiter(env), inject: [ENV] },
    {
      provide: NOTIFICATIONS_SERVICE,
      useFactory: (sender: EmailSender, limiter: EmailRateLimiter) => new NotificationsService(sender, limiter),
      inject: [EMAIL_SENDER, EMAIL_RATE_LIMITER],
    },
  ],
  exports: [NOTIFICATIONS_SERVICE, EMAIL_SENDER],
})
export class NotificationsModule {}
