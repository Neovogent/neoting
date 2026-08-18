import type { ExtractionStep } from '../../extraction/index.js';
import type { DocumentSink } from './document-sink.js';
import type { DuplicateDetector } from './duplicate-detector.js';
import { type IngestJobPayload, IngestJobPayloadSchema } from './job-payload.js';
import { MediaFetchError } from './media-fetcher.js';
import type { ProcessedStore } from './processed-store.js';
import { fetchWhatsAppMedia, type MediaIntakeDeps, type MaterialisedDocument } from './whatsapp-media-intake.js';

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
  /**
   * Fetch + sanitise + store for WhatsApp media (#79). REQUIRED, not optional:
   * a processor that quietly skipped media jobs because nobody wired a fetcher
   * is the silent loss this issue exists to remove.
   */
  readonly media: MediaIntakeDeps;
  /**
   * Extraction (METH Stage 4). REQUIRED for the same reason as `media`: a
   * processor that quietly skipped extraction is exactly the "documents never
   * leave RECEIVED" bug this step removes. Runs after the document is persisted;
   * it is idempotent, so a redelivery or a retry re-reads the state and does
   * nothing twice.
   */
  readonly extractor: ExtractionStep;
}

/**
 * A job that is not retryable — the failure is a property of the job, not of the
 * moment. The worker dead-letters it immediately instead of spending the retry
 * budget on an outcome that cannot change (#79).
 */
export class TerminalJobError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'TerminalJobError';
  }
}

/**
 * Process one ingest job.
 *
 * - Zod-validates the payload at the boundary; a bad payload throws, which lets
 *   BullMQ retry / dead-letter it rather than processing garbage.
 * - Idempotent on `idempotencyKey`: a redelivery of an already-handled job is a
 *   logged no-op, never double-processed.
 * - Fetches WhatsApp media (#79) when the job carries a media id, then persists
 *   the document (#20) and flags duplicates (#40) — the same path email takes,
 *   from the point the bytes are in hand. Logs with the job's `traceId`, so the
 *   Journey Inspector has no hole at the async boundary (Governance §13.1).
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

  // A web-upload job (#76) refers to a document its OWN service already persisted
  // in RECEIVED — the worker must not re-persist it (that would double-create), it
  // extracts it. This is the only channel that arrives already-persisted, and
  // without this branch its documents never leave RECEIVED (METH Stage 4
  // acceptance #1). Extraction reads the filename/byteHash off the row itself.
  if (payload.documentId !== undefined) {
    if (payload.practiceId === undefined) {
      // A standalone business has no practice above it, so there is no
      // practice-level SYSTEM actor to extract under. Not in the demo cast; a
      // noted follow-up rather than a silent extraction of an unanchorable row.
      deps.logger.log(
        `already-persisted ${payload.idempotencyKey} has no practice anchor — extraction skipped (standalone business, trace=${payload.traceId})`,
      );
      return;
    }
    await deps.extractor.run({
      documentId: payload.documentId,
      practiceId: payload.practiceId,
      businessId: payload.routing.businessId ?? null,
      traceId: payload.traceId,
    });
    return;
  }

  const materialised = await materialise(payload, deps);
  if (materialised === null) return; // the reason was logged where it was decided
  const { documentId } = await persist(payload, materialised, deps);

  // Extraction (METH Stage 4) — the step that takes the document out of RECEIVED.
  // It runs for EVERY persisted document, routed or not, and is idempotent: a
  // redelivery (created=false) or a retry after a mid-job failure re-reads the
  // document's state and does nothing twice.
  await deps.extractor.run({
    documentId,
    practiceId: materialised.practiceId,
    businessId: payload.routing.businessId ?? null,
    traceId: payload.traceId,
  });
}

/** A document with its bytes stored, and the practice that anchors it. */
interface Materialised {
  readonly practiceId: string;
  readonly document: MaterialisedDocument;
}

/**
 * Get the document's bytes into object storage, whatever channel it came from.
 *
 * Email arrives already sanitised, hashed and stored — the webhook had the bytes
 * in hand, so the job describes a finished document. WhatsApp arrives as a Meta
 * media id and is resolved here, in the worker, because a Graph round trip is
 * precisely the retryable external call the async spine exists for.
 *
 * `null` means "nothing to persist, and that is correct" — a text-only message.
 * Everything that is NOT correct throws.
 */
async function materialise(payload: IngestJobPayload, deps: ProcessorDeps): Promise<Materialised | null> {
  // Hoisted to consts, not read off `payload` later: narrowing on a property
  // does not survive into the closure below, and `as string` there would be a
  // cast standing exactly where the tenancy anchor is decided.
  const { practiceId, mediaId, filename } = payload;

  if (
    payload.storageKey !== undefined &&
    payload.sha256 !== undefined &&
    payload.mimeType !== undefined &&
    payload.byteSize !== undefined &&
    filename !== undefined &&
    practiceId !== undefined
  ) {
    return {
      practiceId,
      document: {
        storageKey: payload.storageKey,
        sha256: payload.sha256,
        mimeType: payload.mimeType,
        byteSize: payload.byteSize,
        filename,
        perceptualHash: payload.perceptualHash ?? null,
      },
    };
  }

  if (mediaId === undefined) {
    // Not a document: a client texting "did you get it?" is a real thing to
    // receive. Logged, not persisted — which is not the same as dropped.
    deps.logger.log(
      `no media on ${payload.idempotencyKey} (source=${payload.source}, type=${payload.messageType}) — nothing to persist trace=${payload.traceId}`,
    );
    return null;
  }

  if (practiceId === undefined) {
    // ⚠ THROW, do not skip. `documents.practice_id` is the only tenancy anchor
    // an unrouted document has: `documentKey()` refuses to build a key without
    // it and `documents_tenant_anchor` refuses the row. Nothing in prisma/ maps
    // a Meta number to a practice yet (#79, G7), so WHATSAPP_PRACTICE_MAP is
    // what fills the gap — and an unmapped number must dead-letter loudly, where
    // a human sees it, rather than return cleanly having written nothing.
    throw new TerminalJobError(
      `no practice anchor for ${payload.idempotencyKey} (phone_number_id=${payload.phoneNumberId ?? 'absent'}) — set WHATSAPP_PRACTICE_MAP; refusing to persist an unanchored document (trace=${payload.traceId})`,
    );
  }

  const outcome = await withFetchClassification(payload, deps, () =>
    fetchWhatsAppMedia(
      {
        mediaId,
        practiceId,
        businessId: payload.routing.businessId ?? null,
        ...(filename === undefined ? {} : { filename }),
      },
      deps.media,
    ),
  );

  if (!outcome.ok) {
    // A sanitisation refusal is a DECISION about this document, not a transient
    // failure: retrying an oversize or infected file forever changes nothing.
    //
    // ⚠ THROW, do not warn-and-return. Returning null completes the job
    // successfully: the idempotency claim stands, the webhook replay store
    // already blocks the wamid, and Meta's media id expires in ~30 days — so a
    // client's rejected receipt becomes unrecoverable with one warn line as its
    // only trace. That contradicts this module's first invariant ("nothing is
    // ever silently dropped") and #79's own acceptance ("a visible rejection
    // with a reason … never a lost message"). It cannot be a `documents` row
    // yet — `documents.s3_key` is NOT NULL, the contract change is raised on
    // #79 — but it CAN be a DLQ entry today, exactly like an unmapped practice
    // above: `job.data` keeps the mediaId, caption, practiceId and traceId, a
    // human sees it, and it is replayable while the media id still resolves.
    const line = `whatsapp media ${payload.idempotencyKey} rejected by sanitisation: ${outcome.rejection.code} ${outcome.rejection.message} (trace=${payload.traceId})`;
    deps.logger.warn(`${line} — dead-lettering so it stays visible and replayable`);
    throw new TerminalJobError(line);
  }

  deps.logger.log(
    `fetched whatsapp media for ${payload.idempotencyKey} → ${outcome.document.mimeType} ${outcome.document.byteSize}B trace=${payload.traceId}`,
  );
  return { practiceId, document: outcome.document };
}

/**
 * Turn a `MediaFetchError` into the right kind of failure for the worker.
 *
 * Retryable (Graph 5xx, socket) → rethrow, and BullMQ's backoff does its job.
 * Terminal (expired id, 401, oversize) → `TerminalJobError`, which the worker
 * dead-letters at once. Issue #79 in as many words: "not a swallowed error and
 * not an infinite retry".
 */
async function withFetchClassification<T>(
  payload: IngestJobPayload,
  deps: ProcessorDeps,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof MediaFetchError)) throw error;
    const line = `whatsapp media fetch failed for ${payload.idempotencyKey}: ${error.failure} — ${error.message} (trace=${payload.traceId})`;
    if (error.retryable) {
      deps.logger.warn(`${line} — retrying`);
      throw error;
    }
    deps.logger.warn(`${line} — terminal, dead-lettering`);
    throw new TerminalJobError(line, { cause: error });
  }
}

/** Persist the document and, when it is routed, look for duplicates (#40). */
async function persist(
  payload: IngestJobPayload,
  { practiceId, document }: Materialised,
  deps: ProcessorDeps,
): Promise<{ documentId: string }> {
  const businessId = payload.routing.businessId ?? null;

  const { documentId, created } = await deps.sink.persist({
    idempotencyKey: payload.idempotencyKey,
    practiceId,
    businessId,
    s3Key: document.storageKey,
    byteHash: document.sha256,
    perceptualHash: document.perceptualHash,
    mimeType: document.mimeType,
    byteSize: document.byteSize,
    channel: payload.source === 'email' ? 'EMAIL' : 'WHATSAPP',
    originalFilename: document.filename,
    submitterLabel: payload.from,
    // The WhatsApp caption becomes the description (#79), still wrapped. Email's
    // `caption` is the whole subject + body, which is a different thing and is
    // left for extraction rather than pushed into a one-line field here.
    description: payload.source === 'whatsapp' ? payload.caption : null,
    routing: payload.routing,
    traceId: payload.traceId,
  });
  deps.logger.log(`persisted document ${documentId} (created=${created}) trace=${payload.traceId}`);

  // Duplicate detection (#40) runs for ROUTED documents only: a `Duplicate`
  // row needs a business to anchor on, and an unrouted document has none. It
  // runs on every handle, not just `created` ones — a retry after a mid-job
  // failure must still detect, and the write is idempotent (ordered pair +
  // unique index). See the module CLAUDE.md for the unrouted decision.
  if (businessId === null) return { documentId };

  const { findings, candidatesTruncated } = await deps.detector.detect({
    documentId,
    practiceId,
    businessId,
    byteHash: document.sha256,
    perceptualHash: document.perceptualHash,
  });
  deps.logger.log(`dedupe ${documentId}: ${findings.length} match(es) trace=${payload.traceId}`);

  // A duplicate we declined to look for is still one we missed. The perceptual
  // scan is capped, so when the cap bites it is said out loud rather than left
  // to look like a clean run — the module's first invariant is that nothing is
  // ever silently dropped.
  if (candidatesTruncated) {
    deps.logger.warn(
      `dedupe ${documentId}: perceptual scan hit the candidate cap for business ${businessId} — older images were not compared (trace=${payload.traceId})`,
    );
  }

  return { documentId };
}
