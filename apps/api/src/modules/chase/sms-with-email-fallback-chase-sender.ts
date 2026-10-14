/**
 * The chase by TEXT where the contact has a mobile, and by EMAIL where they do
 * not — what `SMS_SENDER=aws` means since 14 Oct 2026.
 *
 * Until then `aws` sent by text ONLY, and `AwsSmsSender` refuses a contact with
 * no mobile (`NT-PRP-006`). Intake makes the mobile optional (2 Sep 2026), so
 * an email-only client could not be chased at all: found live when two
 * statement requests to an email-only contact refused at approve, rolled back
 * and logged nothing, while the review card, the request form and the portal
 * all promised email. Staging was reverted to `email+sms` (#316) with this
 * file named as the condition for flipping back.
 *
 * Two senders, one act, split by recipient:
 *
 *   1. the SMS half takes every message that carries a number. It runs FIRST
 *      because it is the half that can refuse before anything irreversible —
 *      `AwsSmsSender` consumes every per-number ceiling before its first send.
 *   2. the EMAIL half takes every message that does not, and stamps its own
 *      `chase_messages` rows with `channel: 'email'`.
 *
 * ⚠ **The split is on `toE164` and nothing else.** A contact WITH a mobile who
 * has opted out (STOP) or is over the per-number ceiling still refuses, and is
 * NOT quietly re-routed to email: the refusal tells the approver the fact, and
 * choosing another channel is a person's decision, not this file's
 * (`aws-sms-sender.ts`). Only "there is no number to text" falls back, because
 * there the email is the only delivery the client could ever have had.
 *
 * ⚠ **Each message goes by exactly one wire.** Unlike `email+sms`, nobody gets
 * the same chase twice. The SMS half writes real `sms_log` rows for the texts
 * it sent; the emailed messages get none, because there was no text.
 *
 * The result keeps the caller's order, so the executor reads one row per
 * message exactly as it does from a single sender.
 */

import type { ScopedClient } from '../../common/db/scoped-db.js';
import type { OutboundSms, SentSms, SmsSender } from './sms-sender.js';

export class SmsWithEmailFallbackChaseSender implements SmsSender {
  constructor(
    /** Texts the messages that carry a number — `AwsSmsSender` in every wiring. */
    private readonly sms: SmsSender,
    /** Emails the messages that do not. */
    private readonly email: SmsSender,
  ) {}

  async send(db: ScopedClient, messages: readonly OutboundSms[]): Promise<SentSms[]> {
    if (messages.length === 0) return [];

    const byText = messages.filter((message) => message.toE164 !== null);
    const byEmail = messages.filter((message) => message.toE164 === null);

    const texted = byText.length > 0 ? await this.sms.send(db, byText) : [];
    const emailed = byEmail.length > 0 ? await this.email.send(db, byEmail) : [];

    const results = new Map([...texted, ...emailed].map((sent) => [sent.chaseMessageId, sent]));
    return messages.flatMap((message) => {
      const sent = results.get(message.chaseMessageId);
      return sent === undefined ? [] : [sent];
    });
  }
}
