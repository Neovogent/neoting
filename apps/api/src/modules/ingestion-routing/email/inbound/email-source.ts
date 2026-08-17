/**
 * A source of inbound raw emails (issue #78): the SES receipt prefix in staging,
 * MailHog on a laptop, an in-memory fixture in tests. Interface + fixture + real,
 * selected by config not import (the house pattern shared with `IngestQueue`,
 * `DocumentStore`, `EmailParser`), so the intake runner is identical whichever
 * feeds it.
 */

/** One inbound raw email as a source hands it over, before any parsing. */
export interface InboundRawEmail {
  /**
   * Stable id for idempotency and {@link EmailSource.ack} — the S3 object key, or
   * the MailHog message id. Not the `Message-ID` header (which the sender writes).
   */
  readonly id: string;
  /** The raw RFC 5322 / MIME bytes, exactly as SES / MailHog hold them. */
  readonly raw: Buffer;
  /**
   * The ENVELOPE recipient (SES's delivery target / MailHog's RCPT), when the
   * source knows it. This — not the `To` header — is what a `doc+<practice>@` plus
   * tag rides on, so it is preferred for practice resolution; `null` → the runner
   * falls back to the parsed `To` header.
   */
  readonly envelopeRecipient: string | null;
  /**
   * When the source observed the object (SES write time / MailHog receipt), UTC
   * seconds. This is the real receipt time the email lane asked for — it replaces
   * the sender's forgeable `Date:` header for `receivedAtSeconds`.
   */
  readonly receivedAtSeconds: number;
}

export interface EmailSource {
  /** Pull the currently-available inbound emails. Empty when there is nothing. */
  poll(): Promise<readonly InboundRawEmail[]>;
  /**
   * Mark one as handled so it is not delivered again (delete the MailHog message /
   * the S3 object). Only called after the email was processed.
   */
  ack(id: string): Promise<void>;
  /**
   * Move one out of the poll window WITHOUT dropping it — for emails that can
   * never be processed (no resolvable recipient, unparseable MIME). "Left in
   * the source, warned once" sounded safe and was a starvation bug: the S3
   * source lists a bounded window (`MaxKeys`), a stuck email never leaves it,
   * and plain mail to `doc@` (no plus tag) is unresolvable BY DESIGN — so
   * ordinary traffic filled the window until no new mail was ever listed
   * again. Quarantine keeps the bytes (S3: copied under `unroutable/`, visible
   * and replayable once #17's mapping lands) while freeing the window.
   */
  quarantine(id: string): Promise<void>;
}

/** Offline fixture — seed raw emails, assert what was acked or quarantined. */
export class FixtureEmailSource implements EmailSource {
  private readonly pending = new Map<string, InboundRawEmail>();
  /** Every id acked, in order — lets a test prove a processed email was removed. */
  readonly acked: string[] = [];
  /** Every id quarantined, in order — out of the window, never dropped. */
  readonly quarantined: string[] = [];

  seed(email: InboundRawEmail): this {
    this.pending.set(email.id, email);
    return this;
  }

  async poll(): Promise<readonly InboundRawEmail[]> {
    return [...this.pending.values()];
  }

  async ack(id: string): Promise<void> {
    this.pending.delete(id);
    this.acked.push(id);
  }

  async quarantine(id: string): Promise<void> {
    this.pending.delete(id);
    this.quarantined.push(id);
  }
}
