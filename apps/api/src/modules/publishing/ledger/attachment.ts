import { Logger } from '@nestjs/common';
import sharp from 'sharp';

import type { LedgerAttachment } from '../ledger-adapter.js';
import type { VendorConfig } from './vendors.js';

/**
 * Getting the source document small enough and in a shape the vendor takes —
 * and saying so honestly when it cannot be done (D43, build brief Stage 3).
 *
 * ⚠ **`attachmentSent` must be honest.** D43 says every released transaction
 * carries a resolvable link back to its source document, and through an API
 * that link is a real file on the record. Where a vendor will not take the
 * file, the publish still succeeds — books that are right without evidence beat
 * books that were not written — but the result says `attachmentSent: false` and
 * the reason is logged. Claiming an attachment that did not travel would make
 * D43 unverifiable, which is worse than admitting a gap.
 *
 * ⚠ **FreeAgent's 5 MB cap is the reason this file exists.** Our intake accepts
 * photographs from phones that routinely exceed it, so downscaling is not an
 * optimisation here, it is the difference between a receipt being attached and
 * not. Sage's 2.5 MB is tighter still.
 */

/** What travels, or why nothing does. */
export type AttachmentOutcome =
  | { readonly ok: true; readonly bytes: Buffer; readonly filename: string; readonly mimeType: string }
  | { readonly ok: false; readonly reason: string };

/** Bytes for one stored document. The adapter never holds a 500-item batch of these. */
export type DocumentBytes = (s3Key: string) => Promise<Buffer>;

const logger = new Logger('LedgerAttachment');

/**
 * ⚠ **A JPEG is the only format worth re-encoding to.** A PDF cannot be made
 * smaller without a rasteriser we do not ship, and a PNG receipt re-encoded as
 * PNG barely shrinks — so an oversized one of either is reported honestly
 * rather than mangled. A photograph, which is what almost every oversized
 * attachment is, becomes a smaller JPEG with no loss a human reading a receipt
 * would notice.
 */
const RESIZABLE = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'image/gif']);

/** Successive attempts: quality first, then dimensions. The first one that fits wins. */
const ATTEMPTS: readonly { readonly quality: number; readonly maxEdge: number | null }[] = [
  { quality: 82, maxEdge: null },
  { quality: 78, maxEdge: 2400 },
  { quality: 72, maxEdge: 1800 },
  { quality: 65, maxEdge: 1400 },
];

export async function prepareAttachment(
  attachment: LedgerAttachment | null,
  vendor: VendorConfig,
  read: DocumentBytes,
): Promise<AttachmentOutcome> {
  if (attachment === null) {
    return { ok: false, reason: 'the document had no stored file to attach' };
  }

  let bytes: Buffer;
  try {
    bytes = await read(attachment.s3Key);
  } catch (error) {
    // A missing object is a real condition — a purge, a bucket lifecycle rule —
    // and it must not fail the publish. The bill is still right.
    return {
      ok: false,
      reason: `the stored file could not be read (${error instanceof Error ? error.message : 'unknown error'})`,
    };
  }

  const type = attachment.mimeType.toLowerCase();
  const accepted = vendor.attachmentTypes.includes(type);

  if (accepted && bytes.byteLength <= vendor.attachmentMaxBytes) {
    return { ok: true, bytes, filename: attachment.filename, mimeType: type };
  }

  if (!RESIZABLE.has(type)) {
    return {
      ok: false,
      reason: accepted
        ? `the file is ${mb(bytes.byteLength)} and ${vendor.label} accepts at most ${mb(vendor.attachmentMaxBytes)}, and a ${type} cannot be made smaller without changing what it shows`
        : `${vendor.label} does not accept ${type} files`,
    };
  }

  // ⚠ The re-encode target is JPEG regardless of the source, which is why an
  // accepted-but-oversized PNG still goes through here: every one of the four
  // takes JPEG, so this can only ever widen what lands.
  for (const attempt of ATTEMPTS) {
    try {
      const pipeline = sharp(bytes, { failOn: 'none' }).rotate();
      const resized =
        attempt.maxEdge === null
          ? pipeline
          : pipeline.resize({ width: attempt.maxEdge, height: attempt.maxEdge, fit: 'inside', withoutEnlargement: true });
      const out = await resized.jpeg({ quality: attempt.quality, mozjpeg: true }).toBuffer();
      if (out.byteLength <= vendor.attachmentMaxBytes) {
        logger.log(
          `downscaled ${attachment.filename} from ${mb(bytes.byteLength)} to ${mb(out.byteLength)} for ${vendor.label}`,
        );
        return { ok: true, bytes: out, filename: jpegName(attachment.filename), mimeType: 'image/jpeg' };
      }
    } catch (error) {
      return {
        ok: false,
        reason: `the image could not be resized to fit ${vendor.label}'s ${mb(vendor.attachmentMaxBytes)} limit (${error instanceof Error ? error.message : 'unknown error'})`,
      };
    }
  }

  return {
    ok: false,
    reason: `the receipt is ${mb(bytes.byteLength)} and would not fit ${vendor.label}'s ${mb(vendor.attachmentMaxBytes)} limit even after resizing`,
  };
}

/** `IMG_4021.HEIC` → `IMG_4021.jpg`. The name follows the bytes, or a viewer refuses to open it. */
function jpegName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return `${dot <= 0 ? filename : filename.slice(0, dot)}.jpg`;
}

function mb(bytes: number): string {
  // One decimal place, and no float ever touches a `*Pence` name — this is a
  // file size, not money.
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
