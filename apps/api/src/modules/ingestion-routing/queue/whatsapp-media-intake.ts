/**
 * Turn a WhatsApp media id into a stored, sanitised document (issue #79).
 *
 * This is the WhatsApp half of what `email-intake.ts` does for an attachment,
 * and deliberately reuses the SAME pipeline rather than opening a parallel path:
 * fetch → `sanitise()` → perceptual hash → `DocumentStore`. Only the source of
 * the bytes differs. It runs in the WORKER, not the webhook, because a Graph
 * round trip is exactly the retryable external call the async spine exists for
 * (apps/api/CLAUDE.md).
 *
 * It returns; it does not persist. The caller owns the `DocumentSink` write, so
 * WhatsApp and email converge on one persistence path with one idempotency rule.
 */

import type { PerceptualHasher } from '../lib/dedupe/perceptual-hash.js';
import { safeBasename } from '../lib/safe-basename.js';
import {
  type DocumentGuard,
  type ImageNormaliser,
  mimeForFormat,
  type Rejection,
  sanitise,
  type SanitisationDeps,
  type VirusScanner,
} from '../lib/sanitisation/index.js';
import type { DocumentStore } from '../storage/document-store.js';
import { effectiveFormat } from '../web-upload/upload-sanitisation.js';
import { type MediaFetcher, WHATSAPP_MEDIA_CHANNEL } from './media-fetcher.js';

export interface MediaIntakeDeps {
  readonly fetcher: MediaFetcher;
  readonly store: DocumentStore;
  /**
   * Injected for the same reason as in `email-intake`: these are sharp- and
   * qpdf-backed, and a lane that constructed them itself could not be tested
   * offline. Absent → the offline fixtures inside `sanitise()`.
   */
  readonly perceptualHasher?: PerceptualHasher;
  readonly scanner?: VirusScanner;
  readonly imageNormaliser?: ImageNormaliser;
  readonly documentGuard?: DocumentGuard;
}

export interface MediaIntakeInput {
  readonly mediaId: string;
  /** The tenancy anchor. Required — `documentKey()` throws without one. */
  readonly practiceId: string;
  /** The routed workspace, or null while the document is Unrouted. */
  readonly businessId: string | null;
  /** Meta's `document.filename`, already reduced to a basename by the webhook. */
  readonly filename?: string;
}

/** A document with its bytes safely in object storage, ready for the sink. */
export interface MaterialisedDocument {
  readonly storageKey: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly filename: string;
  readonly perceptualHash: string | null;
}

export type MediaIntakeOutcome =
  | { readonly ok: true; readonly document: MaterialisedDocument }
  | { readonly ok: false; readonly rejection: Rejection };

/**
 * A WhatsApp image arrives with no filename at all, and `documents.original_filename`
 * is NOT NULL. Synthesise one from the content hash and the DETECTED type —
 * never from Meta's declared MIME, which is a claim, not a fact.
 */
function synthesiseFilename(sha256: string, detectedType: string): string {
  return `whatsapp-${sha256.slice(0, 12)}.${detectedType}`;
}

export async function fetchWhatsAppMedia(
  input: MediaIntakeInput,
  deps: MediaIntakeDeps,
): Promise<MediaIntakeOutcome> {
  // Throws MediaFetchError — NOT returned as a rejection. A rejection is a
  // decision about the document ("this is a virus", "this is 40 MB"); a fetch
  // failure is the world being unavailable, and only the caller knows whether
  // that deserves a retry or the DLQ.
  const media = await deps.fetcher.fetch(input.mediaId);

  const sanitisationDeps: Partial<SanitisationDeps> = {
    ...(deps.scanner ? { scanner: deps.scanner } : {}),
    ...(deps.imageNormaliser ? { imageNormaliser: deps.imageNormaliser } : {}),
    ...(deps.documentGuard ? { documentGuard: deps.documentGuard } : {}),
  };
  // Pass NO filename, exactly as the email lane does: a declared extension must
  // never sway the type decision. `'client'` is the WhatsApp channel (25 MB) —
  // see WHATSAPP_MEDIA_CHANNEL for why there is no `'whatsapp'` member.
  const result = await sanitise(
    { bytes: media.bytes, filename: '', channel: WHATSAPP_MEDIA_CHANNEL },
    sanitisationDeps,
  );
  if (!result.ok) return { ok: false, rejection: result.rejection };

  // ⚠ The pipeline's `detectedType` describes the INPUT; step 5 re-encodes
  // every image to JPEG. Labelling the stored object with the input format put
  // `image/heic` on JPEG bytes — recreating NT-EXT-003 on the exact format the
  // normaliser exists to fix. `effectiveFormat` re-sniffs the OUTPUT bytes,
  // exactly as `upload-sanitisation.ts` does (one fix, two lanes, no drift).
  const storedFormat = effectiveFormat(result.document.bytes, result.document.detectedType);

  // Hash the SANITISED bytes while they are already in hand (#40) — never a
  // round trip back to S3 to re-read what we are holding.
  const perceptualHash = deps.perceptualHasher
    ? await deps.perceptualHasher.hash(result.document.bytes, storedFormat)
    : null;

  const mimeType = mimeForFormat(storedFormat);
  // Store BEFORE the caller persists, so a `documents` row never points at an
  // object that does not exist.
  const stored = await deps.store.put({
    bytes: result.document.bytes,
    sha256: result.document.sha256,
    contentType: mimeType,
    workspaceId: input.businessId,
    practiceId: input.practiceId,
  });

  return {
    ok: true,
    document: {
      storageKey: stored.key,
      sha256: result.document.sha256,
      mimeType,
      byteSize: result.document.byteLength,
      filename:
        input.filename !== undefined && input.filename.length > 0
          ? safeBasename(input.filename)
          : synthesiseFilename(result.document.sha256, storedFormat),
      perceptualHash,
    },
  };
}
