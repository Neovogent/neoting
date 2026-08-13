/** Public input/output shapes for the sanitisation pipeline. */

import type { Channel } from './channels.js';
import type { AcceptedFormat } from './formats.js';
import type { Rejection } from './reasons.js';

export interface SanitisationInput {
  /** The raw upload bytes. */
  readonly bytes: Buffer;
  /** The submitter-supplied filename — a hint only; the bytes decide the type. */
  readonly filename: string;
  /** The submission channel; selects the size cap. */
  readonly channel: Channel;
}

export interface AcceptedDocument {
  /** The real type decided by magic-byte sniffing, never the declared one. */
  readonly detectedType: AcceptedFormat;
  /**
   * The SANITISED bytes — EXIF-corrected and HEIC→JPEG normalised where the
   * format called for it. These, not the caller's originals, are what belongs
   * in S3, because `sha256` and `byteLength` below describe THESE bytes.
   *
   * Returning them is not a convenience. Without it the pipeline hands back a
   * hash of bytes the caller does not possess: it would store its own original
   * under a hash of something else, and `documents.byte_hash` — the immutable
   * ingest record (SoT §4 Stage 1) and the exact-re-send signal for dedupe
   * (Stage 6) — would silently describe a different file. That is invisible
   * today only because the bootstrap normaliser is an identity passthrough, so
   * sanitised and original happen to be the same bytes. It would have started
   * lying the day sharp landed, arriving as "just swapping an implementation
   * behind an interface" — the change nobody re-reads the orchestrator for.
   */
  readonly bytes: Buffer;
  /** Byte length of `bytes` above. */
  readonly byteLength: number;
  /** SHA-256 of `bytes` above — the immutable ingest byte hash. */
  readonly sha256: string;
}

/**
 * Result of sanitisation. A discriminated union so a caller can always tell a
 * submitter why a file was refused — nothing fails silently.
 */
export type SanitisationResult =
  | { readonly ok: true; readonly document: AcceptedDocument }
  | { readonly ok: false; readonly rejection: Rejection };
