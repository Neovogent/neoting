import { z } from 'zod';

/**
 * The wire shape of an ingest job as it sits in Redis: the domain `IngestJob`
 * plus the `traceId` the queue attached at enqueue time. The worker Zod-parses
 * this before touching it — a job is a boundary (Governance §11.3), and "the
 * producer is us today" is not a reason to trust it tomorrow.
 */
export const IngestJobPayloadSchema = z.object({
  source: z.enum(['whatsapp', 'email']),
  idempotencyKey: z.string().min(1),
  from: z.string(),
  receivedAtSeconds: z.number(),
  messageType: z.string(),
  caption: z.string().nullable(),
  routing: z.object({ kind: z.enum(['matched', 'multiple', 'unrouted']), businessId: z.string().optional() }).passthrough(),
  stale: z.boolean(),
  traceId: z.string().min(1),
  filename: z.string().optional(),
  sha256: z.string().optional(),
  storageKey: z.string().optional(),
  // Tenancy + persistence fields (#20). Email fills all of them at enqueue time
  // (it has the bytes, the practice anchor and the sanitised type in hand). A
  // WhatsApp job arrives with `practiceId` and `mediaId` only — the worker
  // fetches the media (#79) and fills the rest before it persists.
  practiceId: z.string().min(1).optional(),
  mimeType: z.string().optional(),
  byteSize: z.number().int().nonnegative().optional(),
  // dHash of the sanitised image bytes (#40), for near-duplicate detection. Image
  // documents only — absent for PDFs and for bytes no decoder could read.
  perceptualHash: z.string().optional(),
  // WhatsApp media fetch (#79). `mediaId` is Meta's handle for the bytes;
  // `phoneNumberId` is the number that received the message, kept as the evidence
  // behind `practiceId`.
  mediaId: z.string().min(1).optional(),
  phoneNumberId: z.string().min(1).optional(),
});

export type IngestJobPayload = z.infer<typeof IngestJobPayloadSchema>;
