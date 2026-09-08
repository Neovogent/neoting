/**
 * The MIME type to DECLARE for a file the user picked — the one mirror of the
 * server's allowlist, shared by every surface that sends bytes.
 *
 * ## ⚠ THIS LIST IS THE SERVER'S, NOT A GUESS
 *
 * Every upload endpoint checks the declared MIME against the sanitiser's
 * `ACCEPTED_FORMATS` (`apps/api/src/modules/ingestion-routing/lib/sanitisation/
 * formats.ts`) and refuses anything else with `415 NT-ING-002`. When the two
 * drift, the SERVER file is the truth; fix this one.
 *
 * ## Why the browser's own `type` is not trusted on its own
 *
 * `File.type` comes from the OS, and for HEIC the OS frequently has no answer:
 *
 * | Platform | `.HEIC` arrives as |
 * |---|---|
 * | iOS Safari | `''` — empty, routinely |
 * | Chrome on Windows | `application/octet-stream` — Windows has no registry MIME for HEIF |
 *
 * The empty case was handled from the start. The `application/octet-stream`
 * case was not, and because that value is *truthy* it sailed past an
 * `if (type !== '')` guard and was declared verbatim — so every iPhone
 * photograph uploaded from a desktop browser was refused by the allowlist, on
 * the accountant's upload page and through the client's chase link alike
 * (pipeline test, 8 Sep 2026).
 *
 * So the rule is not "is the type present" but **"is the type one we actually
 * accept"** — and when it is not, the filename extension answers. That covers
 * both platforms and any future OS that invents a third wrong answer.
 */

/** Extension → the MIME the server's allowlist admits. Lowercase, no dot. */
export const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  zip: 'application/zip',
  // Spreadsheets (5 Sep 2026): the server has accepted both since D40 made
  // manual statement upload the only bank input — some clients' banks export
  // nothing else. `.xls` declares the legacy alias the server's DECLARED_ALIASES
  // admits at the door; the byte sniff decides what it really is.
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
};

/**
 * Every MIME the door admits, for deciding whether the browser's own answer is
 * usable. Derived from the table above so the two can never disagree.
 */
const ACCEPTED_MIMES: ReadonlySet<string> = new Set(Object.values(MIME_BY_EXTENSION));

/**
 * The `accept` attribute. Deliberately the extensions and not the MIME types:
 * a phone that hands over a `.heic` with an empty `type` still matches on the
 * extension, and an `accept` of MIME types alone hides those files from the
 * picker entirely.
 */
export const UPLOAD_ACCEPT = Object.keys(MIME_BY_EXTENSION)
  .map((extension) => `.${extension}`)
  .join(',');

/** `receipt.HEIC` → `heic`. Empty when the name carries no extension. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 1 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * The MIME to declare for a picked file.
 *
 * The browser's own `type` wins only when it is a type the door accepts; every
 * other answer — empty, `application/octet-stream`, or anything else the OS
 * invents — falls through to the extension. `''` when neither can name it,
 * which is what makes an unknown file refusable by the screen above.
 */
export function mimeTypeFor(file: { name: string; type: string }): string {
  if (ACCEPTED_MIMES.has(file.type)) return file.type;
  return MIME_BY_EXTENSION[extensionOf(file.name)] ?? '';
}
