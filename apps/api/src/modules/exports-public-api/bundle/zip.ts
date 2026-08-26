/**
 * A ZIP writer, written here rather than installed — D43 rung 4.
 *
 * ## Why no dependency
 *
 * Adding one is a stop-and-ask (root `CLAUDE.md`), and this module already
 * makes the same call twice for the same reason: `csv/csv.ts` hand-rolls RFC
 * 4180 and `csv/encoding.ts` hand-rolls Windows-1252 rather than pull a package
 * into the product's only egress. A **stored** (uncompressed) ZIP is a
 * genuinely small format — a local header per entry, a central directory, an
 * end-of-central-directory record — and it is the one every unzip tool on every
 * platform has read since 1989. Weighed against a transitive dependency tree in
 * the one code path that assembles a customer's financial documents into a
 * single file, the trade is not close.
 *
 * ## STORED, not DEFLATED, and that is a decision rather than laziness
 *
 * Method 0. The payload is PDFs and JPEGs — already entropy-coded, so deflate
 * buys single-digit percentages — plus one small CSV. What method 8 would cost
 * is a second code path where a corrupt archive is possible: a wrong CRC or a
 * wrong compressed size in a header produces a file that opens in one tool and
 * fails in another, which is the worst kind of bug to have in the artefact an
 * accountant reaches for when the link does not work. Stored entries have
 * `compressedSize === uncompressedSize` and nothing to get wrong but the CRC.
 *
 * ## What this deliberately does not implement
 *
 * **ZIP64.** The format's 32-bit fields cap an archive at 4 GiB and 65 535
 * entries, and both are checked below rather than overflowed: an archive that
 * silently wrapped a size field would extract as garbage. A9's export is capped
 * far under both (500 documents), so the guards are assertions about a bound
 * already enforced elsewhere, not a limitation anyone will meet.
 *
 * **Unicode filenames.** Entry names are ASCII by construction — a capability
 * code plus an extension — so the general-purpose bit 11 (UTF-8) is not set and
 * no name needs encoding. `assertZipEntryName` enforces that rather than
 * assuming it, because a filename is the one field in this file that comes from
 * data rather than from us.
 */

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  /** The path inside the archive. ASCII, forward slashes, no leading slash and no `..`. */
  readonly name: string;
  readonly bytes: Buffer;
}

/** 4 GiB − 1: what a 32-bit size field can hold. Beyond it the format needs ZIP64. */
const MAX_ZIP32_BYTES = 0xffff_ffff;
/** What a 16-bit entry count can hold. */
const MAX_ZIP32_ENTRIES = 0xffff;

const LOCAL_FILE_HEADER_SIGNATURE = 0x0403_4b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x0201_4b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x0605_4b50;

/** Method 0 — stored. See the header. */
const METHOD_STORED = 0;
/** 2.0. The minimum every implementation understands, and all a stored entry needs. */
const VERSION_NEEDED = 20;

/**
 * A **fixed** DOS timestamp: 1980-01-01 00:00:00, the epoch of the format
 * itself.
 *
 * ⚠ Deliberate, and worth understanding before "fixing" it to the real time.
 * DOS timestamps carry no timezone, so a real clock here would write a local
 * time with no way to say which one — and it would make the same export
 * byte-different on every run. A reproducible archive is what lets anyone
 * diff two exports and see only what actually changed. The real dates that
 * matter are the document dates, and they are in the manifest, in ISO form,
 * where they mean something.
 */
const DOS_DATE = 0x0021; // 1980-01-01
const DOS_TIME = 0x0000; // 00:00:00

/**
 * Entries in, one archive out.
 *
 * Order is preserved, and the manifest should be first: some tools show the
 * first entry when a user double-clicks, and the index is the thing to read
 * first anyway (SoT §24.3.2 — the manifest is the differentiator, not the
 * fallback).
 */
export function buildZipArchive(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > MAX_ZIP32_ENTRIES) {
    throw new ZipError(`a ZIP without ZIP64 holds at most ${MAX_ZIP32_ENTRIES} entries, got ${entries.length}`);
  }

  const seen = new Set<string>();
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = assertZipEntryName(entry.name);
    if (seen.has(name)) {
      // Two entries with one name is a valid archive and an ambiguous one:
      // extractors disagree about which wins, so one of the two documents
      // silently disappears. Refused rather than resolved.
      throw new ZipError(`duplicate entry name "${name}" — an archive with two of these loses one silently`);
    }
    seen.add(name);

    if (entry.bytes.length > MAX_ZIP32_BYTES) {
      throw new ZipError(`entry "${name}" is larger than a ZIP without ZIP64 can describe`);
    }

    const nameBytes = Buffer.from(name, 'ascii');
    const crc = crc32(entry.bytes);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(0, 6); // general purpose flags: none. No data descriptor, no UTF-8 bit.
    header.writeUInt16LE(METHOD_STORED, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(entry.bytes.length, 18); // compressed size
    header.writeUInt32LE(entry.bytes.length, 22); // uncompressed size
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28); // extra field length

    local.push(header, nameBytes, entry.bytes);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
    // "Version made by": 20, with the upper byte 0 = MS-DOS/FAT. Not 3 (Unix),
    // because that byte tells an extractor the external attributes carry POSIX
    // permissions, and we write none.
    directory.writeUInt16LE(VERSION_NEEDED, 4);
    directory.writeUInt16LE(VERSION_NEEDED, 6);
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(METHOD_STORED, 10);
    directory.writeUInt16LE(DOS_TIME, 12);
    directory.writeUInt16LE(DOS_DATE, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(entry.bytes.length, 20);
    directory.writeUInt32LE(entry.bytes.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt16LE(0, 30); // extra field length
    directory.writeUInt16LE(0, 32); // comment length
    directory.writeUInt16LE(0, 34); // disk number start
    directory.writeUInt16LE(0, 36); // internal attributes
    directory.writeUInt32LE(0, 38); // external attributes
    directory.writeUInt32LE(offset, 42); // where this entry's local header starts

    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + entry.bytes.length;

    if (offset > MAX_ZIP32_BYTES) {
      throw new ZipError('archive exceeds 4 GiB — a ZIP without ZIP64 cannot describe its own offsets');
    }
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // archive comment length

  return Buffer.concat([...local, centralBytes, end]);
}

/**
 * The one field in this file that comes from data rather than from us.
 *
 * A ZIP entry name is a path, and a path an extractor writes to disk is a
 * classic archive-traversal ("zip slip") sink: `../../etc/cron.d/x` extracts
 * outside the destination in any tool that does not defend itself, and an
 * absolute path or a drive letter does the same on Windows. We control these
 * names — they are `documents/<CODE>.<ext>` — so this is defence in depth
 * rather than a live hole, and it is exactly the kind of check that should not
 * depend on a caller three layers away staying the way it is.
 */
export function assertZipEntryName(name: string): string {
  if (name.length === 0 || name.length > 200) {
    throw new ZipError(`entry name must be 1..200 characters, got ${name.length}`);
  }
  // Printable ASCII only, and no backslash: a backslash is a separator on
  // Windows, so `a\..\..\b` is a traversal that the forward-slash check misses.
  if (!/^[\x20-\x7e]+$/.test(name) || name.includes('\\')) {
    throw new ZipError(`entry name "${name}" must be printable ASCII with no backslash`);
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new ZipError(`entry name "${name}" must be relative`);
  }
  if (name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ZipError(`entry name "${name}" must not contain an empty, "." or ".." path segment`);
  }
  return name;
}

/**
 * CRC-32 (IEEE 802.3), the checksum ZIP requires on every entry.
 *
 * Hand-rolled for the same reason as the rest of the file. `node:zlib` gained a
 * `crc32` export in Node 22.2, which would do — but the table below is eight
 * lines, has no version floor, and is the standard bit-reversed polynomial
 * every reference implementation uses. `>>> 0` after every step keeps the
 * intermediate value an unsigned 32-bit integer: JavaScript's bitwise operators
 * produce SIGNED 32-bit results, and a negative CRC written through
 * `writeUInt32LE` throws — or worse, would not.
 */
const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      // 0xEDB88320 is the bit-reversed IEEE 802.3 polynomial — the form used
      // when the register shifts right, which is what ZIP's CRC does.
      value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

export function crc32(bytes: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
