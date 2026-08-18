import { expect, test } from 'vitest';

import { asJpegName, CAPTURE_JPEG_QUALITY, dataUrlToBlob } from './capture';

/**
 * The pure half of the capture path. The encode itself needs a canvas, which
 * jsdom does not implement, so what is tested here is everything either side of
 * it: the bytes coming back out of a data URL exactly as they went in, and the
 * name the compressed file is given.
 */

/** jsdom's Blob has no `text()`; `arrayBuffer()` is shimmed in `vitest.setup.ts`. */
const asText = async (blob: Blob) => new TextDecoder().decode(await blob.arrayBuffer());

test('a base64 data URL round-trips to the bytes it encodes', async () => {
  const blob = dataUrlToBlob(`data:image/jpeg;base64,${btoa('receipt-bytes')}`);
  expect(blob.type).toBe('image/jpeg');
  expect(await asText(blob)).toBe('receipt-bytes');
});

test('binary that is not valid UTF-8 survives — a JPEG is not text', async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  const base64 = btoa(String.fromCharCode(...bytes));
  const blob = dataUrlToBlob(`data:image/jpeg;base64,${base64}`);
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
});

test('a URL-encoded data URL is decoded rather than sent as its escapes', async () => {
  const blob = dataUrlToBlob('data:text/plain,hello%20there');
  expect(await asText(blob)).toBe('hello there');
});

test('anything that is not a data URL is refused rather than uploaded as a string', () => {
  expect(() => dataUrlToBlob('https://example.test/receipt.jpg')).toThrow();
});

test('a compressed page is named for what is now in it', () => {
  expect(asJpegName('receipt.heic')).toBe('receipt.jpg');
  expect(asJpegName('scan')).toBe('scan.jpg');
  expect(asJpegName('.hidden')).toBe('.hidden.jpg');
});

test('the quality is the one BusinessCaptureView already ships', () => {
  // Pinned, because the two are meant to produce the same picture and the only
  // thing keeping them agreed is that this number does not drift.
  expect(CAPTURE_JPEG_QUALITY).toBe(0.86);
});
