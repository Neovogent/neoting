import { describe, expect, test } from 'vitest';

import { ZipError, assertZipEntryName, buildZipArchive, crc32 } from './zip.js';

/**
 * A hand-rolled archive writer earns its tests the hard way, because a wrong
 * offset or a signed CRC produces a file that opens in one tool and fails in
 * another — and the tool that fails is the accountant's.
 *
 * So the archive is read back by an INDEPENDENT parser written below, from the
 * end-of-central-directory record inwards, exactly as a real extractor does.
 * Asserting on the bytes the writer produced with the writer's own logic would
 * prove nothing.
 */

// ---------------------------------------------------------------------------
// A minimal, independent ZIP reader
// ---------------------------------------------------------------------------

interface ReadEntry {
  name: string;
  bytes: Buffer;
  crc: number;
  method: number;
}

function readZip(archive: Buffer): ReadEntry[] {
  // End of central directory: the last 22 bytes, since we write no comment.
  const eocd = archive.length - 22;
  expect(archive.readUInt32LE(eocd)).toBe(0x0605_4b50);

  const entryCount = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  const directoryOffset = archive.readUInt32LE(eocd + 16);
  expect(directoryOffset + directorySize).toBe(eocd);

  const entries: ReadEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    expect(archive.readUInt32LE(cursor)).toBe(0x0201_4b50);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('ascii');

    // Follow the offset into the local header, the way an extractor does.
    expect(archive.readUInt32LE(localOffset)).toBe(0x0403_4b50);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    expect(archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('ascii')).toBe(name);
    expect(compressedSize).toBe(uncompressedSize);

    entries.push({ name, bytes: archive.subarray(dataStart, dataStart + uncompressedSize), crc, method });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  expect(cursor).toBe(eocd);
  return entries;
}

// ---------------------------------------------------------------------------

describe('CRC-32', () => {
  test('matches the published check value', () => {
    // The canonical IEEE 802.3 test vector. If this is wrong, every archive we
    // write is corrupt in a way no local test would notice.
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf4_3926);
  });

  test('is unsigned — a signed 32-bit result would throw on write, or worse, not', () => {
    // JavaScript's bitwise operators produce SIGNED results, so a missing
    // `>>> 0` yields a negative number that `writeUInt32LE` rejects.
    for (const sample of ['', 'a', 'invoice.pdf', '\u0000\u00ff'.repeat(64)]) {
      const value = crc32(Buffer.from(sample, 'binary'));
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffff_ffff);
    }
  });

  test('an empty buffer is zero', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe('the archive is readable by an independent parser', () => {
  test('one entry round-trips, byte for byte', () => {
    const bytes = Buffer.from('%PDF-1.4\nhello\n', 'ascii');
    const entries = readZip(buildZipArchive([{ name: 'documents/A7K2M9PQ.pdf', bytes }]));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('documents/A7K2M9PQ.pdf');
    expect(entries[0]?.bytes.equals(bytes)).toBe(true);
    expect(entries[0]?.crc).toBe(crc32(bytes));
    expect(entries[0]?.method).toBe(0); // STORED
  });

  test('several entries keep their order and their own bytes', () => {
    const files = [
      { name: 'manifest.csv', bytes: Buffer.from('Code,File\r\n', 'ascii') },
      { name: 'documents/A0000BCD.pdf', bytes: Buffer.from([0x25, 0x50, 0x44, 0x46]) },
      { name: 'documents/B1111CDE.jpg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]) },
    ];
    const entries = readZip(buildZipArchive(files));

    expect(entries.map((entry) => entry.name)).toEqual(files.map((file) => file.name));
    for (const [index, entry] of entries.entries()) {
      expect(entry.bytes.equals(files[index]!.bytes)).toBe(true);
    }
  });

  test('binary payloads survive — every byte value, in order', () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const entries = readZip(buildZipArchive([{ name: 'documents/A0000BCD.bin', bytes }]));
    expect(entries[0]?.bytes.equals(bytes)).toBe(true);
  });

  test('an empty entry is legal and round-trips', () => {
    const entries = readZip(buildZipArchive([{ name: 'documents/A0000BCD.bin', bytes: Buffer.alloc(0) }]));
    expect(entries[0]?.bytes).toHaveLength(0);
    expect(entries[0]?.crc).toBe(0);
  });

  test('an archive with no entries is still a valid, empty archive', () => {
    expect(readZip(buildZipArchive([]))).toEqual([]);
  });

  test('the same input produces the same bytes — no clock leaks into the archive', () => {
    const input = [{ name: 'manifest.csv', bytes: Buffer.from('a', 'ascii') }];
    expect(buildZipArchive(input).equals(buildZipArchive(input))).toBe(true);
  });
});

describe('⚠ refusals — an archive is a place paths get written to disk', () => {
  test('a traversal name is refused', () => {
    for (const name of ['../etc/passwd', 'documents/../../x', 'a/./b', 'a//b']) {
      expect(() => assertZipEntryName(name), name).toThrow(ZipError);
    }
  });

  test('an absolute path or a drive letter is refused', () => {
    expect(() => assertZipEntryName('/etc/passwd')).toThrow(/must be relative/);
    expect(() => assertZipEntryName('C:/Windows/system32')).toThrow(/must be relative/);
  });

  test('a backslash is refused — it is a separator on the platform VT runs on', () => {
    // `a\..\..\b` is a traversal the forward-slash check alone would miss.
    expect(() => assertZipEntryName('a\\..\\..\\b')).toThrow(/backslash/);
  });

  test('a non-printable or non-ASCII name is refused', () => {
    expect(() => assertZipEntryName('doc\u0000.pdf')).toThrow(ZipError);
    expect(() => assertZipEntryName('facture-café.pdf')).toThrow(ZipError);
    expect(() => assertZipEntryName('')).toThrow(ZipError);
  });

  test('two entries with one name are refused, because an extractor loses one silently', () => {
    expect(() =>
      buildZipArchive([
        { name: 'documents/A0000BCD.pdf', bytes: Buffer.from('one') },
        { name: 'documents/A0000BCD.pdf', bytes: Buffer.from('two') },
      ]),
    ).toThrow(/duplicate entry name/);
  });

  test('a name that is fine is returned unchanged', () => {
    expect(assertZipEntryName('documents/A7K2M9PQ.pdf')).toBe('documents/A7K2M9PQ.pdf');
    expect(assertZipEntryName('manifest.csv')).toBe('manifest.csv');
  });
});
