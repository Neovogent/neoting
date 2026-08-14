/**
 * The sanitisation pipeline (Governance §11.4). The step order is FIXED and is
 * not a suggestion (module invariant):
 *
 *   1 magic-byte sniff (never trust extensions)
 *   2 extension allowlist
 *   3 size cap per channel
 *   4 virus scan hook
 *   5 EXIF orientation + HEIC→JPEG
 *   6 PDF/Office safety (reject password-protected; flatten JS; detach files)
 *   7 ZIP explode with depth/size/file-count caps
 *
 * Pure library: no controller, no Prisma, no network. External capabilities
 * (virus scanner, image normaliser, document guard) are injected so the
 * pipeline runs fully offline in fixture mode and stays unit-testable without
 * touching the internet (Governance §15.1).
 *
 * Every refusal returns a `Rejection` with a plain-English reason — including
 * password-protected files and zip bombs. Nothing fails silently.
 */

import { createHash } from 'node:crypto';

import { CHANNEL_POLICY } from './channels.js';
import { ACCEPTED_FORMATS, extensionContradicts, sniff } from './formats.js';
import {
  bootstrapDocumentGuard,
  bootstrapImageNormaliser,
  type DocumentGuard,
  type ImageNormaliser,
} from './guards.js';
import { reject } from './reasons.js';
import type { AcceptedDocument, SanitisationInput, SanitisationResult } from './types.js';
import { fixtureVirusScanner, type VirusScanner } from './virus-scan.js';
import { DEFAULT_ZIP_CAPS, inspectZip, type ZipCaps } from './zip-safety.js';

export interface SanitisationDeps {
  readonly scanner: VirusScanner;
  readonly imageNormaliser: ImageNormaliser;
  readonly documentGuard: DocumentGuard;
  readonly zipCaps: ZipCaps;
}

/** Offline fixture defaults — no cloud keys, deterministic. */
export const defaultDeps: SanitisationDeps = {
  scanner: fixtureVirusScanner,
  imageNormaliser: bootstrapImageNormaliser,
  documentGuard: bootstrapDocumentGuard,
  zipCaps: DEFAULT_ZIP_CAPS,
};

const IMAGE_FORMATS = new Set(['jpeg', 'png', 'gif', 'bmp', 'tiff', 'heic']);
const DOCUMENT_FORMATS = new Set(['pdf', 'doc', 'docx', 'odt', 'rtf']);

function accepted(bytes: Buffer, detectedType: AcceptedDocument['detectedType']): SanitisationResult {
  return {
    ok: true,
    document: {
      detectedType,
      // The sanitised bytes travel WITH their hash. Hashing bytes the caller
      // cannot obtain is how documents.byte_hash ends up describing a file
      // that was never stored — see the note on AcceptedDocument.bytes.
      bytes,
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

export async function sanitise(
  input: SanitisationInput,
  overrides: Partial<SanitisationDeps> = {},
): Promise<SanitisationResult> {
  const deps: SanitisationDeps = { ...defaultDeps, ...overrides };
  const { channel, filename } = input;

  // 1 · magic-byte sniff — the bytes decide the type.
  const detected = sniff(input.bytes);
  if (detected === 'unknown') {
    return {
      ok: false,
      rejection: reject('type_not_allowed', 'This file type is not one we can accept. Accepted: images, PDF, Word, ODT, RTF and ZIP.'),
    };
  }
  if (extensionContradicts(filename, detected)) {
    return {
      ok: false,
      rejection: reject('magic_byte_mismatch', `This file's contents are ${detected.toUpperCase()}, which does not match its name — it was refused as a safety precaution.`, {
        detected,
        filename,
      }),
    };
  }

  // 2 · extension allowlist — the detected type must be on the allowlist.
  if (!ACCEPTED_FORMATS.has(detected)) {
    return { ok: false, rejection: reject('type_not_allowed', 'This file type is not accepted.') };
  }

  // 3 · size cap per channel.
  const { maxBytes } = CHANNEL_POLICY[channel];
  if (input.bytes.length > maxBytes) {
    return {
      ok: false,
      rejection: reject('oversize', `This file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit for this upload channel.`, {
        byteLength: input.bytes.length,
        maxBytes,
      }),
    };
  }

  // 4 · virus scan hook.
  const verdict = await deps.scanner.scan(input.bytes);
  if (verdict.infected) {
    return {
      ok: false,
      rejection: reject('virus_detected', 'This file was flagged by our virus scan and cannot be accepted.', verdict.signature ? { signature: verdict.signature } : undefined),
    };
  }

  // 5 · EXIF orientation + HEIC→JPEG (image formats only).
  let bytes = input.bytes;
  if (IMAGE_FORMATS.has(detected)) {
    // Normalisation may refuse: HEIC is unreadable until #23, and a decode bomb
    // must be a visible rejection rather than an OOM that kills the worker.
    const normalised = await deps.imageNormaliser.normalise(bytes, detected);
    if (!normalised.ok) return { ok: false, rejection: normalised.rejection };
    bytes = normalised.bytes;
  }

  // 6 · PDF/Office safety — password-protected is a visible rejection.
  if (DOCUMENT_FORMATS.has(detected)) {
    // The guard may REWRITE as well as refuse: a PDF carrying JavaScript or an
    // embedded payload comes back stripped rather than rejected, because an
    // invoice with a form field is ordinary paperwork.
    const guarded = await deps.documentGuard.inspect(bytes, detected);
    if (!guarded.ok) return { ok: false, rejection: guarded.rejection };
    bytes = guarded.bytes;
  }

  // 7 · ZIP explode caps.
  if (detected === 'zip') {
    const zipRejection = inspectZip(bytes, deps.zipCaps);
    if (zipRejection) return { ok: false, rejection: zipRejection };
  }

  return accepted(bytes, detected);
}
