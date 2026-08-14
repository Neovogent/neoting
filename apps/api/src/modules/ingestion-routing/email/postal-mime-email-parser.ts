import PostalMime from 'postal-mime';

import type { EmailParser } from './email-parser.js';
import type { EmailAttachment, ParsedEmail } from './parsed-email.js';

/** Coerce postal-mime attachment content (ArrayBuffer / Uint8Array / string) to a Buffer. */
function toBuffer(content: unknown): Buffer {
  if (content instanceof ArrayBuffer) return Buffer.from(content);
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  return Buffer.alloc(0);
}

/**
 * The real {@link EmailParser}, backed by postal-mime@3.0.0 (MIT-0, zero runtime
 * dependencies — approved on issue #14).
 *
 * It only STRUCTURES the message. It makes no trust decisions: the declared
 * `mimeType` and `filename` are carried through as hints, and downstream
 * `sanitise()` sniffs magic bytes as the sole authority on what each attachment
 * actually is (Shakib's condition on the approval).
 */
export class PostalMimeEmailParser implements EmailParser {
  async parse(raw: Buffer): Promise<ParsedEmail> {
    const email = await PostalMime.parse(raw);

    const attachments: EmailAttachment[] = (email.attachments ?? []).map((attachment) => ({
      filename: attachment.filename ?? '',
      contentType: attachment.mimeType ?? 'application/octet-stream',
      bytes: toBuffer(attachment.content),
    }));

    const parsedDate = email.date === undefined ? null : new Date(email.date);
    const date = parsedDate !== null && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null;

    return {
      from: email.from?.address ?? '',
      to: (email.to ?? []).map((addressee) => addressee.address ?? '').filter((address) => address !== '').join(', '),
      subject: email.subject ?? '',
      date,
      messageId: email.messageId ?? null,
      text: email.text ?? '',
      attachments,
    };
  }
}
