/**
 * The `SmsSender` seam (SoT §4 Stage 8.3 — SMS with a secure link).
 *
 * Chasing is SMS-only. The real sender is Twilio; every mode in this push is the
 * demo one, which "sends" by writing the outbox rows the SMS-outbox screen reads
 * — the dev "phone" (METH_MODE Stage 8). Selected by config
 * (`SMS_SENDER=demo`), never by import, the house pattern shared with
 * `selectExtractor` / `selectMediaFetcher`.
 *
 * // DEMO-MOCK: Twilio Messaging replaces `DemoSmsSender` behind this interface,
 * // selected by env — no call site changes. NO real SMS ever leaves this
 * // codebase before the pilot (METH_MODE §0.5).
 *
 * The sender writes through the ScopedClient the CALLER (the `chase.send`
 * executor, inside the engine's approve transaction) hands it — so the outbox
 * write is part of the same atomic effect as the chase, under the same RLS
 * context. The sender opens no transaction and reads no env.
 */

import type { ScopedClient } from '../../common/db/scoped-db.js';

/** One message to send — the executor has already composed and stored it. */
export interface OutboundSms {
  /** The business the chase belongs to — the tenancy anchor for both rows. */
  readonly businessId: string;
  /** The chase this message is a send of. */
  readonly chaseId: string;
  /** The chase_messages row already written by the executor — updated with the send result. */
  readonly chaseMessageId: string;
  /**
   * Null when the recipient registered no mobile (2 Sep 2026 — the compose
   * seam now accepts an email-only contact, because intake makes the mobile
   * optional and ID's live transport is email). The EMAIL transport resolves
   * its address from the chase's contact and never reads this; the SMS
   * transports refuse a null loudly, where "cannot deliver" is true.
   */
  readonly toE164: string | null;
  /** The exact SMS body — byte-for-byte what review showed. */
  readonly body: string;
}

/** What the send produced, per message — mirrors the outbox row it wrote. */
export interface SentSms {
  readonly chaseMessageId: string;
  readonly providerMessageId: string;
  readonly deliveryState: string;
}

export interface SmsSender {
  send(db: ScopedClient, messages: readonly OutboundSms[]): Promise<SentSms[]>;
}

/** The demo provider-message-id prefix — clearly not a real Twilio SID. */
const DEMO_PROVIDER_PREFIX = 'demo-sms';

/**
 * The demo sender: it "sends" by recording the outbox. For each message it
 * stamps the already-written `chase_messages` row as sent (provider id +
 * delivery state + `sentAt`) and appends an `sms_log` row — the two surfaces the
 * SMS-outbox screen and the request thread read. No network, no Twilio.
 *
 * Deterministic: the provider id is derived from the chase_message id, so the
 * same message always "sends" to the same id (the mocking doctrine — same input,
 * same output).
 */
export class DemoSmsSender implements SmsSender {
  async send(db: ScopedClient, messages: readonly OutboundSms[]): Promise<SentSms[]> {
    const sent: SentSms[] = [];
    for (const message of messages) {
      if (message.toE164 === null) {
        // This transport is an SMS stand-in and `sms_log.to_e164` is NOT NULL.
        // An email-only recipient belongs on SMS_SENDER=email; landing here is
        // a mis-paired configuration, said out loud rather than half-sent.
        throw new Error('chase message has no mobile number — the SMS transport cannot deliver it (use SMS_SENDER=email, or register a mobile for the contact)');
      }
      const providerMessageId = `${DEMO_PROVIDER_PREFIX}-${message.chaseMessageId}`;
      const deliveryState = 'sent';
      const sentAt = new Date();

      // The chase_messages row is the exact-text audit surface (its own schema
      // comment: if the sent text differs from review, the guarantee is broken).
      // The executor already wrote `body`; the sender only records the send.
      await db.chaseMessage.update({
        where: { id: message.chaseMessageId },
        data: { providerMessageId, deliveryState, sentAt },
      });

      // sms_log is the per-business send log (SoT Stage 8.6 — every SMS logged).
      await db.smsLog.create({
        data: {
          businessId: message.businessId,
          toE164: message.toE164,
          body: message.body,
          providerMessageId,
          deliveryState,
          chaseId: message.chaseId,
          sentAt,
          // costPence deliberately null — a demo send has no cost. // DEMO-MOCK:
          // Twilio reports a real per-segment cost in pence.
        },
      });

      sent.push({ chaseMessageId: message.chaseMessageId, providerMessageId, deliveryState });
    }
    return sent;
  }
}
