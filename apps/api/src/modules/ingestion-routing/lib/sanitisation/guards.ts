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
import { reject, type Rejection } from './reasons.js';

/**
 * Normalisation can REFUSE, not only transform.
 *
 * An image is the one input we decode rather than merely inspect, and decoding
 * is where the expensive failures live: a 200 KB HEIC or PNG can describe a
 * 40,000 × 40,000 surface, which the channel byte cap cannot see because
 * compressed size says nothing about decoded size. A normaliser that could only
 * return a Buffer would have to throw or die for those, and both surface to the
 * submitter as "something went wrong" — which SoT §4 Stage 1 forbids.
 */
export type NormaliseResult =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly rejection: Rejection };

export interface ImageNormaliser {
  /** Normalised bytes (EXIF-corrected, HEIC→JPEG), or a visible refusal. */
  normalise(bytes: Buffer, format: AcceptedFormat): Promise<NormaliseResult>;
}

export interface DocumentGuardVerdict {
  readonly passwordProtected: boolean;
}

export interface DocumentGuard {
  inspect(bytes: Buffer, format: AcceptedFormat): Promise<DocumentGuardVerdict>;
}

/**
 * BOOTSTRAP normaliser: passes ordinary images through untouched, and REFUSES
 * HEIC with a reason the sender can act on.
 *
 * The refusal is the point (issue #21). HEIC used to pass through here silently
 * and then fail in extraction looking like a corrupt file, so the accountant was
 * told the wrong thing about a photo that was fine — a silent drop wearing a
 * different hat, and against this module's first invariant. Refusing it visibly
 * is worse UX than converting it and strictly better than lying about it.
 *
 * Note it is NOT removed from the accepted-format allowlist: `sniff` must keep
 * recognising HEIC, or the file falls through to "we cannot accept this type"
 * and the sender loses the one instruction that actually fixes their problem.
 *
 * EXIF stripping is still absent — that lands with sharp (#23), and this whole
 * implementation is deleted in the same PR.
 */
export const bootstrapImageNormaliser: ImageNormaliser = {
  async normalise(bytes: Buffer, format: AcceptedFormat): Promise<NormaliseResult> {
    if (format === 'heic') {
      return {
        ok: false,
        rejection: reject(
          'format_not_processable',
          'We cannot read HEIC photos yet. On an iPhone, please resend the photo as a JPEG — or set Camera > Formats to "Most Compatible" and take it again.',
        ),
      };
    }
    return { ok: true, bytes };
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
