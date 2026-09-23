import { crc32 } from 'node:zlib';

/**
 * A streaming, STORE-ONLY ZIP writer (D51, the Document Vault's "download
 * everything").
 *
 * ## Why this is not a dependency
 *
 * The obvious move is `archiver` or `yazl`. It was not taken, for one measured
 * reason and one structural one:
 *
 * - **Compression buys nothing here.** Every byte this archives is a receipt:
 *   a PDF or a JPEG, both already compressed. DEFLATE over them spends CPU per
 *   client to produce a file within a fraction of a percent of the same size,
 *   and a client pressing "download everything" is waiting on it.
 * - **Store-only ZIP is small enough to own.** With `method: 0` there is no
 *   compressor, and `node:zlib` has carried `crc32` since Node 20.12 — which is
 *   the only part anyone gets wrong by hand. What is left is three record
 *   layouts, written out below, and the repo's own rule about not adding a
 *   dependency for what a few lines can do.
 *
 * ## The shape, and why there are no data descriptors
 *
 * Each entry is buffered whole before it is written, so its CRC and its length
 * are both known BEFORE its local header goes out. That removes the streaming
 * ZIP's usual complication (bit 3 + trailing data descriptors), which is the
 * other half of what makes hand-writing this reasonable. The cost is one
 * document in memory at a time — never the whole archive, which is the number
 * that actually matters when a client has four hundred receipts.
 *
 * ## ⚠ The ceiling, stated rather than discovered
 *
 * This writes ZIP32. Offsets and sizes are 32-bit, so an archive may not exceed
 * 4 GiB and may not hold more than 65,535 entries. Both are checked and both
 * THROW rather than silently emitting a corrupt archive that opens, looks fine,
 * and is missing files — which is what a wrapped counter produces.
 *
 * ponytail: ZIP32 only. If a real client ever trips the 4 GiB or 65,535-entry
 * ceiling, the upgrade is zip64 (a 20-byte extra field per entry plus the
 * zip64 EOCD records), not a dependency swap.
 */

/** One file going into the archive. `bytes` is the whole file. */
export interface ZipEntry {
  /** The path inside the archive. Forward slashes, no leading slash. */
  readonly name: string;
  readonly bytes: Buffer;
  /** Written into the entry's DOS timestamp. Defaults to now. */
  readonly modifiedAt?: Date;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** Version 2.0 — the floor for a store-only entry every reader understands. */
const VERSION = 20;

/**
 * Bit 11, the UTF-8 filename flag.
 *
 * ⚠ Not decoration. Without it a reader is entitled to decode the name as
 * IBM-437, and a supplier name with an accent or a pound sign in it — which is
 * most of a UK receipt set — comes out mangled in Windows Explorer.
 */
const FLAG_UTF8 = 0x0800;

/** Store, not deflate. See the header. */
const METHOD_STORE = 0;

const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

/**
 * Yield the bytes of a ZIP archive over `entries`, in order.
 *
 * An async iterable so the caller can pipe it straight to an HTTP response and
 * hold one document in memory rather than the archive. The source is also async
 * so entries can be fetched from object storage lazily — the whole point of
 * streaming here is that nothing assembles the full list of buffers first.
 */
export async function* zipStream(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;

  for await (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const size = entry.bytes.byteLength;
    // `crc32` returns an unsigned 32-bit number; `>>> 0` keeps it that way
    // after any arithmetic, because writeUInt32LE throws on a negative.
    const sum = crc32(entry.bytes) >>> 0;
    const { time, date } = dosTimestamp(entry.modifiedAt ?? new Date());

    if (count >= MAX_ENTRIES) {
      throw new Error(`a ZIP32 archive holds at most ${MAX_ENTRIES} files, and this one reached that`);
    }
    if (offset + size > MAX_SIZE) {
      throw new Error('a ZIP32 archive may not exceed 4 GiB, and this one would');
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_STORE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    // Stored, so the compressed and uncompressed sizes are the same number.
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);

    yield local;
    yield name;
    yield entry.bytes;

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(CENTRAL_SIG, 0);
    dir.writeUInt16LE(VERSION, 4);
    dir.writeUInt16LE(VERSION, 6);
    dir.writeUInt16LE(FLAG_UTF8, 8);
    dir.writeUInt16LE(METHOD_STORE, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(size, 20);
    dir.writeUInt32LE(size, 24);
    dir.writeUInt16LE(name.byteLength, 28);
    // extra, comment, disk number, internal attrs, external attrs — all zero.
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.byteLength + name.byteLength + size;
    count += 1;
  }

  const directory = Buffer.concat(central);
  if (offset + directory.byteLength > MAX_SIZE) {
    throw new Error('a ZIP32 archive may not exceed 4 GiB, and this one would');
  }

  // ⚠ These offsets are 12 and 16, and they were 14 and 18 in the first draft.
  // A two-byte slip here produces an archive that every field-by-field unit
  // test still passes and that no real extractor will open — Python's
  // `zipfile` answered "Bad offset for central directory", which is the whole
  // reason `store-zip.test.ts` round-trips through an independent reader
  // instead of asserting the bytes this file just wrote.
  //
  // End of central directory: sig(4) disk(2) cdDisk(2) hereCount(2)
  // totalCount(2) cdSize(4) cdOffset(4) commentLen(2) = 22.
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  yield directory;
  yield end;
}

/**
 * A ZIP entry name that cannot escape the archive.
 *
 * ⚠ **The names here come off scanned documents** — a supplier name a model
 * read off a receipt reaches this function. So it is a sanitiser, not a
 * formatter: `..` segments, absolute paths, backslashes, control characters and
 * the Windows-reserved punctuation are all removed, because an archive entry
 * called `../../etc/passwd` is the classic zip-slip and some extractors still
 * honour it.
 *
 * Length is capped at 120 bytes of the stem so the whole path stays comfortably
 * inside the 255-byte limit most filesystems impose.
 */
export function safeEntryName(value: string, fallback: string): string {
  const printable = Array.from(value)
    // Control characters by CODE POINT rather than by regex escape. A
    // character class spelling them out has to survive every layer between a
    // keyboard and this file, and it did not: the first draft of this line
    // shipped two raw control BYTES into the source, which is the bug it
    // exists to prevent, sitting inside its own fix.
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
  const cleaned = printable
    .replace(/[\\/]/g, '-')
    .replace(/[<>:"|?*]/g, '')
    .replace(/^[.]+/, '')
    .trim();
  const stem = cleaned.slice(0, 120).trim();
  // ⚠ Emptiness is not enough. `///` sanitises to `---`, which is a perfectly
  // valid filename and a useless one — the client opens their archive and finds
  // `---.pdf`. A stem carrying no letter or digit has no information in it, so
  // it gets the fallback for the same reason an empty one does.
  return /\p{L}|\p{N}/u.test(stem) ? stem : fallback;
}

/**
 * MS-DOS time and date, which is what a ZIP entry carries.
 *
 * Two-second resolution and a 1980 epoch, both from the format rather than from
 * choice. A date before 1980 cannot be represented, so it clamps rather than
 * writing a negative year that renders as garbage.
 */
function dosTimestamp(when: Date): { time: number; date: number } {
  const year = Math.max(when.getFullYear(), 1980);
  const date = ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  return { time, date };
}
