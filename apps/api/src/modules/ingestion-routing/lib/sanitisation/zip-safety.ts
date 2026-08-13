/**
 * ZIP explode with depth / size / file-count caps (Governance §11.4, step 7)
 * — the zip-bomb defence.
 *
 * The safe way to catch a bomb is to read the archive's own bookkeeping (the
 * central directory) WITHOUT decompressing anything: the declared uncompressed
 * sizes, the entry count, and the per-entry compression ratio expose a
 * single-layer explosion before a byte is inflated. Nested archives (whose
 * explosion only appears on recursive inflation) are refused past the depth
 * cap rather than expanded. This is fully dependency-free.
 *
 * Recursive inflation of legitimately-nested archives is a later, dep-gated
 * capability; the conservative default (`maxDepth: 1`) accepts no nested
 * archive, which is safe.
 */

import { reject, type Rejection } from './reasons.js';

export interface ZipCaps {
  readonly maxFileCount: number;
  readonly maxTotalUncompressedBytes: number;
  /** Per-entry uncompressed:compressed ratio beyond which an entry is a bomb. */
  readonly maxCompressionRatio: number;
  /** Layers of archive nesting permitted. 1 = the submitted zip only. */
  readonly maxDepth: number;
}

const MB = 1024 * 1024;

export const DEFAULT_ZIP_CAPS: ZipCaps = {
  maxFileCount: 512,
  maxTotalUncompressedBytes: 500 * MB,
  maxCompressionRatio: 1000,
  maxDepth: 1,
};

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const ZIP64_SENTINEL = 0xffffffff;

/** Extensions that are themselves ZIP-based archives (nested-archive check). */
const NESTED_ARCHIVE_EXT = new Set(['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'jar']);

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Locate the End Of Central Directory record; -1 if absent. */
function findEocd(bytes: Buffer): number {
  const minSize = 22;
  if (bytes.length < minSize) return -1;
  const maxComment = 0xffff;
  const from = Math.max(0, bytes.length - (minSize + maxComment));
  for (let i = bytes.length - minSize; i >= from; i -= 1) {
    if (bytes.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Inspect a ZIP archive against the caps. Returns a `Rejection` on the first
 * cap breach or a parse failure, or `null` when the archive is within limits.
 */
export function inspectZip(bytes: Buffer, caps: ZipCaps = DEFAULT_ZIP_CAPS): Rejection | null {
  const eocd = findEocd(bytes);
  if (eocd < 0) return reject('malformed_archive', 'The ZIP archive is corrupt or incomplete and cannot be opened.');

  const entryCount = bytes.readUInt16LE(eocd + 10);
  let cursor = bytes.readUInt32LE(eocd + 16); // central directory offset

  if (entryCount > caps.maxFileCount) {
    return reject('zip_file_count_exceeded', `The ZIP contains more than the ${caps.maxFileCount} files we accept in one archive.`, {
      entryCount,
      cap: caps.maxFileCount,
    });
  }

  let totalUncompressed = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CDH_SIG) {
      return reject('malformed_archive', 'The ZIP central directory is malformed and cannot be trusted.');
    }
    const compressed = bytes.readUInt32LE(cursor + 20);
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLen = bytes.readUInt16LE(cursor + 28);
    const extraLen = bytes.readUInt16LE(cursor + 30);
    const commentLen = bytes.readUInt16LE(cursor + 32);
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLen);

    // ZIP64 defers the real size to an extra field we do not parse — refuse
    // rather than under-count an explosion.
    if (uncompressed === ZIP64_SENTINEL || compressed === ZIP64_SENTINEL) {
      return reject('zip_total_size_exceeded', 'The ZIP declares ZIP64-scale contents that exceed the size we can safely expand.', {
        entry: name,
      });
    }

    totalUncompressed += uncompressed;
    if (totalUncompressed > caps.maxTotalUncompressedBytes) {
      return reject('zip_total_size_exceeded', 'The ZIP would expand to more than the size we accept — it looks like a zip bomb.', {
        totalUncompressed,
        cap: caps.maxTotalUncompressedBytes,
      });
    }

    if (compressed > 0 && uncompressed / compressed > caps.maxCompressionRatio) {
      return reject('zip_total_size_exceeded', 'An entry in the ZIP has an implausible compression ratio — it looks like a zip bomb.', {
        entry: name,
        ratio: Math.round(uncompressed / compressed),
        cap: caps.maxCompressionRatio,
      });
    }

    if (caps.maxDepth <= 1 && NESTED_ARCHIVE_EXT.has(extOf(name))) {
      return reject('zip_depth_exceeded', 'The ZIP contains another archive nested inside it, which we do not expand.', {
        entry: name,
        maxDepth: caps.maxDepth,
      });
    }

    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return null;
}
