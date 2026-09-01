import type { MatchSuggester, StatementStep } from '../../banking-matching/index.js';
import type { ChaseAutoClose } from '../../chase/index.js';
import type { ExtractionCompletion, ExtractionStep } from '../../extraction/index.js';
import type { SenderMapLoader } from '../email/inbound/sender-map.js';
import { decideRouting } from '../webhooks/whatsapp/routing.js';
import type { DocumentSink } from './document-sink.js';
import type { WhatsAppPracticeResolver } from './whatsapp-practice-resolver.js';
import type { DuplicateDetector } from './duplicate-detector.js';
import { type IngestJobPayload, IngestJobPayloadSchema } from './job-payload.js';
import { MediaFetchError } from './media-fetcher.js';
import type { ProcessedStore } from './processed-store.js';
import type { UploadSanitisationStep } from '../web-upload/upload-sanitisation.js';
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
   * Sanitisation for an ALREADY-PERSISTED upload — web and portal (Stage A3).
   * REQUIRED, for the third time and the same reason as `media` and `extractor`:
   * this lane skipped sanitisation entirely for months because nothing forced a
   * composition root to provide it, and an optional dep is a dep that can be
   * forgotten. Email and WhatsApp sanitise where their bytes are first held, so
   * they do not pass through here.
   */
  readonly uploadSanitiser: UploadSanitisationStep;
  /**
   * Extraction (METH Stage 4). REQUIRED for the same reason as `media`: a
   * processor that quietly skipped extraction is exactly the "documents never
   * leave RECEIVED" bug this step removes. Runs after the document is persisted;
   * it is idempotent, so a redelivery or a retry re-reads the state and does
   * nothing twice.
   */
  readonly extractor: ExtractionStep;
  /**
   * Auto-close on inbound match (chase, METH Stage 8). Runs AFTER extraction, for
   * a routed (business-anchored) document that landed READY/TO_REVIEW: if its
   * supplier + amount (+ date window) match an open chase's transaction, the chase
   * closes. Matching nothing is the normal case, not an error, and never throws —
   * a chase failure must not fail the ingest job or lose the document. Idempotent,
   * like extraction. Injected the house way: `RecordingChaseAutoClose` keeps these
   * unit tests offline; `PrismaChaseAutoClose` is wired in `worker/main.ts`.
   */
  readonly autoClose: ChaseAutoClose;
  /**
   * Statement import (D40/D41). Runs after extraction for a document the
   * extractor classified STATEMENT, turning it into `Statement` +
   * `BankTransaction` rows.
   *
   * REQUIRED, for the fourth time on this interface and the same reason as
   * `media`, `uploadSanitiser` and `extractor`: an optional dep is a dep a
   * composition root forgets, and this lane has been bitten by that three times
   * already. A root with no banking concern passes `NO_STATEMENT_STEP` and says
   * so out loud.
   */
  readonly statements: StatementStep;
  /**
   * The automatic match suggester (Phase 4). Runs AFTER extraction for a
   * routed document that landed, before auto-close: exactly-one deterministic
   * candidate becomes a SUGGESTED `matches` row + `matchState` flip, which the
   * human-only `bank.confirm-match` proposal promotes. REQUIRED, the
   * `statements` argument exactly: an optional dep is a dep a composition
   * root forgets, and a root with no banking concern passes
   * `NO_MATCH_SUGGESTER` and says so out loud. Never throws into the job —
   * a suggestion failure costs the suggestion, not the document.
   */
  readonly matchSuggester: MatchSuggester;
  /**
   * The sender→workspace map for WhatsApp routing (Phase 2, 1 Sep 2026).
   * OPTIONAL, the email lane's own precedent (`runEmailIntake`'s
   * `senderMapLoader`): absent → the webhook's routing stands (everything
   * Unrouted), which was the only behaviour before this. Present, a WhatsApp
   * job whose controller-decided routing is `unrouted` is re-decided here
   * against the practice's registered contacts — `buildSenderMap` already keys
   * `mobileE164` both with and without the leading `+` precisely so a
   * `wa_id` matches. Loaded in the WORKER, not the webhook, because the
   * controller has no database and Meta's webhook must answer fast.
   */
  readonly senderMap?: SenderMapLoader;
  /**
   * phone_number_id → practice, from `Practice.whatsappPhoneNumberId`
   * (Phase 2). OPTIONAL like `senderMap`; absent → the env map is the only
   * source and an unmapped number dead-letters exactly as before. The env map
   * (resolved by the controller) WINS when set — this fires only for a job
   * that arrived with no `practiceId`.
   */
  readonly whatsAppPractices?: WhatsAppPracticeResolver;
  /**
   * Whether this is the job's LAST attempt (S5). Per-job, unlike everything else
   * on this interface — the worker rebuilds this object per job, which is what
   * makes that safe.
   *
   * Extraction needs it because it claims the document into PROCESSING and is
   * the only thing that can move it out: with retries left a throw should leave
   * the document PROCESSING for the next attempt, but on the last attempt it has
   * to become FAILED with a reason, or the document is stranded in PROCESSING
   * for ever. See `PrismaExtractionStep.runExtractor`.
   */
  readonly finalAttempt: boolean;
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

async function handle(rawPayload: IngestJobPayload, deps: ProcessorDeps): Promise<void> {
  // A WhatsApp job may arrive with no practice (the env map did not name the
  // receiving number) and always arrives Unrouted (the webhook has no DB, so
  // its sender map was empty since #9). Both anchors are resolved HERE, in the
  // worker, where the database is — the email lane's `runEmailIntake` shape.
  const payload = await resolveWhatsAppAnchors(rawPayload, deps);

  const staleTag = payload.stale ? ' [stale]' : '';
  deps.logger.log(
    `ingest ${payload.idempotencyKey} from ${payload.from} (${payload.messageType}, ${payload.routing.kind})${staleTag} trace=${payload.traceId}`,
  );

  // A web-upload job (#76) refers to a document its OWN service already persisted
  // in RECEIVED — the worker must not re-persist it (that would double-create), it
  // sanitises and extracts it. This is the only channel that arrives
  // already-persisted, and without this branch its documents never leave RECEIVED
  // (METH Stage 4 acceptance #1). Extraction reads the filename/byteHash off the
  // row itself, which is why sanitisation has to correct the row first.
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

    const routedBusinessId = payload.routing.businessId ?? null;

    // SANITISATION (Stage A3) — the step this lane never had. Web and portal
    // uploads are persisted by their own service straight from the browser's
    // claims, so until this call the bytes had never been sniffed, the EXIF had
    // never been stripped and a HEIC was still a HEIC by the time extraction
    // asked Bedrock to read it. It runs FIRST, before dedupe and extraction,
    // because both of those describe the document: dedupe keys on the byte hash
    // and extraction reads `s3_key` + `mime_type` off the row, and sanitisation
    // is what makes all three true.
    const sanitisation = await deps.uploadSanitiser.run({
      documentId: payload.documentId,
      practiceId: payload.practiceId,
      businessId: routedBusinessId,
      traceId: payload.traceId,
    });

    if (sanitisation.status === 'rejected') {
      // Visible, not dropped, and not a DLQ entry either: the document is
      // REJECTED on the row with its NT-ING code and a plain-English reason, on
      // the Rejected/Failed surface, retryable through a `document.reprocess`
      // proposal. Retrying the job would refuse the same bytes for the same
      // reason, so the job completes — the outcome is recorded where a human
      // looks, which is the whole of what the DLQ was buying the WhatsApp lane.
      deps.logger.warn(
        `web-upload ${payload.documentId} rejected by sanitisation: ${sanitisation.rejection.code} ${sanitisation.rejection.message} (trace=${payload.traceId})`,
      );
      return;
    }
    if (sanitisation.status === 'unavailable') {
      deps.logger.warn(`web-upload ${payload.documentId} not available to sanitise (trace=${payload.traceId})`);
      return;
    }

    // The job's `sha256` describes what the BROWSER uploaded. Sanitisation may
    // have re-encoded those bytes (HEIC→JPEG, EXIF stripped, a PDF rewritten by
    // qpdf), so the row's hash is the one that identifies the document now —
    // dedupe against the payload's would compare a receipt to a file that no
    // longer exists. Falling back to the payload is what a step that made no
    // statement about identity leaves us with.
    const identity = sanitisation.document;
    const byteHash = identity?.byteHash ?? payload.sha256;
    const perceptualHash = identity?.perceptualHash ?? payload.perceptualHash ?? null;

    // Duplicate detection (#40) for the already-persisted lane too (METH S7).
    // This branch bypasses `persist()` by design — which meant it also bypassed
    // the detector, so web upload was the ONE channel whose documents never got
    // a `duplicates` row and the same receipt dropped twice in the browser was
    // flagged nowhere. Same guards as `persist()`: a routed document (the row
    // needs a business to anchor on) and a byte hash to key on; the write is
    // idempotent (ordered pair + unique index), so a redelivery detects again
    // and writes nothing twice.
    if (routedBusinessId !== null && byteHash !== undefined) {
      const { findings, candidatesTruncated } = await deps.detector.detect({
        documentId: payload.documentId,
        practiceId: payload.practiceId,
        businessId: routedBusinessId,
        byteHash,
        perceptualHash,
      });
      deps.logger.log(`dedupe ${payload.documentId}: ${findings.length} match(es) trace=${payload.traceId}`);
      if (candidatesTruncated) {
        deps.logger.warn(
          `dedupe ${payload.documentId}: perceptual scan hit the candidate cap for business ${routedBusinessId} — older images were not compared (trace=${payload.traceId})`,
        );
      }
    }

    const completion = await deps.extractor.run({
      documentId: payload.documentId,
      practiceId: payload.practiceId,
      businessId: payload.routing.businessId ?? null,
      traceId: payload.traceId,
      finalAttempt: deps.finalAttempt,
    });
    await runMatchSuggestion(completion, payload.practiceId, payload.traceId, deps);
    await runAutoClose(completion, payload.practiceId, payload.traceId, deps);
    await deps.statements.run({
      documentId: payload.documentId,
      practiceId: payload.practiceId,
      businessId: payload.routing.businessId ?? null,
      traceId: payload.traceId,
      // The OCR rung already read this file during extraction (D20). Handing
      // the result on is what stops a PDF statement being read a second time.
      ocr: completion?.ocr,
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
  const completion = await deps.extractor.run({
    documentId,
    practiceId: materialised.practiceId,
    businessId: payload.routing.businessId ?? null,
    traceId: payload.traceId,
    finalAttempt: deps.finalAttempt,
  });

  // Match suggestion (Phase 4) then auto-close (chase, METH Stage 8) — both run
  // after extraction for a routed document that landed, both through the same
  // deterministic compare, and neither may fail the job.
  await runMatchSuggestion(completion, materialised.practiceId, payload.traceId, deps);
  await runAutoClose(completion, materialised.practiceId, payload.traceId, deps);

  // Statement import (D40/D41) — last, because it is the only step that creates
  // rows OTHER than the document's own, and it must not run before the document
  // is safely persisted and read. It decides for itself whether this document is
  // a statement, and never throws.
  await deps.statements.run({
    documentId,
    practiceId: materialised.practiceId,
    businessId: payload.routing.businessId ?? null,
    traceId: payload.traceId,
    // The OCR rung already read this file during extraction (D20). Handing the
    // result on is what stops a PDF statement being read a second time.
    ocr: completion?.ocr,
  });
}

/**
 * Write the automatic match suggestion for a document that just finished
 * extraction (Phase 4) — same guards as auto-close (a completion, a routed
 * document), same failure posture (logged and swallowed: the document is safe,
 * a lost suggestion costs a human a lookup, not the books an error).
 */
async function runMatchSuggestion(
  completion: ExtractionCompletion | null,
  practiceId: string,
  traceId: string,
  deps: ProcessorDeps,
): Promise<void> {
  if (completion === null || completion.businessId === null) return;

  try {
    const result = await deps.matchSuggester.run({
      documentId: completion.documentId,
      businessId: completion.businessId,
      practiceId,
      supplierName: completion.supplierName,
      totalPence: completion.totalPence,
      documentDate: completion.documentDate,
      traceId,
    });
    if (result.suggested !== null) {
      deps.logger.log(
        `match-suggest ${completion.documentId}: suggested against ${result.suggested.transactionId} trace=${traceId}`,
      );
    }
  } catch (error) {
    deps.logger.warn(
      `match-suggest ${completion.documentId} failed (document is safe, no suggestion written): ${String(error)} trace=${traceId}`,
    );
  }
}

/**
 * Fill a WhatsApp job's two missing anchors from the database (Phase 2).
 *
 * - **practice**: the env map (controller-resolved) WINS; a job that arrived
 *   without one asks `Practice.whatsappPhoneNumberId` by the number that
 *   RECEIVED the message — never the sender. Still nothing → unchanged, and
 *   `materialise` dead-letters it loudly exactly as before.
 * - **routing**: the webhook always enqueues `unrouted` (it has no DB). With a
 *   practice known and a sender map wired, the sender's `wa_id` is re-decided
 *   against the practice's registered contacts — D45's identity, the same
 *   contacts rows the email lane routes by, through the same
 *   `buildSenderMap`/`decideRouting` pair, so the two channels cannot disagree
 *   about what a recognised sender is. `matched` → routed to that workspace;
 *   `multiple` → Unrouted with the "Which company?" reason (the queue is where
 *   a human answers that); `none` → Unrouted, never dropped.
 *
 * A resolver/loader failure downgrades to the pre-Phase-2 behaviour (Unrouted,
 * or a dead-letter for a missing practice) rather than failing the job: a
 * routing convenience must never lose a document.
 */
async function resolveWhatsAppAnchors(payload: IngestJobPayload, deps: ProcessorDeps): Promise<IngestJobPayload> {
  if (payload.source !== 'whatsapp') return payload;

  let { practiceId } = payload;
  if (practiceId === undefined && payload.phoneNumberId !== undefined && deps.whatsAppPractices !== undefined) {
    try {
      practiceId = (await deps.whatsAppPractices.byPhoneNumberId(payload.phoneNumberId)) ?? undefined;
      if (practiceId !== undefined) {
        deps.logger.log(
          `whatsapp practice resolved from Practice.whatsappPhoneNumberId for ${payload.idempotencyKey} (trace=${payload.traceId})`,
        );
      }
    } catch (error) {
      deps.logger.warn(
        `whatsapp practice resolution failed for ${payload.idempotencyKey}: ${String(error)} — falling back to the job's own anchor (trace=${payload.traceId})`,
      );
    }
  }

  let { routing } = payload;
  if (practiceId !== undefined && routing.kind === 'unrouted' && deps.senderMap !== undefined) {
    try {
      const map = await deps.senderMap.load(practiceId);
      const decided = decideRouting(payload.from, map);
      // `multiple` stays Unrouted ON PURPOSE: the queue is where a human answers
      // "Which company?", and the job payload's routing shape has no member for
      // carrying candidates today. The reason says so rather than pretending.
      routing =
        decided.kind === 'multiple'
          ? {
              kind: 'unrouted',
              reason: `Sender ${payload.from} is a contact of ${decided.candidateBusinessIds.length} workspaces — a human picks in the queue.`,
            }
          : decided;
      if (routing.kind === 'matched') {
        deps.logger.log(`whatsapp sender matched a registered contact for ${payload.idempotencyKey} (trace=${payload.traceId})`);
      }
    } catch (error) {
      deps.logger.warn(
        `whatsapp sender-map load failed for ${payload.idempotencyKey}: ${String(error)} — staying Unrouted (trace=${payload.traceId})`,
      );
    }
  }

  if (practiceId === payload.practiceId && routing === payload.routing) return payload;
  return { ...payload, routing, ...(practiceId === undefined ? {} : { practiceId }) };
}

/**
 * Run chase auto-close for a document that just finished extraction — the SoT
 * §4 Stage 8.5 beat: an inbound document that matches a chased transaction closes
 * the chase, regardless of arrival channel. Guarded three ways:
 *
 *  - only when extraction produced a completion (a FAILED/skipped read is null);
 *  - only for a ROUTED document (a business anchors the chase and the notification);
 *  - only READY/TO_REVIEW — a landed document, which the completion already is.
 *
 * A chase-close failure is NOT allowed to fail the ingest job: the document is
 * already safely persisted and extracted, and losing that to a chase error would
 * be the "nothing is ever silently dropped" invariant turned on its head. So a
 * failure is logged and swallowed here; the chase simply stays open for a human,
 * which is the safe direction. Matching nothing is silent and normal.
 */
async function runAutoClose(
  completion: ExtractionCompletion | null,
  practiceId: string,
  traceId: string,
  deps: ProcessorDeps,
): Promise<void> {
  if (completion === null || completion.businessId === null) return;

  try {
    const result = await deps.autoClose.run({
      documentId: completion.documentId,
      businessId: completion.businessId,
      practiceId,
      supplierName: completion.supplierName,
      totalPence: completion.totalPence,
      documentDate: completion.documentDate,
      traceId,
    });
    if (result.closedChaseIds.length > 0) {
      deps.logger.log(
        `auto-close ${completion.documentId}: closed ${result.closedChaseIds.length} chase(s) trace=${traceId}`,
      );
    }
  } catch (error) {
    deps.logger.warn(
      `auto-close ${completion.documentId} failed (chase left open, document is safe): ${String(error)} trace=${traceId}`,
    );
  }
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
    // it and `documents_tenant_anchor` refuses the row. Both sources have been
    // tried by now — the controller's WHATSAPP_PRACTICE_MAP env and the
    // worker's Practice.whatsappPhoneNumberId resolver — so an unmapped number
    // must dead-letter loudly, where a human sees it, rather than return
    // cleanly having written nothing.
    throw new TerminalJobError(
      `no practice anchor for ${payload.idempotencyKey} (phone_number_id=${payload.phoneNumberId ?? 'absent'}) — set Practice.whatsappPhoneNumberId (or WHATSAPP_PRACTICE_MAP); refusing to persist an unanchored document (trace=${payload.traceId})`,
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
