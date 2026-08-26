import decode from 'heic-decode';
import sharp from 'sharp';

import type { AcceptedFormat } from './formats.js';
import type { ImageNormaliser, NormaliseResult } from './guards.js';
import { reject } from './reasons.js';

/**
 * The real image normaliser (issue #23): EXIF orientation applied and stripped,
 * HEIC decoded, everything re-encoded as JPEG, and — since A4 — downscaled when
 * the encoded result is too big for a reader to accept.
 *
 * Three reasons this is more than a convenience:
 *
 *   - **Orientation.** A photo taken sideways carries its rotation in an EXIF
 *     tag rather than in the pixels. Extraction reads pixels, so without this a
 *     perfectly good receipt arrives rotated and reads as gibberish.
 *   - **EXIF is a privacy liability.** Phone photos carry GPS coordinates, the
 *     device serial and a timestamp. We have no use for any of it and no wish to
 *     hold a client's home address because they photographed a receipt there.
 *     Re-encoding drops the whole block rather than selected tags.
 *   - **Size.** Until A4 this file never called `.resize()`, so an ordinary
 *     48 MP phone photo left here at 8–15 MB, sailed through ingest, and then
 *     hit `BedrockExtractor`'s 5 MB per-image ceiling as `NT-EXT-007` —
 *     "send a smaller photo", to a client who sent a perfectly ordinary one.
 *     Shrinking is something we can do and they cannot, so we do it.
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

/**
 * The encoded ceiling we normalise down to, in bytes.
 *
 * It is Anthropic's per-image limit, which `BedrockExtractor` enforces as
 * `MAX_IMAGE_BYTES` and refuses with `NT-EXT-007`. The number is STATED TWICE,
 * on purpose: `ingestion-routing` may not import `modules/extraction` (the
 * boundary is lint-enforced and the dependency would point the wrong way), and
 * inventing a shared constants module to hold one integer would be worse than
 * a comment naming the other end. If one moves, move both — the test in
 * `bedrock-extractor.test.ts` and the one here are the tripwire.
 *
 * Normalising to it is not the same as the extractor's guard replacing it. This
 * shrinks what shrinking can fix; the guard still refuses what it cannot (a
 * document that arrives at the extractor without passing through here — every
 * web upload, until A3 wires this into that lane).
 */
const DEFAULT_MAX_ENCODED_BYTES = 5 * 1024 * 1024;

/**
 * The long edge we downscale TO, once downscaling is needed.
 *
 * 1568 px is the resolution Anthropic's vision models work at — a larger image
 * is resized server-side before it is read, so sending more pixels costs more
 * bytes and buys no accuracy. It is also ~185 DPI across the long side of A4,
 * which is comfortably readable print.
 *
 * ⚠ It is a FLOOR-ON-DEMAND, not a blanket policy. An ordinary photo that
 * already encodes under the ceiling is left at its native resolution, because
 * these bytes are what D43's source-document link resolves to — the evidence an
 * accountant opens and zooms into. We degrade a client's evidence only as far
 * as we must, and not one rung further.
 */
const DEFAULT_MAX_LONG_EDGE = 1568;

/**
 * Where downscaling stops trying. Below this a receipt's small print is gone,
 * and handing the reader an unreadable image is worse than handing the guard an
 * oversized one — the guard says so out loud.
 */
const MIN_LONG_EDGE = 320;

/** Bounded work: an image gets at most this many shrink attempts after the first encode. */
const MAX_DOWNSCALE_ATTEMPTS = 4;

export interface SharpNormaliserOptions {
  readonly maxPixels?: number;
  readonly jpegQuality?: number;
  readonly maxEncodedBytes?: number;
  readonly maxLongEdge?: number;
}

export function createSharpImageNormaliser(options: SharpNormaliserOptions = {}): ImageNormaliser {
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const quality = options.jpegQuality ?? 85;
  const maxEncodedBytes = options.maxEncodedBytes ?? DEFAULT_MAX_ENCODED_BYTES;
  const maxLongEdge = options.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE;

  return {
    async normalise(bytes: Buffer, format: AcceptedFormat): Promise<NormaliseResult> {
      try {
        let raw: { readonly width: number; readonly height: number; readonly data: Buffer } | null = null;
        if (format === 'heic') {
          const decoded = await decodeHeic(bytes, maxPixels);
          if (!decoded.ok) return decoded;
          raw = decoded;
        }

        // A fresh pipeline per encode. sharp instances carry their output
        // options, so re-encoding at a different size/quality means opening the
        // source again rather than reconfiguring one that has already run.
        const open = (): ReturnType<typeof sharp> =>
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
        const encode = async (longEdge: number | null, q: number): Promise<Buffer> => {
          const base = open().rotate();
          const sized =
            longEdge === null
              ? base
              : base.resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true });
          return sized.jpeg({ quality: q, mozjpeg: true }).toBuffer();
        };

        let out = await encode(null, quality);
        if (out.byteLength > maxEncodedBytes) {
          out = await shrinkToFit(out, encode, {
            maxEncodedBytes,
            startEdge: Math.min(await longEdgeOf(raw, bytes, maxPixels, maxLongEdge), maxLongEdge),
            quality,
          });
        }
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

/**
 * The source image's long edge, so the first shrink lands somewhere sensible
 * rather than always jumping straight to the target.
 *
 * `metadata()` reads the header only — no pixels are decoded — and the long
 * edge is invariant under the EXIF rotation `.rotate()` applies, so reading it
 * before rotation is safe. A header that does not report dimensions falls back
 * to the target edge, which is the conservative direction: we shrink.
 */
async function longEdgeOf(
  raw: { readonly width: number; readonly height: number } | null,
  bytes: Buffer,
  maxPixels: number,
  fallback: number,
): Promise<number> {
  if (raw !== null) return Math.max(raw.width, raw.height);
  const meta = await sharp(bytes, { limitInputPixels: maxPixels, failOn: 'error' }).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const longest = Math.max(width, height);
  return longest > 0 ? longest : fallback;
}

/**
 * Shrink until the encoded JPEG fits the ceiling, or until shrinking stops
 * being worth doing.
 *
 * The step is measured, not guessed: JPEG size tracks pixel COUNT roughly
 * linearly, and pixel count is the square of the edge, so the edge that would
 * hit the target is `edge × √(target / actual)`. The 0.9 is deliberate
 * undershoot — overshooting costs another full encode, undershooting costs a
 * few percent of resolution.
 *
 * It is bounded on both axes (attempts and `MIN_LONG_EDGE`) because this runs
 * in the worker on bytes a stranger sent us, and an unbounded "keep trying"
 * loop on hostile input is a denial of service with good intentions. If it runs
 * out, it returns the smallest result it achieved: the extractor's own guard is
 * the backstop and refuses out loud, which beats grinding here in silence.
 */
async function shrinkToFit(
  first: Buffer,
  encode: (longEdge: number | null, quality: number) => Promise<Buffer>,
  limits: { readonly maxEncodedBytes: number; readonly startEdge: number; readonly quality: number },
): Promise<Buffer> {
  let best = first;
  let edge = Math.max(MIN_LONG_EDGE, Math.round(limits.startEdge));
  let quality = limits.quality;

  for (let attempt = 0; attempt < MAX_DOWNSCALE_ATTEMPTS; attempt += 1) {
    const candidate = await encode(edge, quality);
    if (candidate.byteLength < best.byteLength) best = candidate;
    if (candidate.byteLength <= limits.maxEncodedBytes) return candidate;
    if (edge <= MIN_LONG_EDGE) break;

    const ratio = Math.sqrt(limits.maxEncodedBytes / candidate.byteLength) * 0.9;
    edge = Math.max(MIN_LONG_EDGE, Math.round(edge * ratio));
    quality = Math.max(60, quality - 10);
  }

  return best;
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
