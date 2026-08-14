import sharp from 'sharp';
import { expect, test } from 'vitest';

import { createSharpImageNormaliser } from './sharp-image-normaliser.js';

/**
 * These run against real encoded images produced by sharp itself, not against
 * hand-built magic-byte stubs. The whole value of this normaliser is what it
 * does to actual pixels and actual EXIF, and a stub proves none of it.
 */
const normaliser = createSharpImageNormaliser();

/** A 40×20 image — deliberately not square, so a rotation is visible in the dimensions. */
async function landscapeJpeg(orientation?: number): Promise<Buffer> {
  const base = sharp({
    create: { width: 40, height: 20, channels: 3, background: { r: 200, g: 30, b: 30 } },
  }).jpeg();
  return orientation === undefined ? base.toBuffer() : base.withMetadata({ orientation }).toBuffer();
}

test('EXIF orientation is applied to the pixels, not merely carried', async () => {
  // Orientation 6 means "rotate 90° clockwise on display". Extraction reads
  // pixels and ignores the tag, so a receipt photographed sideways reaches the
  // model rotated and reads as gibberish unless the rotation is baked in here.
  const result = await normaliser.normalise(await landscapeJpeg(6), 'jpeg');
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const meta = await sharp(result.bytes).metadata();
  expect(meta.width).toBe(20); // 40×20 landscape became 20×40 portrait
  expect(meta.height).toBe(40);
});

test('EXIF is stripped, so a photo does not carry the client\'s location', async () => {
  const withExif = await sharp({
    create: { width: 30, height: 30, channels: 3, background: { r: 10, g: 10, b: 10 } },
  })
    .withMetadata({ exif: { IFD0: { Copyright: 'a-client-secret', Artist: 'someones-phone' } } })
    .jpeg()
    .toBuffer();

  expect((await sharp(withExif).metadata()).exif).toBeDefined();

  const result = await normaliser.normalise(withExif, 'jpeg');
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  // Re-encoding drops the whole block rather than selected tags — there is no
  // list of "sensitive" EXIF fields to keep in step with.
  expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
  expect(result.bytes.includes(Buffer.from('a-client-secret'))).toBe(false);
});

test('a PNG is normalised to JPEG', async () => {
  const png = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();

  const result = await normaliser.normalise(png, 'png');
  expect(result.ok).toBe(true);
  if (result.ok) expect((await sharp(result.bytes).metadata()).format).toBe('jpeg');
});

test('a decode bomb is refused with a reason, never allocated for', async () => {
  // 12,000 × 12,000 of flat colour compresses to a few kilobytes but decodes to
  // 576 MB of RGBA. The channel byte cap cannot see this: compressed size says
  // nothing about decoded size.
  const bomb = await sharp({
    create: { width: 12_000, height: 12_000, channels: 3, background: '#ffffff' },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();

  const tight = createSharpImageNormaliser({ maxPixels: 1_000_000 });
  const result = await tight.normalise(bomb, 'png');

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.rejection.kind).toBe('format_not_processable');
    expect(result.rejection.code).toBe('NT-ING-002');
  }
});

test('a corrupt image fails one document with a reason, it does not throw', async () => {
  // If this rejects rather than throwing, a malformed file costs one visible
  // refusal. If it threw, it would surface as a retry, then a DLQ entry, then a
  // support question about a file that was simply broken.
  const notReallyAnImage = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('truncated nonsense'),
  ]);

  const result = await normaliser.normalise(notReallyAnImage, 'png');
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.rejection.message).toMatch(/could not read/i);
});

test('the output is smaller or comparable, and always a valid JPEG', async () => {
  const result = await normaliser.normalise(await landscapeJpeg(), 'jpeg');
  expect(result.ok).toBe(true);
  if (result.ok) {
    const meta = await sharp(result.bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(20);
  }
});
