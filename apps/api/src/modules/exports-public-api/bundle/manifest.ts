import { formatPenceDecimal } from '../canonical/money.js';
import { serialiseCsv } from '../emitters/csv/csv.js';
import { encodeCsv } from '../emitters/csv/encoding.js';

/**
 * The manifest — **D43 rung 4, and the one rung that is a differentiator rather
 * than a fallback** (SoT §24.3.2).
 *
 * The SoT is unusually direct about this: *"None of the three established
 * products solves matching an exported document bundle back to its exported
 * rows — one leaves the filename convention undocumented, one requires a
 * support ticket to get the documents at all, and one ships a folder tree with
 * no index. ID's manifest file is therefore not a fallback rung; it is a
 * differentiator, and it costs almost nothing."*
 *
 * It also mirrors what VT's own help tells accountants to do — *"write this
 * number on any supporting paperwork… and file the paperwork in reference
 * number order"* — which is why the code, not our document id, is the key
 * column: every VT accountant already understands filing by a reference.
 *
 * **This rung works when nothing else does.** If VT renders the URL as inert
 * text (the working assumption until A10 measures it), the accountant reads the
 * code out of `Entry details`, finds the row in this CSV, and opens the file of
 * that name in the bundle. No clicking, no network, no session — which is why
 * it is worth shipping alongside the rungs that need all three.
 */

/** The name the manifest carries inside the bundle. First entry, so it is what a double-click shows. */
export const MANIFEST_FILENAME = 'manifest.csv';

/** The folder documents sit in, so the archive does not spray files into whatever directory it opens in. */
export const BUNDLE_DOCUMENTS_PREFIX = 'documents/';

/**
 * The column order, and it is the SoT's own list: *"document code, filename,
 * checksum, document number, date, supplier, amount"*, plus the URL because
 * rung 4 should also carry rung 2 — a manifest that made someone retype a host
 * would have solved the wrong half.
 *
 * `Code` is first because it is the key. The accountant arrives here holding a
 * code they read out of a spreadsheet cell, and the first column is where a
 * human's eye goes.
 */
export const MANIFEST_COLUMNS = [
  'Code',
  'File',
  'Checksum (SHA-256)',
  'Reference',
  'Date',
  'Supplier',
  'Total',
  'Link',
] as const;

export interface ManifestEntry {
  /** The capability code. Also the stem of the file's name in the bundle. */
  readonly code: string;
  /** The name this document has inside the archive, `documents/<CODE>.<ext>`. */
  readonly fileName: string;
  /** The stored `documents.byte_hash`, so a recipient can prove the file is the one exported. */
  readonly byteHashSha256: string;
  /** The supplier's own document reference. Empty when the extraction found none. */
  readonly reference: string;
  /** `YYYY-MM-DD`. ISO, not UK d/m/y — this column is read by people AND by spreadsheets, and it sorts. */
  readonly documentDate: string;
  readonly supplierName: string;
  /** Gross, **signed integer pence**. Formatted to 2dp here and only here. */
  readonly totalPence: number;
  /** The full `https://…/d/{code}` capability URL. */
  readonly url: string;
}

/**
 * Manifest entries → the bytes that go into the archive.
 *
 * Serialised and encoded through the module's own CSV path, so the manifest and
 * the VT import file agree byte-for-byte about quoting, line endings and
 * encoding. That matters more than it sounds: `Épicerie Dubois, S.à r.l.` is
 * the case that breaks hand-rolled serialisers and legacy code pages at once,
 * and it must not break in one of the two files an accountant opens.
 *
 * ⚠ The header row is unconditional here, unlike the VT file's — nothing
 * column-maps a manifest, a human reads it, and an unlabelled index is a worse
 * index than none.
 */
export function buildManifestCsv(entries: readonly ManifestEntry[]): Buffer {
  const rows: string[][] = [[...MANIFEST_COLUMNS]];
  for (const entry of entries) {
    rows.push([
      entry.code,
      entry.fileName,
      entry.byteHashSha256,
      entry.reference,
      entry.documentDate,
      entry.supplierName,
      formatPenceDecimal(entry.totalPence),
      entry.url,
    ]);
  }
  return encodeCsv(serialiseCsv(rows));
}

/**
 * `documents/A7K2M9PQ.pdf` — the code IS the filename, which is the whole point
 * of rung 4.
 *
 * The extension comes from the **stored** MIME type, which is magic-byte
 * authoritative after sanitisation, never the name the uploader chose. Two
 * reasons, and the second is the one that matters: an uploader-chosen extension
 * on a file we write into an archive is an attacker choosing what a
 * double-click on an accountant's Windows machine executes, and the original
 * name may collide, may contain a path separator, or may be a different
 * document with the same name from a different supplier. The code cannot
 * collide — it is unique by construction — so the archive is unambiguous.
 */
export function bundleFileName(code: string, storedMimeType: string): string {
  return `${BUNDLE_DOCUMENTS_PREFIX}${code}${extensionFor(storedMimeType)}`;
}

/**
 * The extensions ingestion actually accepts, and nothing else.
 *
 * An unknown type gets `.bin` rather than a guess: a wrong extension is a file
 * that will not open, and a *guessed* one is a file that opens in the wrong
 * application. The list mirrors the sanitisation allowlist; a type outside it
 * cannot have reached a Published document.
 */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = Object.freeze({
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
});

function extensionFor(storedMimeType: string): string {
  return EXTENSION_BY_MIME[storedMimeType.toLowerCase()] ?? '.bin';
}
