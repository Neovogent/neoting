import type { DocumentSink } from './document-sink.js';
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
  /** Persists the sanitised document (#20); the durable idempotency lives here. */
  readonly sink: DocumentSink;
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

  // Persist (#20) only when the document is actually in hand — email carries the
  // stored bytes, their sanitised MIME/size, and the practice anchor. WhatsApp
  // jobs do not yet (their media is a Meta id needing a Graph fetch — a separate
  // task), so they are logged and left unpersisted rather than written as an
  // orphan with no bytes behind it.
  if (
    payload.practiceId !== undefined &&
    payload.storageKey !== undefined &&
    payload.sha256 !== undefined &&
    payload.mimeType !== undefined &&
    payload.byteSize !== undefined &&
    payload.filename !== undefined
  ) {
    const { documentId, created } = await deps.sink.persist({
      idempotencyKey: payload.idempotencyKey,
      practiceId: payload.practiceId,
      businessId: payload.routing.businessId ?? null,
      s3Key: payload.storageKey,
      byteHash: payload.sha256,
      mimeType: payload.mimeType,
      byteSize: payload.byteSize,
      channel: payload.source === 'email' ? 'EMAIL' : 'WHATSAPP',
      originalFilename: payload.filename,
      submitterLabel: payload.from,
      routing: payload.routing,
      traceId: payload.traceId,
    });
    deps.logger.log(`persisted document ${documentId} (created=${created}) trace=${payload.traceId}`);
    return;
  }

  deps.logger.log(`no document to persist for ${payload.idempotencyKey} (source=${payload.source}) — bytes not in hand yet`);
}
