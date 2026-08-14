import { z } from 'zod';

/**
 * The wire shape of an ingest job as it sits in Redis: the domain `IngestJob`
 * plus the `traceId` the queue attached at enqueue time. The worker Zod-parses
 * this before touching it — a job is a boundary (Governance §11.3), and "the
 * producer is us today" is not a reason to trust it tomorrow.
 */
export const IngestJobPayloadSchema = z.object({
  source: z.literal('whatsapp'),
  idempotencyKey: z.string().min(1),
  from: z.string(),
  receivedAtSeconds: z.number(),
  messageType: z.string(),
  caption: z.string().nullable(),
  routing: z.object({ kind: z.enum(['matched', 'multiple', 'unrouted']) }).passthrough(),
  stale: z.boolean(),
  traceId: z.string().min(1),
});

export type IngestJobPayload = z.infer<typeof IngestJobPayloadSchema>;
