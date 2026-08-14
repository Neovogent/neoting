import type { DocumentSink } from './document-sink.js';
import type { DuplicateDetector } from './duplicate-detector.js';
import { type IngestJobPayload, IngestJobPayloadSchema } from './job-payload.js';
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
  /** Flags exact/near duplicates after a routed document persists (#40). */
  readonly detector: DuplicateDetector;
}

/**
 * Process one ingest job.
 *
 * - Zod-validates the payload at the boundary; a bad payload throws, which lets
 *   BullMQ retry / dead-letter it rather than processing garbage.
 * - Idempotent on `idempotencyKey`: a redelivery of an already-handled job is a
 *   logged no-op, never double-processed.
 * - Persists the document (#20) and flags duplicates (#40) when the bytes are in
 *   hand; logs with the job's `traceId`, so the Journey Inspector has no hole at
 *   the async boundary (Governance §13.1).
 */
export async function processIngestJob(raw: unknown, deps: ProcessorDeps): Promise<void> {
  const payload = IngestJobPayloadSchema.parse(raw);

  const fresh = await deps.processed.markProcessed(payload.idempotencyKey);
  if (!fresh) {
    deps.logger.warn(`ingest ${payload.idempotencyKey} already processed — skipping (trace=${payload.traceId})`);
    return;
  }

  // ⚠ EVERYTHING PAST THE CLAIM MUST RELEASE IT ON FAILURE. `markProcessed`
  // above is a claim made BEFORE the work; if the work throws and the claim
  // stands, BullMQ's retry sees "already processed", returns cleanly, and the
  // job reports SUCCESS having written nothing. The document is lost silently
  // and never reaches the DLQ — the exact opposite of the retry this throw is
  // asking for, and a breach of the module's "nothing is ever silently dropped"
  // invariant.
  try {
    await handle(payload, deps);
  } catch (error) {
    await deps.processed.release(payload.idempotencyKey);
    throw error;
  }
}

async function handle(payload: IngestJobPayload, deps: ProcessorDeps): Promise<void> {
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
    const businessId = payload.routing.businessId ?? null;
    const perceptualHash = payload.perceptualHash ?? null;
    const { documentId, created } = await deps.sink.persist({
      idempotencyKey: payload.idempotencyKey,
      practiceId: payload.practiceId,
      businessId,
      s3Key: payload.storageKey,
      byteHash: payload.sha256,
      perceptualHash,
      mimeType: payload.mimeType,
      byteSize: payload.byteSize,
      channel: payload.source === 'email' ? 'EMAIL' : 'WHATSAPP',
      originalFilename: payload.filename,
      submitterLabel: payload.from,
      routing: payload.routing,
      traceId: payload.traceId,
    });
    deps.logger.log(`persisted document ${documentId} (created=${created}) trace=${payload.traceId}`);

    // Duplicate detection (#40) runs for ROUTED documents only: a `Duplicate`
    // row needs a business to anchor on, and an unrouted document has none. It
    // runs on every handle, not just `created` ones — a retry after a mid-job
    // failure must still detect, and the write is idempotent (ordered pair +
    // unique index). See the module CLAUDE.md for the unrouted decision.
    if (businessId !== null) {
      const { findings, candidatesTruncated } = await deps.detector.detect({
        documentId,
        practiceId: payload.practiceId,
        businessId,
        byteHash: payload.sha256,
        perceptualHash,
      });
      deps.logger.log(`dedupe ${documentId}: ${findings.length} match(es) trace=${payload.traceId}`);

      // A duplicate we declined to look for is still one we missed. The
      // perceptual scan is capped, so when the cap bites it is said out loud
      // rather than left to look like a clean run — the module's first
      // invariant is that nothing is ever silently dropped.
      if (candidatesTruncated) {
        deps.logger.warn(
          `dedupe ${documentId}: perceptual scan hit the candidate cap for business ${businessId} — older images were not compared (trace=${payload.traceId})`,
        );
      }
    }
    return;
  }

  deps.logger.log(`no document to persist for ${payload.idempotencyKey} (source=${payload.source}) — bytes not in hand yet`);
}
