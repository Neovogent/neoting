/**
 * The chase, delivered by EMAIL *and* recorded in the SMS outbox — the owner's
 * 9 Sep 2026 ruling.
 *
 * > *"SMS will go to the given numbers. Create a box for SMS, like for email,
 * > to see what SMS is going out. No need for the SMS to actually land on the
 * > phone; just get confirmation that the code, which you correctly wrote, will
 * > actually land in their inbox as an SMS."*
 *
 * Two senders, one act, in a fixed order:
 *
 *   1. the OUTBOX half writes the `sms_log` row — the SMS-outbox screen's only
 *      source. Nothing leaves the building.
 *   2. the EMAIL half really sends, then stamps `chase_messages` with
 *      `channel: 'email'` and the provider's message id.
 *
 * ⚠ **THE ORDER IS THE DESIGN, not a preference.** Both halves update the SAME
 * `chase_messages` row. `DemoSmsSender` sets `providerMessageId`,
 * `deliveryState` and `sentAt` but never `channel`; `EmailChaseSender` sets all
 * four. Running email LAST therefore leaves the audit row saying exactly what
 * carried the message — an SES id and `channel: 'email'` — while the outbox row
 * still shows the text an SMS would have carried. Reverse the order and the
 * audit row claims a `demo-sms-…` id for a message SES really delivered, which
 * is the single lie this file exists to prevent.
 *
 * ⚠ **A contact with no mobile is SKIPPED, not refused.** `DemoSmsSender`
 * throws on a null `toE164` — correctly, because `sms_log.to_e164` is NOT NULL
 * — and client intake makes the mobile optional. Letting that throw propagate
 * would mean a client who registered an email and no phone could not be chased
 * AT ALL, a hard regression against plain `SMS_SENDER=email`, bought purely to
 * populate a screen. So the outbox half takes only the messages that carry a
 * number, and the email half takes every message.
 *
 * ⚠ **What the outbox row is, honestly:** a record of the text that WOULD have
 * been sent, not a delivery receipt. No SMS leaves this configuration — that is
 * `SMS_SENDER=aws`, which needs the UK dedicated number still in carrier
 * review. The screen is a preview of composed bytes and must not be read as
 * proof a client's phone rang.
 */

import type { ScopedClient } from '../../common/db/scoped-db.js';
import type { OutboundSms, SentSms, SmsSender } from './sms-sender.js';

export class EmailAndOutboxChaseSender implements SmsSender {
  constructor(
    /** Writes `sms_log` and sends nothing — `DemoSmsSender` in every wiring. */
    private readonly outbox: SmsSender,
    /** Really delivers, and owns the `chase_messages` stamp. Runs LAST. */
    private readonly email: SmsSender,
  ) {}

  async send(db: ScopedClient, messages: readonly OutboundSms[]): Promise<SentSms[]> {
    if (messages.length === 0) return [];

    const withMobile = messages.filter((message) => message.toE164 !== null);
    if (withMobile.length > 0) {
      await this.outbox.send(db, withMobile);
    }

    // The email half's return value is the one the executor records: it names
    // the transport that actually delivered.
    return this.email.send(db, messages);
  }
}
