import type { EmailAddress } from './email-address.js';

/**
 * The `EmailSender` seam — the house pattern shared with `selectExtractor`,
 * `selectSmsSender`, `selectDocumentStore` and `selectIngestQueue`: one
 * interface, implementations chosen by CONFIG and never by import
 * (`select-email-sender.ts`).
 *
 * Before S2 a repo-wide grep for `SESClient`, `sendEmail`, `nodemailer`,
 * `SendEmailCommand` and `smtp` returned zero hits. Only INBOUND mail existed
 * (`ingestion-routing/email`, `doc@` → S3). With SMS cut for Initial Delivery,
 * a client had no delivery channel at all: no invite could reach them, no
 * sign-in code could be delivered, and nothing could be chased.
 *
 * ## Why this seam takes no `ScopedClient`, unlike `SmsSender`
 *
 * `DemoSmsSender` is handed the caller's scoped transaction because its send IS
 * a database write — it stamps `chase_messages` and appends `sms_log`, and
 * those rows are the SMS-outbox screen. Email has no such table, and adding one
 * is a `prisma/` change, which is LAW (G7) and not in the S0 batch.
 *
 * That constraint turned out to be the right shape anyway. This module is a
 * TRANSPORT. The durable record of *why* a message was sent belongs to the
 * caller and already exists there — `invites` for an invite, `otp_sessions`
 * for a sign-in code, `chases` + `chase_messages` for a document request. A
 * second, transport-owned copy would be a second opinion about what was sent,
 * and the SMS lane already documents why that is the one thing composition must
 * never have (`chase/sms-copy.ts`).
 *
 * What replaces the outbox row, per mode:
 *
 * | Mode | The record that a send happened |
 * |---|---|
 * | `demo` | {@link DemoEmailSender}'s in-memory outbox — readable in-process by dev and tests |
 * | `ses` | SES's own: the configuration set's CloudWatch metrics and the `nt-<env>-ses-events` SNS topic (bounce, complaint, reject, rendering failure, delivery delay) |
 *
 * ## Plain text only, and this is not an aesthetic choice
 *
 * There is no `html` field on {@link OutboundEmail} and there must not be one.
 * A transactional message that arrives looking like a campaign — images, a
 * tracking pixel, a button — is scored as one, and a sign-in code in a spam
 * folder is a client who cannot sign in at all. The whole product is gated on
 * these three messages landing in an inbox.
 */

/**
 * Which of S2's three messages this is. Carried on the envelope because the
 * rate limiter's ceilings are per-kind (a sign-in code is a credential and is
 * held far tighter than an invite) and because it is the one thing about a
 * message that is safe to log.
 */
export type EmailKind =
  | 'client-invite'
  | 'sign-in-code'
  | 'document-request'
  // The two signup messages. A1 built `SignupMailer` as a seam for these and
  // shipped a recording stand-in; until they existed here, `POST /v1/practices`
  // refused under NODE_ENV=production and staging had no signup at all.
  | 'email-verification'
  | 'duplicate-signup';

/** One message, fully composed. The sender adds the envelope and nothing else. */
export interface OutboundEmail {
  readonly kind: EmailKind;
  /** Parsed at the boundary — see `email-address.ts` for what that refuses. */
  readonly to: EmailAddress;
  /**
   * The subject line. Never carries the sign-in code: a subject is rendered in
   * lock-screen previews, notification banners and mail-server logs, none of
   * which are places a credential may appear.
   */
  readonly subject: string;
  /** The body, plain text, `\n`-terminated lines. No HTML part exists. */
  readonly body: string;
}

/** What a send produced. The provider's id is the handle an incident traces on. */
export interface SentEmail {
  readonly kind: EmailKind;
  readonly providerMessageId: string;
}

export interface EmailSender {
  send(email: OutboundEmail): Promise<SentEmail>;
}

/** The demo provider-message-id prefix — clearly not an SES message id. */
const DEMO_PROVIDER_PREFIX = 'demo-email';

/**
 * How many messages the demo outbox keeps. A ring, not a log: this process may
 * run for days under `pnpm dev`, and an unbounded array holding sign-in codes
 * in memory is a slow leak of both heap and credentials.
 */
const DEMO_OUTBOX_CAPACITY = 100;

/** A message the demo sender "sent", as dev and tests read it back. */
export interface DemoOutboxEntry extends SentEmail {
  readonly to: EmailAddress;
  readonly subject: string;
  readonly body: string;
  readonly sentAt: Date;
}

/**
 * The demo sender: it "sends" into memory. No network, no SES, no credentials
 * required — so `pnpm dev` and `pnpm test` exercise the identical composition,
 * rate-limit and envelope path a real send takes, and a laptop with no AWS
 * account still runs the whole journey.
 *
 * ⚠ **The outbox holds sign-in codes in plaintext, and that is the point** —
 * locally there is nowhere else to read the code you need in order to sign in.
 * It is also why `EMAIL_SENDER=demo` REFUSES TO BOOT under `NODE_ENV=production`
 * (`config/env.ts`). The gate is not about the credentials in memory; it is
 * that a production `demo` sender means the invite, the code and the chase all
 * silently go nowhere while every screen reports success.
 *
 * Deterministic, like every other demo implementation here: the provider id is
 * derived from the recipient and the message ordinal, so a test asserts on a
 * value rather than on a shape.
 */
export class DemoEmailSender implements EmailSender {
  readonly #outbox: DemoOutboxEntry[] = [];
  #sequence = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  send(email: OutboundEmail): Promise<SentEmail> {
    this.#sequence += 1;
    const providerMessageId = `${DEMO_PROVIDER_PREFIX}-${this.#sequence}`;

    this.#outbox.push({
      kind: email.kind,
      providerMessageId,
      to: email.to,
      subject: email.subject,
      body: email.body,
      sentAt: this.now(),
    });
    // Drop the oldest, not the newest: the message a developer is looking for
    // is the one they just triggered.
    if (this.#outbox.length > DEMO_OUTBOX_CAPACITY) this.#outbox.shift();

    return Promise.resolve({ kind: email.kind, providerMessageId });
  }

  /** Everything still in the ring, oldest first. A copy — callers cannot mutate it. */
  readOutbox(): readonly DemoOutboxEntry[] {
    return [...this.#outbox];
  }

  /** The most recent message to an address, which is what a dev flow wants. */
  lastTo(address: EmailAddress): DemoOutboxEntry | undefined {
    for (let i = this.#outbox.length - 1; i >= 0; i -= 1) {
      const entry = this.#outbox[i];
      if (entry !== undefined && entry.to === address) return entry;
    }
    return undefined;
  }
}
