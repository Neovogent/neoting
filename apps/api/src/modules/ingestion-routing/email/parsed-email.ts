/**
 * The structured view of an inbound email, produced by an {@link EmailParser}
 * from the raw RFC 5322 bytes SES writes to S3. Everything downstream works off
 * this shape, so the choice of MIME parser is an implementation detail behind
 * the interface.
 */
export interface EmailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}

export interface ParsedEmail {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  /** Sent date; null when the header is missing or unparseable. */
  readonly date: Date | null;
  readonly messageId: string | null;
  /** The plain-text body. Untrusted content (§9.6). */
  readonly text: string;
  readonly attachments: readonly EmailAttachment[];
}
