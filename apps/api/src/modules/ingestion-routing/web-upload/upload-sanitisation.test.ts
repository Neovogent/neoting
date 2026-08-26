import sharp from 'sharp';
import { expect, test } from 'vitest';

import type { AcceptedFormat } from '../lib/sanitisation/formats.js';
import type { ImageNormaliser, NormaliseResult } from '../lib/sanitisation/guards.js';
import { createSharpImageNormaliser } from '../lib/sanitisation/sharp-image-normaliser.js';
import { createSharpPerceptualHasher } from '../lib/dedupe/perceptual-hash.js';
import { capChannelFor } from './upload-policy.js';
import { effectiveFormat, sanitiseUploadBytes } from './upload-sanitisation.js';

/**
 * Stage A3 — the sanitisation web and portal uploads never had.
 *
 * These run against REAL encoded images produced by sharp and the REAL
 * normaliser, not against magic-byte stubs, for the same reason
 * `sharp-image-normaliser.test.ts` does: the whole value of this step is what it
 * does to actual pixels and actual EXIF, and a stub proves none of it.
 */
const realNormaliser = createSharpImageNormaliser();
const realHasher = createSharpPerceptualHasher();

/** The internal cap channel a `WEB_UPLOAD` document falls under (100 MB). */
const WEB = capChannelFor('WEB_UPLOAD');
/** The phone-ish 25 MB lane a portal (`SMS_PORTAL`) upload falls under. */
const PORTAL = capChannelFor('SMS_PORTAL');

async function jpegWithGps(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 90, g: 140, b: 60 } } })
    .withMetadata({
      // IFD3 is the GPS IFD — the block that carries where a client was standing
      // when they photographed the receipt, and the one `sharp-image-normaliser.ts`
      // calls a privacy liability in its own header.
      exif: {
        IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'W' },
        IFD0: { Copyright: 'home-address-of-a-client', Artist: 'someones-iphone' },
      },
    })
    .jpeg()
    .toBuffer();
}

// ── EXIF, which the privacy notice already promised we strip ─────────────────

test('an uploaded phone photo loses its EXIF — the privacy notice becomes true on this lane', async () => {
  const original = await jpegWithGps();
  // The premise: the bytes the browser PUT really do carry the block.
  expect((await sharp(original).metadata()).exif).toBeDefined();
  expect(original.includes(Buffer.from('home-address-of-a-client'))).toBe(true);

  const result = await sanitiseUploadBytes({ bytes: original, channel: WEB }, { imageNormaliser: realNormaliser });
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  // Re-encoding drops the whole block rather than selected tags, so there is no
  // list of "sensitive" fields to keep in step with.
  expect((await sharp(result.document.bytes).metadata()).exif).toBeUndefined();
  expect(result.document.bytes.includes(Buffer.from('home-address-of-a-client'))).toBe(false);
  expect(result.document.bytes.includes(Buffer.from('someones-iphone'))).toBe(false);
  // And the identity travels with the CLEANED bytes, not the originals — the row
  // must not end up hashing a file we did not store.
  expect(result.document.sha256).not.toBe(
    // the original's hash, computed the same way the pipeline does
    (await import('node:crypto')).createHash('sha256').update(original).digest('hex'),
  );
  expect(result.document.byteLength).toBe(result.document.bytes.length);
});

test('EXIF orientation is baked into the pixels, so a sideways receipt reads', async () => {
  const sideways = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#c81e1e' } })
    .jpeg()
    .withMetadata({ orientation: 6 }) // "rotate 90° clockwise on display"
    .toBuffer();

  const result = await sanitiseUploadBytes({ bytes: sideways, channel: WEB }, { imageNormaliser: realNormaliser });
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  const meta = await sharp(result.document.bytes).metadata();
  expect(meta.width).toBe(20); // 40×20 landscape became 20×40 portrait
  expect(meta.height).toBe(40);
});

// ── HEIC → JPEG, and the MIME that has to move with it ───────────────────────

/**
 * ⚠ THE TRAP THAT WOULD HAVE MADE THE HEIC FIX USELESS.
 *
 * `pipeline.ts` returns `accepted(bytes, detected)` where `detected` was sniffed
 * from the INPUT and `bytes` are what the normaliser produced — and the
 * normaliser re-encodes every image to JPEG. So a converted HEIC comes back
 * labelled `heic` while carrying JPEG bytes, and `mimeForFormat(detectedType)`
 * would write `image/heic` onto a row whose object is a JPEG.
 *
 * `BedrockExtractor` decides what it may send from `documents.mime_type`, so
 * that mislabel alone re-creates `NT-EXT-003` on the very format A3 exists to
 * fix. The re-sniff is what stops it.
 */
test('effectiveFormat re-sniffs the OUTPUT, so converted bytes are not labelled by their input', async () => {
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000000' } })
    .jpeg()
    .toBuffer();
  expect(effectiveFormat(jpeg, 'heic')).toBe('jpeg');

  // A format sniffing cannot answer for falls back to what step 1 decided,
  // rather than storing `unknown`.
  expect(effectiveFormat(Buffer.from('not a recognised signature'), 'rtf')).toBe('rtf');
});

/**
 * A HEIC standing in for a real one, because nothing available can ENCODE one
 * (this repo has no HEIC fixture and sharp's prebuilt binaries carry no HEIF —
 * `lib/sanitisation` says so in its own TODO). So the decoder is stubbed with
 * something that behaves exactly as `createSharpImageNormaliser` does for HEIC:
 * it hands back real JPEG bytes. What is under test here is everything AFTER
 * the decode — the part that was wrong.
 */
function heicNormaliserEmitting(jpeg: Buffer): ImageNormaliser {
  return {
    async normalise(_bytes: Buffer, format: AcceptedFormat): Promise<NormaliseResult> {
      if (format !== 'heic') throw new Error(`this stub only stands in for HEIC, got ${format}`);
      return { ok: true, bytes: jpeg };
    },
  };
}

test('an iPhone HEIC becomes a JPEG, and is REPORTED as one', async () => {
  const jpeg = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#336699' } })
    .jpeg()
    .toBuffer();
  // A minimal ISO-BMFF header with a `heic` brand — all `sniff` reads.
  const heic = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypheic', 'latin1'),
    Buffer.alloc(16),
  ]);

  const result = await sanitiseUploadBytes(
    { bytes: heic, channel: PORTAL },
    { imageNormaliser: heicNormaliserEmitting(jpeg), perceptualHasher: realHasher },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;

  expect(result.document.format).toBe('jpeg');
  expect(result.document.mimeType).toBe('image/jpeg'); // NOT image/heic
  expect((await sharp(result.document.bytes).metadata()).format).toBe('jpeg');
  // The dHash is computed against what the bytes now ARE. Told they were HEIC,
  // the hasher would have decoded them anyway — but a format outside its image
  // set would have returned null, and the near-duplicate net would stay empty on
  // this lane exactly as it was before A3.
  expect(result.document.perceptualHash).toMatch(/^[0-9a-f]{16}$/);
});

test('with IMAGE_NORMALISER=fixture a HEIC is a VISIBLE refusal, never a pass-through', async () => {
  // The default deps are the offline fixtures. The fixture normaliser refuses
  // HEIC on purpose: passing it through was the original bug — the file sailed
  // through sanitisation and failed in extraction looking corrupt, so the
  // accountant was told the wrong thing about a photo that was fine.
  const heic = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypheic', 'latin1'),
    Buffer.alloc(16),
  ]);
  const result = await sanitiseUploadBytes({ bytes: heic, channel: PORTAL });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.rejection.kind).toBe('format_not_processable');
  expect(result.rejection.code).toBe('NT-ING-002');
  expect(result.rejection.message).toMatch(/HEIC/);
});

// ── The magic bytes decide, not the browser ─────────────────────────────────

test('the stored type comes from the bytes — a PNG uploaded as anything is a PNG until it is normalised', async () => {
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();

  // With the fixture normaliser (a passthrough for ordinary rasters) the bytes
  // stay PNG, and that is what is reported — nothing here ever saw a declared
  // MIME, which is the point: `sanitiseUploadBytes` takes bytes and a channel,
  // and there is no parameter through which a browser's claim could reach it.
  const passthrough = await sanitiseUploadBytes({ bytes: png, channel: WEB });
  expect(passthrough.ok).toBe(true);
  if (passthrough.ok) expect(passthrough.document.mimeType).toBe('image/png');

  // With the REAL normaliser the same bytes come back as JPEG, and the reported
  // type follows the bytes rather than the input format.
  const normalised = await sanitiseUploadBytes({ bytes: png, channel: WEB }, { imageNormaliser: realNormaliser });
  expect(normalised.ok).toBe(true);
  if (normalised.ok) expect(normalised.document.mimeType).toBe('image/jpeg');
});

test('a PDF is reported as application/pdf and goes through the document guard', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1');
  const result = await sanitiseUploadBytes({ bytes: pdf, channel: WEB });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.document.format).toBe('pdf');
  expect(result.document.mimeType).toBe('application/pdf');
  expect(result.document.perceptualHash).toBeNull(); // a PDF has no meaningful dHash
});

test('a password-protected PDF is refused with a reason a client can act on', async () => {
  const encrypted = Buffer.from('%PDF-1.4\ntrailer\n<< /Encrypt 9 0 R >>\n%%EOF\n', 'latin1');
  const result = await sanitiseUploadBytes({ bytes: encrypted, channel: WEB });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.rejection.kind).toBe('password_protected');
  expect(result.rejection.message).toMatch(/password/i);
});

test('bytes matching no accepted signature are refused, not stored', async () => {
  const result = await sanitiseUploadBytes({ bytes: Buffer.from('MZ\x90\x00 an executable'), channel: WEB });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.rejection.kind).toBe('type_not_allowed');
  expect(result.rejection.code).toBe('NT-ING-002');
});

// ── The size cap, enforced where the bytes actually are ─────────────────────

test('the cap is the CHANNEL\'s, and the portal lane is the tighter one', async () => {
  // The door checks the client's DECLARED size; this is the check against the
  // bytes that actually landed. 25 MB on the portal lane, 100 MB on web upload —
  // both read from the same `CHANNEL_POLICY` the intent endpoint used.
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  const oversize = Buffer.concat([png, Buffer.alloc(26 * 1024 * 1024)]);

  const portal = await sanitiseUploadBytes({ bytes: oversize, channel: PORTAL });
  expect(portal.ok).toBe(false);
  if (!portal.ok) {
    expect(portal.rejection.kind).toBe('oversize');
    expect(portal.rejection.code).toBe('NT-ING-001');
  }

  // The same bytes are inside the accountant lane's 100 MB cap.
  const web = await sanitiseUploadBytes({ bytes: oversize, channel: WEB });
  expect(web.ok).toBe(true);
});

test('capChannelFor maps the arrival channels this lane can actually see', () => {
  expect(capChannelFor('WEB_UPLOAD')).toBe('accountant_upload');
  expect(capChannelFor('SMS_PORTAL')).toBe('client');
  expect(capChannelFor('CHAT_UPLOAD')).toBe('client');
});
