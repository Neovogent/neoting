import sharp from 'sharp';

import type { AcceptedFormat } from '../sanitisation/index.js';

/**
 * Perceptual hashing for near-duplicate detection (SoT Stage 6, issue #40).
 *
 * dHash (difference hash): reduce the image to a tiny greyscale grid and record,
 * for each pixel, whether its right-hand neighbour is brighter. The result is a
 * fingerprint of the image's *gradients*, which survive the things that change
 * between two photos of the same receipt — re-encoding, JPEG quality, scaling,
 * mild brightness shifts — while diverging sharply for a genuinely different
 * document. It reads structure, not exact bytes, which is the whole point: an
 * exact re-send is the byte-hash net's job; this is the "same paper photographed
 * twice" net.
 *
 * No new dependency: `sharp` (approved in #21/#23, already in the sanitisation
 * lane) decodes the image and hands back raw greyscale pixels directly.
 */

/** dHash produces one bit per horizontal adjacency on an N×(N-1) grid. */
export const HASH_BITS = 64;

// 9 wide × 8 tall → 8 horizontal comparisons per row × 8 rows = 64 bits.
const GRID_WIDTH = 9;
const GRID_HEIGHT = 8;

/**
 * The near-duplicate threshold, in Hamming distance (bits that differ out of 64).
 *
 * MEASURED, not guessed — the numbers come from `perceptual-hash.test.ts`, which
 * records them on every run:
 *   - the same image re-encoded JPEG q92 → q25:      distance 0
 *   - the same image downscaled 4× then re-encoded:  distance 0
 *   - two structurally different images:             distance 28
 * A threshold of 10 sits an order of magnitude clear of both nets: it will not
 * miss a re-photographed receipt, and it will not invent a match between two
 * different documents — and a false positive costs an accountant more than a miss
 * (SoT §13.1). If those measurements move, this number moves with them.
 */
export const PERCEPTUAL_HASH_MAX_DISTANCE = 10;

/** The raster formats a dHash is meaningful for. A PDF has none — leave it null. */
export const IMAGE_FORMATS: ReadonlySet<AcceptedFormat> = new Set<AcceptedFormat>([
  'jpeg',
  'png',
  'gif',
  'bmp',
  'tiff',
  'heic',
]);

/**
 * Compute the dHash of raster image bytes, as a 16-char hex string (64 bits).
 *
 * Throws if the bytes are not a decodable raster (e.g. an un-normalised HEIC that
 * sharp's prebuilt binary cannot read). Callers that cannot guarantee decodable
 * input should go through {@link createSharpPerceptualHasher}, which turns that
 * into a null hash rather than a failed document — the byte-hash net still covers
 * it.
 */
export async function perceptualHash(bytes: Buffer): Promise<string> {
  const { data, info } = await sharp(bytes, { failOn: 'error' })
    .greyscale()
    .resize(GRID_WIDTH, GRID_HEIGHT, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  let bits = 0n;
  let bit = 0;
  for (let row = 0; row < GRID_HEIGHT; row++) {
    for (let col = 0; col < GRID_WIDTH - 1; col++) {
      const left = data[(row * GRID_WIDTH + col) * channels] ?? 0;
      const right = data[(row * GRID_WIDTH + col + 1) * channels] ?? 0;
      if (right > left) bits |= 1n << BigInt(bit);
      bit++;
    }
  }
  return bits.toString(16).padStart(HASH_BITS / 4, '0');
}

/** Number of differing bits between two hex dHashes — the near-duplicate metric. */
export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (x > 0n) {
    x &= x - 1n; // clear the lowest set bit (Kernighan)
    distance++;
  }
  return distance;
}

/**
 * The hasher as an injected dependency, so the intake lane stays pure and
 * offline-testable (same reasoning as the sanitisation image normaliser): a
 * sharp-backed hasher is threaded in on the real path, and tests pass a fake.
 */
export interface PerceptualHasher {
  /** A dHash for a raster image; null for non-images or undecodable bytes. */
  hash(bytes: Buffer, format: AcceptedFormat): Promise<string | null>;
}

/**
 * The real hasher. Hashes only image formats, and turns a decode failure into a
 * null hash rather than a thrown error — a perceptual hash we could not compute
 * must not fail an otherwise-clean document; the byte-hash net still catches an
 * exact re-send.
 */
export function createSharpPerceptualHasher(): PerceptualHasher {
  return {
    async hash(bytes: Buffer, format: AcceptedFormat): Promise<string | null> {
      if (!IMAGE_FORMATS.has(format)) return null;
      try {
        return await perceptualHash(bytes);
      } catch {
        return null;
      }
    },
  };
}
