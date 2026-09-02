import type { Env } from '../../config/env.js';
import { type EmailRateLimiter, InMemoryEmailRateLimiter, RedisEmailRateLimiter } from './email-rate-limit.js';
import { DemoEmailSender, type EmailSender } from './email-sender.js';
import { SesEmailSender } from './ses-email-sender.js';
import { SmtpEmailSender } from './smtp-email-sender.js';

/**
 * Pick the email sender from config — never by import, the house pattern shared
 * with `selectExtractor` / `selectSmsSender` / `selectDocumentStore` /
 * `selectIngestQueue`.
 *
 *   demo  `DemoEmailSender` — sends into an in-memory outbox. The default, so a
 *         fresh clone, CI and any laptop without AWS credentials run the whole
 *         journey offline.
 *   ses   `SesEmailSender` — the real thing. Amazon SES v2, eu-west-2, IAM via
 *         the task role, the domain identity and configuration set that
 *         `infra/envs/staging/email.tf` has had in place since 17 Aug 2026.
 *
 * ⚠ **`demo` REFUSES TO BOOT under `NODE_ENV=production`** (`config/env.ts`).
 * Unlike most switches in this file's family, the demo failure here is
 * invisible from every screen: the invite is "sent", the sign-in code is
 * "sent", the chase is "sent", each call returns a message id, and no email
 * exists. A client simply never hears from us and there is nothing to look at.
 * That is the same class of wrong as `AI_CHAT=demo` — degrading something that
 * looks identical either way — which is why it gets the same treatment.
 *
 * ⚠ **There is no fallback from `ses` to `demo`, and there must not be one.**
 * `select-extractor.ts` carries the long version of why, paid for on 25 Aug
 * 2026: a wrapper that catches a throw and answers with fixture data turns a
 * transient failure into a silent, confident lie. The email equivalent —
 * catching an SES throttle and writing to the in-memory outbox instead — would
 * report a delivered sign-in code that no human will ever receive. A failed
 * send is a failed send, and the caller decides what that means.
 */
export function selectEmailSender(
  env: Pick<
    Env,
    | 'EMAIL_SENDER'
    | 'SES_REGION'
    | 'EMAIL_FROM_ADDRESS'
    | 'EMAIL_REPLY_TO_ADDRESS'
    | 'EMAIL_CONFIGURATION_SET'
    | 'SMTP_HOST'
    | 'SMTP_PORT'
  >,
): EmailSender {
  switch (env.EMAIL_SENDER) {
    case 'ses':
      return new SesEmailSender({
        region: env.SES_REGION,
        fromAddress: env.EMAIL_FROM_ADDRESS,
        replyToAddress: env.EMAIL_REPLY_TO_ADDRESS,
        configurationSetName: env.EMAIL_CONFIGURATION_SET,
      });
    // The local MailHog transport (2 Sep 2026). Not a fallback and never
    // reached by failure — it is chosen explicitly, and refused in production.
    case 'smtp':
      return new SmtpEmailSender({
        host: env.SMTP_HOST ?? 'localhost',
        port: env.SMTP_PORT ?? 1025,
        fromAddress: env.EMAIL_FROM_ADDRESS,
        // Passed for the same reason SES gets it: one configuration must not
        // compose two different messages. Dropping it here sent replies to
        // `no-reply@`, which is the one address mail must not arrive at.
        replyToAddress: env.EMAIL_REPLY_TO_ADDRESS,
      });
    case 'demo':
    default:
      return new DemoEmailSender();
  }
}

/**
 * Pick the rate-limit store from config, on the same terms.
 *
 *   memory  in-process counters. Correct for one process, and only for one.
 *   redis   shared counters, the only kind that holds across ECS tasks.
 *
 * The `makeRedis` seam mirrors `selectIngestQueue`'s: it keeps this function
 * unit-testable without opening a Redis connection at import time.
 *
 * ⚠ `memory` with a real sender in production REFUSES TO BOOT (`config/env.ts`).
 * The API runs more than one task, so an in-process ceiling of five is five per
 * task — the numbers in `email-rate-limit.ts` would be fiction, and the failure
 * is silent in the direction that costs a sending reputation.
 */
export function selectEmailRateLimiter(
  env: Pick<Env, 'EMAIL_RATE_LIMIT' | 'REDIS_URL'>,
  makeRedis: (redisUrl: string) => EmailRateLimiter = (redisUrl) => RedisEmailRateLimiter.fromUrl(redisUrl),
): EmailRateLimiter {
  return env.EMAIL_RATE_LIMIT === 'redis' ? makeRedis(env.REDIS_URL) : new InMemoryEmailRateLimiter();
}
