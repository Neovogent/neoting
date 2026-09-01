import { HttpStatus } from '@nestjs/common';

import { AppException } from '../../common/problem/problem.js';
import type { ScopedClient } from '../../common/db/scoped-db.js';
import type { AwsSmsTransport } from './aws-sms-transport.js';
import { OptedOutRecipientError } from './aws-sms-transport.js';
import type { OutboundSms, SentSms, SmsSender } from './sms-sender.js';

/**
 * The REAL SMS chase sender (Phase 3) — AWS End User Messaging behind the same
 * `SmsSender` seam `DemoSmsSender` and `EmailChaseSender` implement, so the
 * `chase.send` executor, the engine and the review path change by exactly
 * nothing (the seam's design intent, recorded on `SMS_SENDER` in env.ts since
 * A13, cashed in now).
 *
 * The A13 discipline, carried over wholesale:
 *
 * - **The body is `message.body`, VERBATIM.** Composed at proposal creation,
 *   frozen by the review hash — the transport copies it onto the wire. The
 *   number is `message.toE164`, which since the compose seam is the REGISTERED
 *   contact's mobile shown on the review card (D45): the reviewer approved
 *   this exact text to this exact number.
 * - **Three phases: consume every ceiling → send → record.** The per-recipient
 *   ceiling is the SAME `document-request` limiter the email transport uses
 *   (10/hour, keyed on the E164 instead of an address) — one over-ask guard,
 *   two wires.
 * - **A refusal rolls the approval back.** An opted-out recipient (STOP) or a
 *   rate-limited number refuses with `NT-PRP-006` BEFORE anything irreversible
 *   — arguing with a STOP by retrying would be the product overriding the one
 *   signal §24.2.3 says must always win. Same honest caveat as email: a
 *   transport failure on message N > 1 rolls back an approval whose earlier
 *   texts are gone; bounded (one message per client) and visible.
 * - **`sms_log` rows are REAL here** — unlike the email transport, which
 *   refuses to invent a phone number for the outbox screen, this transport has
 *   one, so the outbox tells the truth again. `costPence` stays null: AWS
 *   reports per-part price on the DELIVERY event stream (the SNS topic), not
 *   on the send response — wiring that stream is the recorded follow-up.
 */
/**
 * The per-recipient ceiling. STRUCTURAL on purpose: the notifications
 * limiter's request types its key as a branded EmailAddress, but the ceiling
 * is keyed on an opaque string — an E164 rides it the way an address does,
 * and method bivariance makes the real limiter assignable. The VALUE arrives
 * through the lazy factory, so no cycle with the notifications seam.
 */
export interface SmsRateLimiter {
  consume(request: { address: string; kind: string }): Promise<{ allowed: boolean }>;
}

export interface AwsSmsSenderDeps {
  readonly transport: AwsSmsTransport;
  readonly limiter: SmsRateLimiter;
}

export class AwsSmsSender implements SmsSender {
  private deps: Promise<AwsSmsSenderDeps> | null = null;

  constructor(private readonly factory: () => Promise<AwsSmsSenderDeps>) {}

  async send(db: ScopedClient, messages: readonly OutboundSms[]): Promise<SentSms[]> {
    if (messages.length === 0) return [];
    this.deps ??= this.factory();
    const { transport, limiter } = await this.deps;

    // Phase 1 — every ceiling, before the first irreversible act. A batch that
    // was going to refuse refuses with nothing sent.
    for (const message of messages) {
      const verdict = await limiter.consume({ address: message.toE164, kind: 'document-request' });
      if (!verdict.allowed) {
        throw refusal('a recipient is over the per-number send ceiling — try again later');
      }
    }

    // Phase 2 + 3 — send, then record onto the exact-text audit surfaces.
    const sent: SentSms[] = [];
    for (const message of messages) {
      let messageId: string;
      try {
        ({ messageId } = await transport.sendText(message.toE164, message.body));
      } catch (error) {
        if (error instanceof OptedOutRecipientError) {
          // A STOP is the client's standing answer. The approval rolls back and
          // the refusal says why, so the accountant learns the fact rather
          // than watching a chase quietly never arrive.
          throw refusal('the recipient has opted out of SMS — ask them by another channel');
        }
        throw error;
      }

      const sentAt = new Date();
      await db.chaseMessage.update({
        where: { id: message.chaseMessageId },
        data: { providerMessageId: messageId, deliveryState: 'sent', sentAt },
      });
      await db.smsLog.create({
        data: {
          businessId: message.businessId,
          toE164: message.toE164,
          body: message.body,
          providerMessageId: messageId,
          deliveryState: 'sent',
          chaseId: message.chaseId,
          sentAt,
          // costPence: on the delivery event stream, not the send response —
          // null until the SNS event consumer lands (recorded follow-up).
        },
      });
      sent.push({ chaseMessageId: message.chaseMessageId, providerMessageId: messageId, deliveryState: 'sent' });
    }
    return sent;
  }
}

function refusal(detail: string): AppException {
  return new AppException('NT-PRP-006', HttpStatus.CONFLICT, 'Proposal is not executable', detail);
}
