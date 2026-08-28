import { inflateRawSync } from 'node:zlib';

/**
 * CSV and XLSX bytes → a grid of strings. Nothing above this file knows which
 * of the two it was handed.
 *
 * ## Why this is hand-rolled rather than a dependency
 *
 * Adding a package is on the root `CLAUDE.md`'s stop-and-ask list, and no
 * spreadsheet library exists anywhere in this repo today. What a bank statement
 * needs is a small, well-understood subset — one sheet, no formulas, no styles,
 * no formatting — and `apps/web/src/lib/spreadsheet.ts` already proves that
 * subset is worth owning: it reads XLSX in the BROWSER off `DecompressionStream`.
 * This is the same grammar against `node:zlib`, which is in the standard
 * library, so the server gains no dependency to audit, pin or update.
 *
 * ## The scope, stated so nobody expects more
 *
 * XLSX is a zip of XML. We read exactly two members — the first worksheet and
 * the shared-string table — and ignore everything else in the archive. A
 * multi-sheet workbook is read as its FIRST sheet, which is what a bank exports.
 * Styles are not read, which is why a date arrives here as an Excel serial
 * number and is disambiguated one layer up rather than here.
 */

/** A parsed grid. Ragged by nature — a bank's trailer row is often shorter. */
export type Grid = string[][];

export type SheetFormat = 'csv' | 'xlsx';

export type ReadFailure =
  /** Not a zip at all — usually a PDF or an image renamed to .xlsx. */
  | { reason: 'notAZipFile' }
  /** A zip, but without the members a worksheet must have. */
  | { reason: 'notAWorkbook' }
  /** Structurally readable and completely empty. */
  | { reason: 'noRows' };

export type ReadResult = { ok: true; grid: Grid } | { ok: false; failure: ReadFailure };

/**
 * Which reader to use, decided by extension.
 *
 * Deliberately NOT by sniffing the bytes: a bank that exports `.csv` with a
 * UTF-8 BOM and a bank that exports `.xlsx` are both unambiguous by name, and a
 * sniffer that guesses wrong turns a readable statement into a parse error the
 * accountant cannot act on. An unknown extension returns null so the caller can
 * say which formats it accepts rather than failing obscurely.
 */
export function formatFor(fileName: string): SheetFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  return null;
}

export function readSheet(bytes: Buffer, format: SheetFormat): ReadResult {
  const grid = format === 'csv' ? readCsv(bytes) : readXlsx(bytes);
  if (!Array.isArray(grid)) return { ok: false, failure: grid };
  if (grid.length === 0) return { ok: false, failure: { reason: 'noRows' } };
  return { ok: true, grid };
}

/* ── CSV ──────────────────────────────────────────────────────────────────── */

/**
 * RFC 4180 with the concessions real banks require: a UTF-8 BOM, CRLF or LF,
 * quoted fields containing the delimiter or a newline, and `""` as an escaped
 * quote.
 *
 * The delimiter is DETECTED rather than assumed. A UK bank exporting from a
 * European locale emits semicolons, and reading that with a comma yields one
 * enormous column that looks like a statement with no amounts — a failure that
 * reads as a bad file rather than a wrong guess.
 */
function readCsv(bytes: Buffer): Grid {
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  const delimiter = detectDelimiter(text);
  const rows: Grid = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        // A doubled quote is a literal quote; a single one ends the field.
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  // The last line usually has no trailing newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // ⚠ Blank lines are KEPT, deliberately.
  //
  // Every finding this pipeline produces names a source line so an accountant
  // can find it in their own file. Banks put blank rows in their preamble, so
  // dropping them here shifts every line number after the gap and points the
  // person at the wrong row — which is worse than no line number at all.
  // Blank rows are skipped where rows are INTERPRETED, not where they are read.
  return rows;
}

/** Whichever of `,` `;` `\t` appears most on the first non-empty line. */
function detectDelimiter(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const counts = [',', ';', '\t'].map((d) => [d, line.split(d).length - 1] as const);
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] === 0 ? ',' : best[0];
}

/* ── XLSX ─────────────────────────────────────────────────────────────────── */

const SHEET_MEMBER = /^xl\/worksheets\/sheet1\.xml$/;
const STRINGS_MEMBER = /^xl\/sharedStrings\.xml$/;

/**
 * Walks the zip's central directory rather than scanning for local headers.
 *
 * The central directory is the authoritative index — a local header may carry a
 * zero compressed size with the real value in a trailing data descriptor, which
 * is exactly what streamed writers emit, and a scanner that trusts local
 * headers reads such an archive as empty.
 */
function readXlsx(bytes: Buffer): Grid | ReadFailure {
  const members = unzip(bytes, [SHEET_MEMBER, STRINGS_MEMBER]);
  if (members === null) return { reason: 'notAZipFile' };

  const sheet = [...members.entries()].find(([name]) => SHEET_MEMBER.test(name))?.[1];
  if (sheet === undefined) return { reason: 'notAWorkbook' };

  const strings = [...members.entries()].find(([name]) => STRINGS_MEMBER.test(name))?.[1];
  return sheetToGrid(sheet, strings === undefined ? [] : sharedStrings(strings));
}

function unzip(buffer: Buffer, want: RegExp[]): Map<string, Buffer> | null {
  // End-of-central-directory: scan back from the tail for its signature. The
  // comment field is at most 64 KB, so the record is within the last ~64 KB.
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();

  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (!want.some((re) => re.test(name))) continue;

    // The local header's own name/extra lengths decide where the data starts —
    // they are NOT required to match the central directory's.
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(start, start + compressedSize);
    try {
      out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    } catch {
      // A member we cannot inflate is a member we do not have. Reported as a
      // missing workbook rather than crashing the ingest job.
      return null;
    }
  }
  return out;
}

/** `<si>` entries, flattened — a run-split string is many `<t>` under one `<si>`. */
function sharedStrings(xml: Buffer): string[] {
  const text = xml.toString('utf8');
  return [...text.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, body]) =>
    [...(body ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => decodeXml(t ?? '')).join(''),
  );
}

/**
 * `<row>`/`<c>` into a grid, honouring the cell REFERENCE rather than counting.
 *
 * An empty cell is simply absent from the XML, so a row of `A,B,D` counted
 * positionally shifts D into C's column — every amount one column left of where
 * it belongs, which reads as a plausible statement and is wrong. The reference
 * (`C7`) is the only thing that says where a value actually sits.
 */
function sheetToGrid(xml: Buffer, strings: string[]): Grid {
  const text = xml.toString('utf8');
  const grid: Grid = [];

  for (const [, rowBody] of text.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const match of (rowBody ?? '').matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = match[1] ?? '';
      const body = match[2] ?? '';
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const index = ref === undefined ? cells.length : columnIndex(ref);
      const isShared = /t="s"/.test(attrs);
      const isInline = /t="inlineStr"/.test(attrs);
      const raw = isInline
        ? [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => decodeXml(t ?? '')).join('')
        : decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      const value = isShared ? (strings[Number.parseInt(raw, 10)] ?? '') : raw;
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }
    grid.push(cells);
  }
  // Kept for the same reason as CSV: line numbers must match the file.
  return grid;
}

/** `A` → 0, `Z` → 25, `AA` → 26. */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
    // Ampersand LAST, or `&amp;lt;` decodes twice into `<`.
    .replace(/&amp;/g, '&');
}
