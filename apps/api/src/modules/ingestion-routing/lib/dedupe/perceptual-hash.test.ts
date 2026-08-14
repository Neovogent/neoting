import sharp from 'sharp';
import { describe, expect, test } from 'vitest';

import {
  HASH_BITS,
  hammingDistance,
  PERCEPTUAL_HASH_MAX_DISTANCE,
  perceptualHash,
} from './perceptual-hash.js';

/**
 * These tests are the deliverable as much as the code (issue #40): they PROVE the
 * two properties the dedupe threshold rests on and RECORD the actual distances
 * measured, so `PERCEPTUAL_HASH_MAX_DISTANCE` is traceable to numbers rather than
 * a guess. If a change moves these numbers, it fails here first.
 *
 * Images are generated deterministically from raw pixels rather than shipped as
 * binary fixtures — a checked-in JPEG is opaque, and its dHash would drift
 * silently if anything about decoding changed. Building the pixels here keeps the
 * property under the test's control.
 */

const W = 256;
const H = 256;

/** A raw RGB image from a per-pixel function, encoded to JPEG at a given quality. */
async function jpeg(fn: (x: number, y: number) => number, quality: number): Promise<Buffer> {
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = fn(x, y) & 0xff;
      const i = (y * W + x) * 3;
      raw[i] = v;
      raw[i + 1] = v;
      raw[i + 2] = v;
    }
  }
  return sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality }).toBuffer();
}

// A busy diagonal ramp — a hash with structure (not all-0 / all-1), so distances
// are meaningful. Stands in for "a document".
const receipt = (x: number, y: number): number => x + y * 2 + Math.floor(x / 16) * 8;
// A structurally different image: a cross-hatch whose gradients run the other way.
const different = (x: number, y: number): number => (x ^ y) * 3 + y;

describe('perceptualHash (dHash)', () => {
  test('is a 16-char (64-bit) hex string', async () => {
    const hash = await perceptualHash(await jpeg(receipt, 90));
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(HASH_BITS).toBe(64);
  });

  test('the same image re-encoded at a different JPEG quality hashes the same', async () => {
    const high = await perceptualHash(await jpeg(receipt, 92));
    const low = await perceptualHash(await jpeg(receipt, 25));
    const d = hammingDistance(high, low);
    // eslint-disable-next-line no-console
    console.log(`[measured] re-encode q92 -> q25: distance ${d}`);
    expect(d).toBeLessThanOrEqual(PERCEPTUAL_HASH_MAX_DISTANCE);
  });

  test('the same image downscaled then re-encoded stays close (scale invariance)', async () => {
    const full = await jpeg(receipt, 90);
    const small = await sharp(full).resize(64, 64).jpeg({ quality: 80 }).toBuffer();
    const d = hammingDistance(await perceptualHash(full), await perceptualHash(small));
    // eslint-disable-next-line no-console
    console.log(`[measured] downscale 4x: distance ${d}`);
    expect(d).toBeLessThanOrEqual(PERCEPTUAL_HASH_MAX_DISTANCE);
  });

  test('a structurally different image is far away — well beyond the threshold', async () => {
    const a = await perceptualHash(await jpeg(receipt, 90));
    const b = await perceptualHash(await jpeg(different, 90));
    const d = hammingDistance(a, b);
    // eslint-disable-next-line no-console
    console.log(`[measured] different image: distance ${d}`);
    expect(d).toBeGreaterThan(PERCEPTUAL_HASH_MAX_DISTANCE);
  });
});

describe('hammingDistance', () => {
  test('is zero for identical hashes and counts differing bits otherwise', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('ffffffffffffffff', 'ffffffffffffffff')).toBe(0);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistance('0000000000000000', '000000000000000f')).toBe(4);
  });
});
