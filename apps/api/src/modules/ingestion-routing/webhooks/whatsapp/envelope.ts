import { z } from 'zod';

/**
 * A tolerant view of Meta's Cloud API webhook envelope — only the fields this
 * handler reads (Governance §11.3: Zod at the boundary). The contract keeps the
 * body `additionalProperties: true` because it does not own Meta's schema, so we
 * validate what we use and ignore the rest: an unrecognised shape (a status
 * callback, a new message type) yields no messages rather than an error, and the
 * handler still acknowledges (a retry storm is worse than a no-op).
 */
// Every media message carries the same three fields; `id` is what the Graph
// media fetch (#79) resolves to bytes. Without it the job describes a document
// nobody can ever retrieve — the silent loss on the live channel.
const MediaSchema = z.object({
  id: z.string().optional(),
  mime_type: z.string().optional(),
  caption: z.string().optional(),
});

const MessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(), // Unix seconds, as a string
  type: z.string(),
  text: z.object({ body: z.string().optional() }).optional(),
  image: MediaSchema.optional(),
  document: MediaSchema.extend({ filename: z.string().optional() }).optional(),
  video: MediaSchema.optional(),
});

export type WhatsAppMessage = z.infer<typeof MessageSchema>;

const EnvelopeSchema = z.object({
  object: z.string().optional(),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z
                .object({
                  // The WABA number that RECEIVED this — see InboundMessage below.
                  metadata: z.object({ phone_number_id: z.string().optional() }).passthrough().optional(),
                  messages: z.array(MessageSchema).optional(),
                })
                .passthrough(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

/**
 * A message plus the number it arrived ON.
 *
 * `from` says who sent it; `receivedByPhoneNumberId` says which of our numbers
 * took delivery, and that is the only thing in the payload with any bearing on
 * WHOSE document it is. An unrouted document has no business, so the practice is
 * its sole tenancy anchor (`documents_tenant_anchor`), and the receiving number
 * is what resolves to one — today through `WHATSAPP_PRACTICE_MAP`, later through
 * a column on `Practice` (#79, G7).
 */
export interface InboundMessage extends WhatsAppMessage {
  readonly receivedByPhoneNumberId: string | null;
}

export interface ParsedEnvelope {
  readonly messages: readonly InboundMessage[];
}

/** Extract inbound messages; returns `[]` for status callbacks or unknown shapes. */
export function parseEnvelope(body: unknown): ParsedEnvelope {
  const result = EnvelopeSchema.safeParse(body);
  if (!result.success) return { messages: [] };
  const messages: InboundMessage[] = [];
  for (const entry of result.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      // Read per CHANGE, not per envelope: one delivery may batch changes from
      // more than one of our numbers, and attributing them all to the first
      // would file another practice's documents under this one.
      const receivedByPhoneNumberId = change.value.metadata?.phone_number_id ?? null;
      for (const message of change.value.messages ?? []) {
        messages.push({ ...message, receivedByPhoneNumberId });
      }
    }
  }
  return { messages };
}

/** What a media message points at, or null when it carries no document (text). */
export interface MessageMedia {
  readonly id: string;
  /** Meta's declared type — a hint for logs; the magic-byte sniffer decides. */
  readonly declaredMimeType: string | null;
  /** Sender-controlled. Reduce to a basename before storing; never trust for type. */
  readonly declaredFilename: string | null;
}

/**
 * The media attached to a message, if any.
 *
 * A message with no media is not an error and not a document — a client texting
 * "sent it yesterday?" is a real thing to receive. It is logged and not
 * persisted, which is different from being dropped.
 */
export function mediaOf(message: WhatsAppMessage): MessageMedia | null {
  const media = message.image ?? message.document ?? message.video ?? null;
  if (media === null || media.id === undefined || media.id.length === 0) return null;
  return {
    id: media.id,
    declaredMimeType: media.mime_type ?? null,
    declaredFilename: message.document?.filename ?? null,
  };
}

/**
 * The caption/text a human sent with the document, if any. Empty or
 * whitespace-only captions normalise to null, so a blank caption is never
 * wrapped into a meaningless `<untrusted_content></untrusted_content>`.
 */
export function captionOf(message: WhatsAppMessage): string | null {
  const raw =
    message.text?.body ??
    message.image?.caption ??
    message.document?.caption ??
    message.video?.caption ??
    null;
  if (raw === null || raw.trim().length === 0) return null;
  return raw;
}
