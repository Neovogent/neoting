/**
 * Later-stage sanitisation guards (Governance §11.4, steps 5–6):
 *   - image normalisation (EXIF orientation + HEIC→JPEG)
 *   - PDF/Office safety (reject password-protected; flatten JS; detach
 *     embedded files)
 *
 * The heavy lifting here needs native libraries (libvips/sharp for images, a
 * PDF toolkit for JS-flattening) that are new dependencies — held for Shakib's
 * approval (Governance §1.6). Until then these are honest interfaces with
 * conservative BOOTSTRAP implementations, so the pipeline order is complete
 * and testable and the real guards drop in without touching the orchestrator.
 */

import type { AcceptedFormat } from './formats.js';

export interface ImageNormaliser {
  /** Return normalised bytes (EXIF-corrected, HEIC→JPEG). Order-preserving. */
  normalise(bytes: Buffer, format: AcceptedFormat): Promise<Buffer>;
}

export interface DocumentGuardVerdict {
  readonly passwordProtected: boolean;
}

export interface DocumentGuard {
  inspect(bytes: Buffer, format: AcceptedFormat): Promise<DocumentGuardVerdict>;
}

/**
 * BOOTSTRAP: identity passthrough. Real EXIF stripping and HEIC→JPEG need
 * sharp/libvips — a dependency awaiting approval.
 * TODO(#ingest-sanitisation-deps): replace with the sharp-backed normaliser.
 */
export const bootstrapImageNormaliser: ImageNormaliser = {
  async normalise(bytes: Buffer): Promise<Buffer> {
    return bytes;
  },
};

/**
 * BOOTSTRAP document guard. It performs the one password-protection check that
 * is safe to do dependency-free — an encrypted PDF carries an `/Encrypt` entry
 * in its trailer — and reports everything else as clean. JS-flattening,
 * embedded-file detachment, and encrypted-Office detection are dep-gated.
 * TODO(#ingest-sanitisation-deps): replace with the PDF-toolkit-backed guard.
 */
export const bootstrapDocumentGuard: DocumentGuard = {
  async inspect(bytes: Buffer, format: AcceptedFormat): Promise<DocumentGuardVerdict> {
    if (format === 'pdf') {
      // The trailer is small; scan only the tail to keep this cheap.
      const tail = bytes.toString('latin1', Math.max(0, bytes.length - 4096));
      if (tail.includes('/Encrypt')) return { passwordProtected: true };
    }
    return { passwordProtected: false };
  },
};
