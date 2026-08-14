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
  // Tenancy + persistence fields (#20). Present for email (which has the bytes,
  // the practice anchor and the sanitised type in hand); absent for WhatsApp
  // until its media fetch lands, so persistence is skipped for those.
  practiceId: z.string().min(1).optional(),
  mimeType: z.string().optional(),
  byteSize: z.number().int().nonnegative().optional(),
});

export type IngestJobPayload = z.infer<typeof IngestJobPayloadSchema>;
