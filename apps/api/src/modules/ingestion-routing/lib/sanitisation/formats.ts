/**
 * Magic-byte type sniffing and the extension allowlist (Governance §11.4,
 * steps 1–2). Extensions are a hint only — the bytes decide the real type
 * (root CLAUDE.md: "extensions are never trusted").
 *
 * Accepted formats (senior brief / SoT §4 Stage 1):
 *   JPG, PNG, GIF, BMP, TIFF, HEIC, PDF, DOC/DOCX, ODT, RTF, ZIP.
 * (CSV/XLSX are structured imports handled elsewhere, not by this pipeline.)
 */

export type AcceptedFormat =
  | 'jpeg'
  | 'png'
  | 'gif'
  | 'bmp'
  | 'tiff'
  | 'heic'
  | 'pdf'
  | 'doc'
  | 'docx'
  | 'odt'
  | 'rtf'
  | 'zip';

export const ACCEPTED_FORMATS: ReadonlySet<AcceptedFormat> = new Set<AcceptedFormat>([
  'jpeg', 'png', 'gif', 'bmp', 'tiff', 'heic', 'pdf', 'doc', 'docx', 'odt', 'rtf', 'zip',
]);

/** Result of sniffing: a concrete accepted format, or `unknown` (matched nothing). */
export type SniffResult = AcceptedFormat | 'unknown';

/** Extensions that legitimately map to a detected format, for spoof detection. */
const EXTENSIONS: Readonly<Record<AcceptedFormat, readonly string[]>> = {
  jpeg: ['jpg', 'jpeg'],
  png: ['png'],
  gif: ['gif'],
  bmp: ['bmp'],
  tiff: ['tif', 'tiff'],
  heic: ['heic', 'heif'],
  pdf: ['pdf'],
  doc: ['doc'],
  docx: ['docx'],
  odt: ['odt'],
  rtf: ['rtf'],
  zip: ['zip'],
};

function startsWith(bytes: Buffer, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'heif', 'hevc', 'hevx', 'mif1', 'msf1']);

/** ASCII helper: read `len` bytes at `offset` as a latin1 string. */
function ascii(bytes: Buffer, offset: number, len: number): string {
  if (bytes.length < offset + len) return '';
  return bytes.toString('latin1', offset, offset + len);
}

/**
 * Sniff the true type from the leading bytes. Pure and allocation-light — it
 * never decodes the file, only inspects signatures.
 */
export function sniff(bytes: Buffer): SniffResult {
  // Ordered most-specific first.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif'; // "GIF8"
  if (startsWith(bytes, [0x42, 0x4d])) return 'bmp'; // "BM"
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // "%PDF-"
  if (startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return 'rtf'; // "{\rtf"
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'doc'; // OLE compound (legacy .doc)

  // ISO-BMFF (HEIC/HEIF): "ftyp" box at offset 4, brand at offset 8.
  if (ascii(bytes, 4, 4) === 'ftyp' && HEIC_BRANDS.has(ascii(bytes, 8, 4))) return 'heic';

  // ZIP container (PK\x03\x04 local header, or empty/spanned variants).
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return refineZipContainer(bytes);
  }

  return 'unknown';
}

/**
 * DOCX and ODT are ZIP containers, so PK bytes alone cannot tell them apart
 * from a plain ZIP. Cheap, dep-free heuristics on the leading bytes:
 *  - ODT stores an uncompressed `mimetype` entry first, so its media type
 *    string sits near the top of the file.
 *  - DOCX always contains `[Content_Types].xml`, whose name appears in the
 *    first local file header.
 * A full central-directory parse happens in the ZIP-safety step; this is only
 * enough to route the type. Anything else PK-shaped is treated as `zip`.
 */
function refineZipContainer(bytes: Buffer): AcceptedFormat {
  const head = bytes.toString('latin1', 0, Math.min(bytes.length, 2048));
  if (head.includes('application/vnd.oasis.opendocument.text')) return 'odt';
  if (head.includes('[Content_Types].xml')) return 'docx';
  return 'zip';
}

/** Lowercase file extension without the dot, or '' when absent. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Does the declared filename extension agree with the sniffed type? Used to
 * catch spoofing (an `.pdf` that is really an executable). An absent or
 * unknown extension is not treated as a spoof — only a positive contradiction
 * is, because a mismatch is the strong signal (NT-ING-004).
 */
export function extensionContradicts(filename: string, detected: AcceptedFormat): boolean {
  const ext = extensionOf(filename);
  if (ext === '') return false;
  const known = new Set<string>(Object.values(EXTENSIONS).flat());
  if (!known.has(ext)) return false; // unknown extension: not a positive contradiction
  return !EXTENSIONS[detected].includes(ext);
}

const MIME_BY_FORMAT: Readonly<Record<AcceptedFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  heic: 'image/heic',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  zip: 'application/zip',
};

/**
 * The MIME type for a sniffed format — the authoritative content-type, derived
 * from the magic bytes, not the sender's declared header. Used when storing so a
 * mislabelled part is stored (and later served) as what it actually is.
 */
export function mimeForFormat(format: AcceptedFormat): string {
  return MIME_BY_FORMAT[format];
}
