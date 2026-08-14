import decode from 'heic-decode';
import sharp from 'sharp';

import type { AcceptedFormat } from './formats.js';
import type { ImageNormaliser, NormaliseResult } from './guards.js';
import { reject } from './reasons.js';

/**
 * The real image normaliser (issue #23): EXIF orientation applied and stripped,
 * HEIC decoded, everything re-encoded as JPEG.
 *
 * Two reasons this is more than a convenience:
 *
 *   - **Orientation.** A photo taken sideways carries its rotation in an EXIF
 *     tag rather than in the pixels. Extraction reads pixels, so without this a
 *     perfectly good receipt arrives rotated and reads as gibberish.
 *   - **EXIF is a privacy liability.** Phone photos carry GPS coordinates, the
 *     device serial and a timestamp. We have no use for any of it and no wish to
 *     hold a client's home address because they photographed a receipt there.
 *     Re-encoding drops the whole block rather than selected tags.
 */

/**
 * The decoded surface we will allocate for, in pixels.
 *
 * The channel byte cap cannot protect us here: compressed size says nothing
 * about decoded size, and a 200 KB file can legitimately describe a
 * 40,000 × 40,000 image — 1.6 gigapixels, 6.4 GB of RGBA, and an OOM that takes
 * the whole worker down rather than failing one document.
 *
 * 50 megapixels leaves generous headroom over a 48 MP iPhone photo (the largest
 * thing a real submitter sends) while refusing anything built to exhaust us.
 */
const DEFAULT_MAX_PIXELS = 50_000_000;

export interface SharpNormaliserOptions {
  readonly maxPixels?: number;
  readonly jpegQuality?: number;
}

export function createSharpImageNormaliser(options: SharpNormaliserOptions = {}): ImageNormaliser {
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const quality = options.jpegQuality ?? 85;

  return {
    async normalise(bytes: Buffer, format: AcceptedFormat): Promise<NormaliseResult> {
      try {
        const raw = format === 'heic' ? await decodeHeic(bytes, maxPixels) : null;
        if (raw !== null && !raw.ok) return raw;

        const pipeline =
          raw === null
            ? // `limitInputPixels` is checked against the HEADER, before any
              // pixels are decoded, so sharp refuses a bomb without allocating
              // for it. That is the whole reason it is passed rather than the
              // bytes being handed over unbounded.
              sharp(bytes, { limitInputPixels: maxPixels, failOn: 'error' })
            : sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } });

        // `.rotate()` with no argument applies the EXIF orientation tag and then
        // drops it. Output carries no metadata unless `.withMetadata()` is
        // called, which is exactly what we want and why it is not called.
        const out = await pipeline.rotate().jpeg({ quality, mozjpeg: true }).toBuffer();
        return { ok: true, bytes: out };
      } catch (error) {
        // Never rethrow. A malformed or hostile image must fail ONE document
        // with a reason the sender can act on, not raise through the worker
        // where it becomes a retry, then a DLQ entry, then a support question.
        return {
          ok: false,
          rejection: reject(
            'format_not_processable',
            'We could not read this image. Please resend it, or send a PDF or a photo taken with your camera app.',
            { reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' },
          ),
        };
      }
    },
  };
}

type HeicRaw =
  | { readonly ok: true; readonly width: number; readonly height: number; readonly data: Buffer }
  | { readonly ok: false; readonly rejection: ReturnType<typeof reject> };

/**
 * HEIC has to be decoded before sharp can see it — sharp's prebuilt binaries
 * carry no HEIF support, because that needs libvips built against libheif and
 * x265, and x265 is GPL (issue #7).
 *
 * `decode.all` is used rather than `decode` deliberately: it reports each
 * image's dimensions BEFORE any pixels are produced, which is the only point at
 * which a decode bomb can still be refused cheaply. `decode` would allocate
 * first and let us measure afterwards, which is not a check.
 */
async function decodeHeic(bytes: Buffer, maxPixels: number): Promise<HeicRaw> {
  const images = await decode.all({ buffer: bytes });
  try {
    const first = images[0];
    if (first === undefined) {
      return {
        ok: false,
        rejection: reject('format_not_processable', 'This HEIC file contains no image we could read. Please resend the photo as a JPEG.'),
      };
    }

    if (first.width * first.height > maxPixels) {
      return {
        ok: false,
        rejection: reject(
          'format_not_processable',
          'This image is too large for us to process. Please send a smaller photo.',
          { width: first.width, height: first.height, maxPixels },
        ),
      };
    }

    const decoded = await first.decode();
    return { ok: true, width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) };
  } finally {
    // The WASM heap is not garbage-collected on our behalf. `decode.all` holds
    // every image open until told otherwise, so skipping this leaks the decoded
    // surface on a long-running worker — invisible per document, fatal by the
    // ten-thousandth.
    images.dispose();
  }
}
