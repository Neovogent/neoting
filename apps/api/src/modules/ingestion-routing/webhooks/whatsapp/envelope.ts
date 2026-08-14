import { z } from 'zod';

/**
 * A tolerant view of Meta's Cloud API webhook envelope — only the fields this
 * handler reads (Governance §11.3: Zod at the boundary). The contract keeps the
 * body `additionalProperties: true` because it does not own Meta's schema, so we
 * validate what we use and ignore the rest: an unrecognised shape (a status
 * callback, a new message type) yields no messages rather than an error, and the
 * handler still acknowledges (a retry storm is worse than a no-op).
 */
const MessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.string(), // Unix seconds, as a string
  type: z.string(),
  text: z.object({ body: z.string().optional() }).optional(),
  image: z.object({ caption: z.string().optional() }).optional(),
  document: z.object({ caption: z.string().optional(), filename: z.string().optional() }).optional(),
  video: z.object({ caption: z.string().optional() }).optional(),
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
                .object({ messages: z.array(MessageSchema).optional() })
                .passthrough(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

export interface ParsedEnvelope {
  readonly messages: readonly WhatsAppMessage[];
}

/** Extract inbound messages; returns `[]` for status callbacks or unknown shapes. */
export function parseEnvelope(body: unknown): ParsedEnvelope {
  const result = EnvelopeSchema.safeParse(body);
  if (!result.success) return { messages: [] };
  const messages: WhatsAppMessage[] = [];
  for (const entry of result.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value.messages ?? []) {
        messages.push(message);
      }
    }
  }
  return { messages };
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
