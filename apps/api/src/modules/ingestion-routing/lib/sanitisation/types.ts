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
  readonly byteLength: number;
  /** SHA-256 of the sanitised bytes — the immutable ingest byte hash. */
  readonly sha256: string;
}

/**
 * Result of sanitisation. A discriminated union so a caller can always tell a
 * submitter why a file was refused — nothing fails silently.
 */
export type SanitisationResult =
  | { readonly ok: true; readonly document: AcceptedDocument }
  | { readonly ok: false; readonly rejection: Rejection };
