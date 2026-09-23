import { crc32 } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { safeEntryName, zipStream, type ZipEntry } from './store-zip.js';

/**
 * ⚠ **These tests READ the archive back rather than asserting the bytes the
 * writer just produced, and that is the whole point.**
 *
 * The first draft of `store-zip.ts` put the central-directory size and offset
 * at EOCD bytes 14 and 18 instead of 12 and 16. Every plausible
 * field-by-field assertion still passed — the writer and the assertion agreed
 * with each other, because the same wrong number was in both — and Python's
 * `zipfile` refused the file outright with *"Bad offset for central
 * directory"*. A test that reads the archive through the directory, the way a
 * real extractor does, is the only shape that catches it.
 *
 * `readArchive` below is therefore deliberately NOT a mirror of the writer. It
 * navigates the way an extractor navigates: find the EOCD, trust only its
 * counts and offsets, walk the central directory, follow each entry's recorded
 * local-header offset, and verify each CRC. Every one of those steps is a
 * chance for a wrong offset to show up.
 */

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

interface ReadEntry {
  readonly name: string;
  readonly bytes: Buffer;
  readonly method: number;
  readonly flags: number;
}

/** A minimal extractor: EOCD → central directory → local headers, CRC-checked. */
function readArchive(archive: Buffer): ReadEntry[] {
  // The EOCD is the last 22 bytes when there is no comment, and this writer
  // never writes one.
  const eocd = archive.byteLength - 22;
  expect(archive.readUInt32LE(eocd)).toBe(EOCD_SIG);

  const total = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  const directoryAt = archive.readUInt32LE(eocd + 16);

  // The directory must END exactly where the EOCD begins. This single
  // assertion is what the 14/18 bug failed.
  expect(directoryAt + directorySize).toBe(eocd);

  const entries: ReadEntry[] = [];
  let cursor = directoryAt;
  for (let i = 0; i < total; i += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(CENTRAL_SIG);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const sum = archive.readUInt32LE(cursor + 16);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localAt = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    // Follow the directory's own pointer to the local header, as an extractor
    // does — not by walking forward from the previous entry.
    expect(archive.readUInt32LE(localAt)).toBe(LOCAL_SIG);
    const localNameLength = archive.readUInt16LE(localAt + 26);
    const localExtraLength = archive.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLength + localExtraLength;
    const bytes = archive.subarray(dataAt, dataAt + size);

    // The CRC in the directory must match the bytes actually stored.
    expect(crc32(bytes) >>> 0).toBe(sum);
    entries.push({ name, bytes: Buffer.from(bytes), method, flags });

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  // The walk must land exactly on the EOCD, proving no entry's record length
  // was miscounted.
  expect(cursor).toBe(eocd);
  return entries;
}

async function build(entries: ZipEntry[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of zipStream(entries)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('zipStream', () => {
  it('round-trips every byte, through the central directory', async () => {
    // Deliberately awkward: UTF-8 in a name, an empty file, and 5,000 bytes of
    // binary that a text-mode bug would corrupt.
    const binary = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
    const archive = await build([
      { name: 'Wolseley £86.40 café.jpg', bytes: Buffer.from('hello vault', 'utf8') },
      { name: 'empty.txt', bytes: Buffer.alloc(0) },
      { name: 'binary.bin', bytes: binary },
    ]);

    const read = readArchive(archive);
    expect(read.map((e) => e.name)).toEqual(['Wolseley £86.40 café.jpg', 'empty.txt', 'binary.bin']);
    expect(read[0]?.bytes.toString('utf8')).toBe('hello vault');
    expect(read[1]?.bytes.byteLength).toBe(0);
    // `toEqual` on Buffers compares contents — a single flipped byte fails.
    expect(read[2]?.bytes).toEqual(binary);
  });

  it('stores rather than compresses, and flags names as UTF-8', async () => {
    const archive = await build([{ name: 'a.pdf', bytes: Buffer.from('x') }]);
    const [entry] = readArchive(archive);
    // Method 0 — the decision in the module header. A non-zero here means
    // someone added compression, and every size field would then be wrong.
    expect(entry?.method).toBe(0);
    // Bit 11. Without it the £ in the test above decodes as IBM-437 rubbish.
    expect((entry?.flags ?? 0) & 0x0800).toBe(0x0800);
  });

  it('writes a valid, empty archive when the client has no documents', async () => {
    // A client who has sent nothing still presses Download. An archive with no
    // entries is the honest answer and must still open.
    const archive = await build([]);
    expect(archive.byteLength).toBe(22);
    expect(readArchive(archive)).toEqual([]);
  });
});

describe('safeEntryName', () => {
  it('neutralises the zip-slip shapes, because names come off scanned documents', () => {
    // Nothing that comes back may contain a path separator, so no entry can
    // escape the directory it is extracted into.
    for (const hostile of ['../../etc/passwd', '..\\..\\windows\\system32', '/absolute/path']) {
      const safe = safeEntryName(hostile, 'fallback');
      expect(safe).not.toContain('/');
      expect(safe).not.toContain('\\');
      expect(safe.startsWith('.')).toBe(false);
    }
  });

  it('strips control characters and Windows-reserved punctuation', () => {
    // Built by code point so this test contains no raw control bytes either.
    const nasty = `in${String.fromCharCode(0)}voice${String.fromCharCode(31)}:*?.pdf`;
    expect(safeEntryName(nasty, 'fallback')).toBe('invoice.pdf');
  });

  it('keeps the pound signs and accents a UK receipt actually carries', () => {
    expect(safeEntryName('Café Nero £12.50', 'fallback')).toBe('Café Nero £12.50');
  });

  it('falls back when sanitising leaves nothing, rather than an unnamed entry', () => {
    expect(safeEntryName('///', 'document')).toBe('document');
    expect(safeEntryName('   ', 'document')).toBe('document');
  });

  it('caps the length so the path stays inside the filesystem limit', () => {
    expect(safeEntryName('x'.repeat(400), 'fallback')).toHaveLength(120);
  });
});
