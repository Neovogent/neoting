import { IngestJobPayloadSchema } from './job-payload.js';
import type { ProcessedStore } from './processed-store.js';

/** Minimal logger surface the processor needs — kept narrow so tests inject a fake. */
export interface JobLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface ProcessorDeps {
  readonly processed: ProcessedStore;
  readonly logger: JobLogger;
}

/**
 * Process one ingest job. Today's contract (issue #12): **validate, log,
 * acknowledge** — persistence is blocked on `scopedDb`, so nothing is written.
 *
 * - Zod-validates the payload at the boundary; a bad payload throws, which lets
 *   BullMQ retry / dead-letter it rather than processing garbage.
 * - Idempotent on `idempotencyKey`: a redelivery of an already-handled job is a
 *   logged no-op, never double-processed.
 * - Logs with the job's `traceId`, so the Journey Inspector has no hole at the
 *   async boundary (Governance §13.1).
 */
export async function processIngestJob(raw: unknown, deps: ProcessorDeps): Promise<void> {
  const payload = IngestJobPayloadSchema.parse(raw);

  const fresh = await deps.processed.markProcessed(payload.idempotencyKey);
  if (!fresh) {
    deps.logger.warn(`ingest ${payload.idempotencyKey} already processed — skipping (trace=${payload.traceId})`);
    return;
  }

  const staleTag = payload.stale ? ' [stale]' : '';
  deps.logger.log(
    `ingest ${payload.idempotencyKey} from ${payload.from} (${payload.messageType}, ${payload.routing.kind})${staleTag} trace=${payload.traceId}`,
  );
  // TODO(scopedDb): persist the document + routing decision here once the data
  // layer exists. Out of scope for #12 (no DB writes).
}
