import type { Env } from '../../config/env.js';
import { AwsSmsSender } from './aws-sms-sender.js';
import { createAwsSmsTransport } from './aws-sms-transport.js';
import { EmailChaseSender } from './email-chase-sender.js';
import { DemoSmsSender, type SmsSender } from './sms-sender.js';

/**
 * Pick the chase sender from config — never by import, the house pattern shared
 * with `selectExtractor` / `selectMediaFetcher` / `selectDocumentStore` /
 * `selectEmailSender`.
 *
 *   demo   `DemoSmsSender` — "sends" by writing the outbox rows the SMS-outbox
 *          screen reads. Nothing leaves the machine. The default, so a fresh
 *          clone and CI run the whole journey offline.
 *   email  `EmailChaseSender` (launch stage A13) — the chase leaves by email,
 *          through the S2 notifications transport, carrying the reviewed body
 *          byte-for-byte.
 *
 * ⚠ **`email` is a pointer at a second switch, not a delivery guarantee.** The
 * transport it composes is itself `EMAIL_SENDER`-selected, so `SMS_SENDER=email`
 * with `EMAIL_SENDER=demo` still sends nothing — it writes into the in-memory
 * outbox. That is deliberate and it is why no new boot gate appears beside it:
 * `config/env.ts` already refuses `EMAIL_SENDER=demo` under
 * `NODE_ENV=production`, and one gate that covers every outbound email is worth
 * more than a second one that covers this caller only and can disagree with it.
 *
 * ⚠ **There is no fallback from `email` to `demo`, and there must not be one.**
 * `select-email-sender.ts` and `select-extractor.ts` both carry the long version:
 * a wrapper that catches a throw and writes an outbox row instead would report a
 * delivered chase that no client will ever receive.
 */
export type ChaseSenderEnv = Pick<
  Env,
  | 'SMS_SENDER'
  // Read only when SMS_SENDER=email, and named here rather than taking the whole
  // `Env` so what this function depends on is legible at the signature.
  | 'EMAIL_SENDER'
  | 'SES_REGION'
  | 'EMAIL_FROM_ADDRESS'
  | 'EMAIL_REPLY_TO_ADDRESS'
  | 'EMAIL_CONFIGURATION_SET'
  // Read only when EMAIL_SENDER=smtp (the local MailHog transport).
  | 'SMTP_HOST'
  | 'SMTP_PORT'
  | 'EMAIL_RATE_LIMIT'
  | 'REDIS_URL'
  // Read only when SMS_SENDER=aws (Phase 3).
  | 'SMS_REGION'
  | 'SMS_ORIGINATION_IDENTITY'
>;

export function selectSmsSender(env: ChaseSenderEnv): SmsSender {
  switch (env.SMS_SENDER) {
    case 'aws':
      // The real SMS wire (Phase 3, AWS End User Messaging). Lazy for the same
      // two reasons as `email` below: the limiter comes off the notifications
      // seam (the cycle hazard), and a process that never sends builds no AWS
      // client and opens no Redis connection. `AwsSmsSender` memoises after
      // the first send. env.ts refuses to boot `aws` with an empty
      // SMS_ORIGINATION_IDENTITY, so the transport never sees one.
      return new AwsSmsSender(async () => {
        const { selectEmailRateLimiter } = await import('../notifications/index.js');
        return {
          transport: createAwsSmsTransport({
            region: env.SMS_REGION,
            originationIdentity: env.SMS_ORIGINATION_IDENTITY,
          }),
          limiter: selectEmailRateLimiter(env),
        };
      });
    case 'email':
      // ⚠ The import is DYNAMIC, and that is load-bearing rather than lazy for
      // its own sake. `notifications/email-copy.ts` imports `chase/index.ts`
      // (for `formatGbp` and `formatDay` — money and dates come from one
      // implementation), and `chase/index.ts` re-exports this function, so a
      // STATIC value import of the notifications seam here would close a
      // runtime cycle between two public seams. That is the hazard
      // `publish-batch.ts` and `revoke-link.ts` each record refusing to create.
      // Deferring the import past module evaluation makes the cycle inert.
      //
      // It also pays for itself: a process configured for email that never
      // sends a chase constructs no SES client and opens no Redis connection.
      // `EmailChaseSender` memoises the result after the first send.
      return new EmailChaseSender(async () => {
        const { parseEmailAddress, selectEmailRateLimiter, selectEmailSender } = await import(
          '../notifications/index.js'
        );
        return {
          sender: selectEmailSender(env),
          limiter: selectEmailRateLimiter(env),
          parseAddress: parseEmailAddress,
        };
      });
    case 'demo':
    default:
      return new DemoSmsSender();
  }
}
