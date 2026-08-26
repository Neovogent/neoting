import { createHash } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { AcceptedFormat } from '../lib/sanitisation/formats.js';
import type { ImageNormaliser, NormaliseResult } from '../lib/sanitisation/guards.js';
import { createSharpImageNormaliser } from '../lib/sanitisation/sharp-image-normaliser.js';
import { createSharpPerceptualHasher } from '../lib/dedupe/perceptual-hash.js';
import { InMemoryDocumentStore, uploadIntentKey } from '../storage/document-store.js';
import { PrismaUploadSanitisationStep } from './prisma-upload-sanitisation.js';

/**
 * Stage A3's acceptance, proven against a REAL database.
 *
 * The unit tests show what the pipeline does to bytes. Only this can show the
 * three things that actually matter to a client:
 *
 *   - an iPhone HEIC upload ends up as a JPEG **on the row**, so extraction
 *     reads `mime_type` and does not answer `NT-EXT-003`;
 *   - the object we actually keep carries **no EXIF**, which is what the privacy
 *     notice already promised — a function returning clean bytes proves nothing
 *     if the row still points at the originals;
 *   - a refused upload lands REJECTED with a reason, on the Rejected/Failed
 *     surface, rather than being dropped or dead-lettered.
 *
 * Everything is written through `scopedDb` under the practice SYSTEM actor, so
 * RLS — not this test — is what admits the writes.
 *
 * Skipped visibly when no database is CONFIGURED; `beforeAll` throws (a red run)
 * when one is configured but unreachable.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];

let owner: PrismaClient;
let app: PrismaClient;

const P = 'a3u_prac';
const B = 'a3u_biz';
const SYS = 'a3u_sys';
const MEM = 'a3u_mem_sys';

/** Every document this suite creates, by explicit id — see `cleanup`. */
const DOCUMENT_IDS = ['a3u_heic', 'a3u_exif', 'a3u_locked', 'a3u_idem', 'a3u_lying_mime'] as const;

const store = new InMemoryDocumentStore();

/** A JPEG carrying a marker in EXIF — the stand-in for a phone photo's GPS block. */
const EXIF_MARKER = 'home-address-of-a-client';

async function jpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 90, g: 140, b: 60 } } })
    .withMetadata({
      exif: {
        IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'W' },
        IFD0: { Copyright: EXIF_MARKER, Artist: 'someones-iphone' },
      },
    })
    .jpeg()
    .toBuffer();
}

/** A minimal ISO-BMFF header with a `heic` brand — all `sniff` reads of a HEIC. */
const HEIC_HEADER = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypheic', 'latin1'),
  Buffer.alloc(16),
]);

/**
 * Stands in for the HEIC branch of `createSharpImageNormaliser`: nothing
 * available can ENCODE a HEIC (sharp's prebuilt binaries carry no HEIF), so the
 * decode is faked and everything after it — the re-sniff, the MIME, the re-key,
 * the row — is real. Non-HEIC formats go to the real normaliser, so the EXIF
 * test below is not stubbed in any way.
 */
function heicAwareNormaliser(jpeg: Buffer): ImageNormaliser {
  const real = createSharpImageNormaliser();
  return {
    async normalise(bytes: Buffer, format: AcceptedFormat): Promise<NormaliseResult> {
      if (format === 'heic') return { ok: true, bytes: jpeg };
      return real.normalise(bytes, format);
    },
  };
}

function step(normaliser: ImageNormaliser): PrismaUploadSanitisationStep {
  return new PrismaUploadSanitisationStep(app, {
    store,
    imageNormaliser: normaliser,
    perceptualHasher: createSharpPerceptualHasher(),
  });
}

/**
 * A document exactly as `WebUploadService.completeUpload` leaves it: RECEIVED,
 * at the `uploads/<nonce>` intent key, with the BROWSER'S declared MIME and the
 * original bytes' hash on the row.
 */
async function seedUpload(id: string, opts: { bytes: Buffer; declaredMime: string; filename: string }): Promise<void> {
  const key = uploadIntentKey(B, id);
  store.putRaw(key, opts.bytes);
  await owner.document.create({
    data: {
      id,
      practiceId: P,
      businessId: B,
      s3Key: key,
      byteHash: createHash('sha256').update(opts.bytes).digest('hex'),
      mimeType: opts.declaredMime,
      byteSize: opts.bytes.length,
      channel: 'WEB_UPLOAD',
      originalFilename: opts.filename,
      inbox: 'COSTS',
      state: 'RECEIVED',
    },
  });
}

/**
 * Cleanup by EXPLICIT id list, never `startsWith`. Prisma compiles
 * `startsWith: 'a3u_'` to `LIKE 'a3u_%'` and does not escape the `_`, which is
 * LIKE's single-character wildcard — so a prefix delete silently reaches into
 * whatever else happens to be one character along. Four suites share this
 * database.
 */
async function cleanup(): Promise<void> {
  await owner.documentEvent.deleteMany({ where: { documentId: { in: [...DOCUMENT_IDS] } } });
  await owner.document.deleteMany({ where: { id: { in: [...DOCUMENT_IDS] } } });
  await owner.business.deleteMany({ where: { id: B } });
  await owner.membership.deleteMany({ where: { id: MEM } });
  await owner.user.deleteMany({ where: { id: SYS } });
  await owner.practice.deleteMany({ where: { id: P } });
}

beforeAll(async () => {
  if (DATABASE_URL === undefined || OWNER_URL === undefined) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`; // configured-but-unreachable → throw, not skip

  await cleanup();
  await owner.practice.create({ data: { id: P, name: 'A3 Uploads' } });
  await owner.user.create({ data: { id: SYS, kind: 'SYSTEM' } });
  await owner.membership.create({ data: { id: MEM, userId: SYS, practiceId: P, role: 'PRACTICE_STANDARD' } });
  await owner.business.create({ data: { id: B, practiceId: P, name: 'A Cleaning Agency Ltd' } });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!DATABASE_URL || !OWNER_URL)('upload sanitisation against a real database', () => {
  test('an iPhone HEIC upload becomes a JPEG on the row — the §24.7 step that used to fail', async () => {
    const jpeg = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#336699' } })
      .jpeg()
      .toBuffer();
    const id = 'a3u_heic';
    await seedUpload(id, { bytes: HEIC_HEADER, declaredMime: 'image/heic', filename: 'IMG_4821.HEIC' });

    const result = await step(heicAwareNormaliser(jpeg)).run({
      documentId: id,
      practiceId: P,
      businessId: B,
      traceId: 'trace-a3u-heic',
    });
    expect(result.status).toBe('sanitised');

    const row = await owner.document.findUnique({ where: { id } });
    // `BedrockExtractor` decides what it may send from this column. `image/heic`
    // here is `NT-EXT-003` no matter how good the conversion was.
    expect(row?.mimeType).toBe('image/jpeg');
    expect(row?.byteHash).toBe(createHash('sha256').update(jpeg).digest('hex'));
    expect(row?.byteSize).toBe(jpeg.length);
    // Re-keyed off the `uploads/<nonce>` intent key onto the content-addressed
    // layout every other channel uses.
    expect(row?.s3Key).toBe(`w/${B}/documents/${row?.byteHash ?? ''}`);
    expect(await store.get(row?.s3Key ?? '')).toEqual(jpeg);
    // Web uploads carried no perceptual hash at all before this, so the "same
    // paper photographed twice" net did not cover the lane at all.
    expect(row?.perceptualHash).toMatch(/^[0-9a-f]{16}$/);
    // Sanitisation changes what the document IS, not where it is in the
    // pipeline — extraction is what moves it out of RECEIVED.
    expect(row?.state).toBe('RECEIVED');

    const events = await owner.documentEvent.findMany({ where: { documentId: id } });
    expect(events.map((e) => e.stage)).toEqual(['sanitise']);
    expect(events[0]?.outcome).toBe('sanitised');
  });

  test('the object we KEEP carries no EXIF — the privacy notice, made true', async () => {
    const original = await jpegWithExif();
    expect(original.includes(Buffer.from(EXIF_MARKER))).toBe(true);

    const id = 'a3u_exif';
    await seedUpload(id, { bytes: original, declaredMime: 'image/jpeg', filename: 'receipt.jpg' });
    await step(createSharpImageNormaliser()).run({
      documentId: id,
      practiceId: P,
      businessId: B,
      traceId: 'trace-a3u-exif',
    });

    const row = await owner.document.findUnique({ where: { id } });
    // Read back what the ROW points at, not what the function returned. A clean
    // Buffer nobody stored is not a privacy guarantee.
    const stored = await store.get(row?.s3Key ?? '');
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
    expect(stored.includes(Buffer.from(EXIF_MARKER))).toBe(false);
    expect(stored.includes(Buffer.from('someones-iphone'))).toBe(false);
    expect(row?.byteHash).toBe(createHash('sha256').update(stored).digest('hex'));
  });

  test('the stored MIME comes from the bytes, not from what the browser declared', async () => {
    // The declared type was allowlisted at the door as a cheap pre-filter. It is
    // still only a claim, and this is where the claim stops mattering.
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1');
    const id = 'a3u_lying_mime';
    await seedUpload(id, { bytes: pdf, declaredMime: 'image/jpeg', filename: 'invoice.jpg' });

    await step(createSharpImageNormaliser()).run({
      documentId: id,
      practiceId: P,
      businessId: B,
      traceId: 'trace-a3u-mime',
    });

    const row = await owner.document.findUnique({ where: { id } });
    expect(row?.mimeType).toBe('application/pdf');
    expect(row?.perceptualHash).toBeNull(); // a PDF has no meaningful dHash
  });

  test('a password-protected upload lands REJECTED with a reason a client can act on', async () => {
    const encrypted = Buffer.from('%PDF-1.4\ntrailer\n<< /Encrypt 9 0 R >>\n%%EOF\n', 'latin1');
    const id = 'a3u_locked';
    await seedUpload(id, { bytes: encrypted, declaredMime: 'application/pdf', filename: 'statement.pdf' });
    const intentKey = uploadIntentKey(B, id);

    const result = await step(createSharpImageNormaliser()).run({
      documentId: id,
      practiceId: P,
      businessId: B,
      traceId: 'trace-a3u-locked',
    });
    expect(result.status).toBe('rejected');

    const row = await owner.document.findUnique({ where: { id } });
    expect(row?.state).toBe('REJECTED');
    expect(row?.failureCode).toBe('NT-ING-004');
    expect(row?.failureMessage).toMatch(/password/i);
    // Nothing was re-keyed and nothing was re-hashed: a refusal must not leave
    // the row describing a file that was never accepted.
    expect(row?.s3Key).toBe(intentKey);

    // The state machine wrote the transition event; there is no `sanitise` event
    // because nothing was sanitised.
    const events = await owner.documentEvent.findMany({ where: { documentId: id } });
    expect(events.map((e) => e.outcome)).toEqual(['REJECTED']);
  });

  test('running twice sanitises once — a redelivery is an idempotent no-op', async () => {
    const original = await jpegWithExif();
    const id = 'a3u_idem';
    await seedUpload(id, { bytes: original, declaredMime: 'image/jpeg', filename: 'again.jpg' });

    const first = await step(createSharpImageNormaliser()).run({
      documentId: id, practiceId: P, businessId: B, traceId: 'trace-a3u-idem-1',
    });
    const second = await step(createSharpImageNormaliser()).run({
      documentId: id, practiceId: P, businessId: B, traceId: 'trace-a3u-idem-2',
    });

    expect(first.status).toBe('sanitised');
    // Not an error and not a second pass: the row is no longer RECEIVED, and
    // re-decoding a 100 MB batch on every redelivery is the cost this avoids.
    expect(second.status).toBe('already-sanitised');
    expect(await owner.documentEvent.count({ where: { documentId: id, stage: 'sanitise' } })).toBe(1);
  });
});
