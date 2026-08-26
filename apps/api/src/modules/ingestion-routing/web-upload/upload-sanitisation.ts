/**
 * Worker-side sanitisation for an ALREADY-PERSISTED upload (Stage A3).
 *
 * Web and portal uploads were the one lane that skipped sanitisation entirely.
 * `web-upload.service.ts` persists the document in RECEIVED from the signed
 * claims and enqueues a job carrying only a `documentId`; the processor's
 * already-persisted branch went straight to dedupe and extract, so:
 *
 *   - an iPhone HEIC stayed HEIC, which under `EXTRACTOR=bedrock` is an instant
 *     `NT-EXT-003` on the commonest phone format;
 *   - EXIF was never stripped, so we kept a client's GPS coordinates while the
 *     privacy notice said we strip them;
 *   - `documents.mime_type` was the browser's claim, so magic-byte sniffing —
 *     the one thing that decides what a file actually is — never happened here.
 *
 * This is the WhatsApp lane's shape applied to bytes we already hold, and it is
 * deliberately the SAME `sanitise()` pipeline, not a second one: read the bytes
 * back from the store, run Governance §11.4 in its fixed order, and hand the
 * caller either the sanitised identity or a `Rejection`. A second sanitiser is a
 * second thing to get wrong.
 *
 * It runs in the WORKER, never on the request path — sharp decodes and qpdf is a
 * subprocess, and both are precisely what the async spine exists for.
 *
 * Pure with respect to the database: this file touches no Prisma and no object
 * store. `prisma-upload-sanitisation.ts` is the implementation that reads the
 * row, moves the bytes and writes the outcome.
 */

import type { PerceptualHasher } from '../lib/dedupe/perceptual-hash.js';
import {
  type AcceptedFormat,
  type Channel,
  type DocumentGuard,
  type ImageNormaliser,
  mimeForFormat,
  type Rejection,
  sanitise,
  type SanitisationDeps,
  sniff,
  type VirusScanner,
} from '../lib/sanitisation/index.js';

export interface UploadSanitisationInput {
  readonly documentId: string;
  /**
   * The tenancy anchor — the practice whose SYSTEM actor the row is read and
   * written under. Supplied by the caller for the same reason extraction needs
   * it: the scoped context has to exist before the row can be read under RLS.
   */
  readonly practiceId: string;
  /** The routed workspace, or null while the document is Unrouted. */
  readonly businessId: string | null;
  readonly traceId: string;
}

/**
 * What the document's bytes ARE, once sanitisation has finished with them.
 *
 * Every field describes the SANITISED bytes, not the ones the browser uploaded.
 * That distinction is the whole point: a HEIC arrives and a JPEG is stored, so
 * the key, the hash, the size and the MIME all move together or the row starts
 * describing a file that no longer exists.
 */
export interface SanitisedUpload {
  readonly storageKey: string;
  readonly byteHash: string;
  readonly byteSize: number;
  /** Magic-byte authoritative, derived from the stored bytes — never a claim. */
  readonly mimeType: string;
  /** dHash of the sanitised image bytes (#40); null for PDFs and undecodable rasters. */
  readonly perceptualHash: string | null;
}

/**
 * The four things that can happen to an upload waiting to be sanitised.
 *
 * `document` is nullable on the two success branches and that is meaningful, not
 * lazy: it is the step's STATEMENT about the document's current identity. The
 * real implementation always has one (it just read the row). A fixture that only
 * records the call makes no such statement and returns null, and the caller then
 * falls back to what the job carried — which is exactly what it did before this
 * step existed.
 */
export type UploadSanitisationResult =
  /** The bytes were read, cleaned, re-stored, and the row now describes them. */
  | { readonly status: 'sanitised'; readonly document: SanitisedUpload | null }
  /** A previous attempt already did it — idempotent no-op. Safe to continue. */
  | { readonly status: 'already-sanitised'; readonly document: SanitisedUpload | null }
  /**
   * Refused, visibly. The document is REJECTED with the reason on the row, which
   * is where the client and the accountant can both see it — nothing downstream
   * should run for it.
   */
  | { readonly status: 'rejected'; readonly rejection: Rejection }
  /** The row is not visible under the caller's scope. Nothing to do, and said so. */
  | { readonly status: 'unavailable'; readonly reason: string };

export interface UploadSanitisationStep {
  run(input: UploadSanitisationInput): Promise<UploadSanitisationResult>;
}

export interface UploadSanitisationDeps {
  /**
   * Injected for the same reason as in `whatsapp-media-intake` and
   * `email-intake`: these are sharp- and qpdf-backed, and a lane that
   * constructed them itself could not be tested offline. Absent → the offline
   * fixtures inside `sanitise()`, which refuse HEIC rather than pass it through.
   */
  readonly perceptualHasher?: PerceptualHasher;
  readonly scanner?: VirusScanner;
  readonly imageNormaliser?: ImageNormaliser;
  readonly documentGuard?: DocumentGuard;
}

/** The sanitised bytes plus everything derived from them, ready to be stored. */
export interface SanitisedBytes {
  readonly bytes: Buffer;
  /** The format the STORED bytes are in — see `effectiveFormat` for why this is re-sniffed. */
  readonly format: AcceptedFormat;
  readonly mimeType: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly perceptualHash: string | null;
}

export type SanitisedBytesResult =
  | { readonly ok: true; readonly document: SanitisedBytes }
  | { readonly ok: false; readonly rejection: Rejection };

/**
 * ⚠ THE PIPELINE'S `detectedType` DESCRIBES THE INPUT, NOT THE OUTPUT.
 *
 * `pipeline.ts` returns `accepted(bytes, detected)` where `detected` is what was
 * sniffed at step 1, while `bytes` are what step 5 produced — and step 5 re-encodes
 * every image to JPEG. So a HEIC photo comes back as `detectedType: 'heic'`
 * carrying JPEG bytes, and `mimeForFormat(detectedType)` would write
 * `image/heic` onto a row whose object is a JPEG.
 *
 * On this lane that is not cosmetic. It is the exact failure A3 exists to fix:
 * `BedrockExtractor` decides what it may send from `documents.mime_type`, so a
 * successfully-converted iPhone photo would still be refused as HEIC, and
 * `presignGet` would pin `Content-Type: image/heic` on a JPEG in the browser.
 *
 * So the STORED bytes are sniffed again. `sniff` is cheap (it reads a signature,
 * it never decodes) and it is the same function step 1 used — the fix is to ask
 * it about the right bytes, not to add a second opinion about formats.
 *
 * The fallback to the declared type is for the one case sniffing cannot answer:
 * a guard that rewrote a document into something the sniffer no longer
 * recognises. Trusting step 1 there is strictly better than storing `unknown`.
 */
export function effectiveFormat(bytes: Buffer, detectedType: AcceptedFormat): AcceptedFormat {
  const resniffed = sniff(bytes);
  return resniffed === 'unknown' ? detectedType : resniffed;
}

/**
 * Sanitise bytes we already hold: the §11.4 pipeline, then the identity the
 * caller needs to describe what came out of it.
 *
 * **No filename is passed**, exactly as the email and WhatsApp lanes do. The
 * bytes decide the type; a declared extension must never sway that decision, and
 * `extensionContradicts` would turn a receipt someone saved as `photo.jpg` from
 * a PNG into a rejection for a mistake with no security content. The declared
 * MIME was already allowlisted at the door (`isAllowedMime`) as a cheap
 * pre-filter; from here the magic bytes are the only authority.
 */
export async function sanitiseUploadBytes(
  input: { readonly bytes: Buffer; readonly channel: Channel },
  deps: UploadSanitisationDeps = {},
): Promise<SanitisedBytesResult> {
  const sanitisationDeps: Partial<SanitisationDeps> = {
    ...(deps.scanner ? { scanner: deps.scanner } : {}),
    ...(deps.imageNormaliser ? { imageNormaliser: deps.imageNormaliser } : {}),
    ...(deps.documentGuard ? { documentGuard: deps.documentGuard } : {}),
  };

  const result = await sanitise({ bytes: input.bytes, filename: '', channel: input.channel }, sanitisationDeps);
  if (!result.ok) return { ok: false, rejection: result.rejection };

  const format = effectiveFormat(result.document.bytes, result.document.detectedType);
  // Hash the SANITISED bytes while they are already in hand (#40) — and hash
  // them as what they now ARE, so a converted HEIC is hashed as the JPEG it is
  // rather than skipped by a hasher told it is looking at a format sharp cannot
  // read. Web uploads carried no perceptual hash at all before this.
  const perceptualHash = deps.perceptualHasher ? await deps.perceptualHasher.hash(result.document.bytes, format) : null;

  return {
    ok: true,
    document: {
      bytes: result.document.bytes,
      format,
      mimeType: mimeForFormat(format),
      sha256: result.document.sha256,
      byteLength: result.document.byteLength,
      perceptualHash,
    },
  };
}

/**
 * Offline fixture — records the calls so the ingest processor stays
 * unit-testable, and returns a caller-supplied result so a test can drive the
 * rejected and unavailable branches without a database or a decoder.
 *
 * The default makes no claim about the document's identity (`document: null`),
 * which is what leaves the processor falling back to the job's own hash.
 */
export class RecordingUploadSanitisation implements UploadSanitisationStep {
  readonly runs: UploadSanitisationInput[] = [];

  constructor(private readonly result: UploadSanitisationResult = { status: 'sanitised', document: null }) {}

  async run(input: UploadSanitisationInput): Promise<UploadSanitisationResult> {
    this.runs.push(input);
    return this.result;
  }
}
