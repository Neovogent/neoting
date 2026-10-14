/**
 * The chase by TEXT first, by EMAIL when a text is not possible — the owner's
 * 14 Oct 2026 ruling: *"do sms first, email fallback"*. What `SMS_SENDER=aws`
 * selects.
 *
 * It exists because plain SMS-only failed live (11 Sep – 14 Oct 2026): a
 * statement request to a contact with no mobile refused at approve, rolled
 * back, logged nothing, and the client got nothing — while every screen said
 * "by email". Per message:
 *
 *   - **a registered mobile** → the text (`AwsSmsSender`, reviewed bytes
 *     verbatim to the number on the review card);
 *   - **no mobile** → the email (`EmailChaseSender`, the same reviewed bytes);
 *   - **the text did not leave** (`SmsNotSent` — a STOP on the number, or AWS
 *     refusing the send) → the email.
 *
 * ⚠ **The per-number ceiling is NOT a fallback case.** It is the over-ask
 * guard; emailing the same person instead would be the product routing around
 * its own rule. That refusal propagates and rolls the approval back.
 *
 * ⚠ **A text AWS accepted but the carrier never delivered does NOT fall back**
 * — nothing in this process learns about it. Delivery receipts arrive on the
 * event stream, which is not wired (the `costPence` follow-up in CLAUDE.md).
 *
 * The fallback is LOGGED, because the refusal it replaces was invisible: 4xx
 * app exceptions are not logged, and that is how the 14 Oct failure hid.
 * The log names the chase message, never the number or the address.
 *
 * Each message goes alone, so one client's fallback cannot change another's
 * transport. A batch is one message per client (SoT §8.2), and the honest
 * caveat both halves already carry — a failure on message N > 1 rolls back an
 * approval whose earlier sends are gone — is unchanged.
 */

import { Logger } from '@nestjs/common';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { SmsNotSent } from './aws-sms-sender.js';
import type { OutboundSms, SentSms, SmsSender } from './sms-sender.js';

export class SmsFirstChaseSender implements SmsSender {
  private readonly logger = new Logger(SmsFirstChaseSender.name);

  constructor(
    /** The real text wire — `AwsSmsSender` in every wiring. */
    private readonly sms: SmsSender,
    /** The real email wire — `EmailChaseSender`; stamps `channel: 'email'`. */
    private readonly email: SmsSender,
  ) {}

  async send(db: ScopedClient, messages: readonly OutboundSms[]): Promise<SentSms[]> {
    const sent: SentSms[] = [];
    for (const message of messages) {
      if (message.toE164 !== null) {
        try {
          sent.push(...(await this.sms.send(db, [message])));
          continue;
        } catch (error) {
          if (!(error instanceof SmsNotSent)) throw error;
          this.logger.warn(
            `chase message ${message.chaseMessageId}: text not sent (${error.reason}: ${String(error.underlying)}) — sending by email instead`,
          );
        }
      } else {
        this.logger.log(`chase message ${message.chaseMessageId}: no registered mobile — sending by email`);
      }
      sent.push(...(await this.email.send(db, [message])));
    }
    return sent;
  }
}
