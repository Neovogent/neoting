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
 * TODO(#7): replace with the sharp-backed normaliser.
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
 * TODO(#7): replace with the PDF-toolkit-backed guard.
 */
export const bootstrapDocumentGuard: DocumentGuard = {
  async inspect(bytes: Buffer, format: AcceptedFormat): Promise<DocumentGuardVerdict> {
    if (format === 'pdf') {
      // Head AND tail, not tail alone. "The trailer is at the end" is true of a
      // plain PDF and false of the two shapes we will actually meet:
      //   - LINEARIZED PDFs (every "optimised for web" export) put a first-page
      //     cross-reference section and its trailer dictionary at the FRONT.
      //   - INCREMENTALLY UPDATED PDFs — anything signed, form-filled or
      //     annotated, which is a lot of accounting paperwork — carry several
      //     trailers, and /Encrypt may sit in any of them.
      //
      // ⚠ STILL A KNOWN FALSE-NEGATIVE PATH. A large PDF with /Encrypt in a
      // middle-of-file trailer passes as clean, and then fails in extraction
      // looking like a corrupt document rather than a locked one. SoT §4
      // Stage 1 promises password-protected files are refused WITH A VISIBLE
      // REASON, and this shim cannot always keep that promise. The real guard
      // parses the xref chain properly and is dependency-gated.
      // TODO(#7): replace with the PDF-toolkit-backed guard.
      const window = 8192;
      const head = bytes.toString('latin1', 0, Math.min(window, bytes.length));
      const tail = bytes.toString('latin1', Math.max(0, bytes.length - window));
      if (head.includes('/Encrypt') || tail.includes('/Encrypt')) {
        return { passwordProtected: true };
      }
    }
    return { passwordProtected: false };
  },
};
