/**
 * Reading a spreadsheet, rather than photographing one.
 *
 * A CSV or an XLSX has no page to read. Sending it down the OCR path treats a
 * thousand rows as one picture of a document, which is both wrong and slower
 * than the thing it is imitating: the data is already structured, already
 * typed, already separated into fields. So these files take a different route
 * — the columns are matched to what we need, each row becomes its own record,
 * and the sheet as a whole is sniffed to work out what it even is.
 *
 * Both formats are parsed here rather than pulled in from a library. CSV is a
 * small grammar and worth owning. XLSX is a zip of XML, and the platform can
 * already inflate a zip — `DecompressionStream('deflate-raw')` is in every
 * current browser and in Node — so the reader is a hundred lines rather than a
 * megabyte of dependency.
 *
 * ## The two failures a person sees
 *
 * A reader is not a component, so it cannot call `useIntl`. The two errors that
 * reach a screen are `MessageDescriptor`s and the screen formats them — the
 * pattern in `i18n/index.ts`, the same one `lib/failures.ts` uses. They travel
 * on the thrown Error rather than replacing it, so `error.message` still reads
 * as the en-GB sentence for a log, a stack trace, or any caller that has not
 * been taught to look for the descriptor.
 */

import { defineMessages, type MessageDescriptor } from 'react-intl';

const m = defineMessages({
  notAZipFile: { id: 'pipeline.spreadsheet.notAZipFile', defaultMessage: 'Not a zip file' },
  noWorksheet: {
    id: 'pipeline.spreadsheet.noWorksheet',
    defaultMessage: 'No worksheet found in the workbook',
  },
});

/** An Error from this module, carrying the catalogue entry behind it. */
export interface SheetReadError extends Error {
  descriptor: MessageDescriptor;
}

const sheetReadError = (descriptor: MessageDescriptor): SheetReadError =>
  Object.assign(new Error(String(descriptor.defaultMessage)), { descriptor });

/**
 * The catalogue entry behind a read failure, when this module is what threw.
 *
 * Anything else — a platform error, a corrupt buffer — has no descriptor and
 * comes back `undefined`, so the caller keeps its own fallback rather than
 * being handed a message that does not describe what happened.
 */
export const sheetReadMessage = (error: unknown): MessageDescriptor | undefined =>
  error instanceof Error && 'descriptor' in error ? (error as SheetReadError).descriptor : undefined;

export type TableRow = string[];

/** What a sheet turned out to be, which decides where its rows go. */
export type SheetKind = 'bank' | 'documents';

export interface ColumnMap {
  date?: number;
  description?: number;
  /** Supplier on a purchase sheet, customer on a sales one. */
  party?: number;
  /** A single signed amount column. */
  amount?: number;
  /** Separate columns, as most bank exports have. */
  moneyIn?: number;
  moneyOut?: number;
  tax?: number;
  category?: number;
  reference?: number;
  balance?: number;
}

export interface SheetAnalysis {
  kind: SheetKind;
  headers: string[];
  mapping: ColumnMap;
  /** Headers we could not place, kept so the UI can say what was ignored. */
  unmapped: string[];
  rows: TableRow[];
  /** Why we decided it was a bank export or a list of documents. */
  reason: string;
}

/* ── file sniffing ────────────────────────────────────────────────────────── */

const TABULAR = ['csv', 'xlsx', 'xls', 'tsv'];

export const extensionOf = (fileName: string) => fileName.split('.').pop()?.toLowerCase() ?? '';

/** True when there is nothing on this file for OCR to do. */
export const isTabular = (fileName: string) => TABULAR.includes(extensionOf(fileName));

/* ── CSV ──────────────────────────────────────────────────────────────────── */

/**
 * A CSV parser that survives real exports: quoted fields, commas and newlines
 * inside quotes, doubled quotes as an escape, and CRLF endings.
 */
export function parseDelimited(text: string, delimiter = ','): TableRow[] {
  const rows: TableRow[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  // Strip a BOM — Excel writes one and it otherwise poisons the first header.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"') { quoted = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }

  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** Picks the separator an export actually used, rather than assuming a comma. */
export function sniffDelimiter(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  const counts = [',', ';', '\t', '|'].map((d) => [d, line.split(d).length - 1] as const);
  // The candidates are a literal list, so there is always a winner; a tie keeps
  // the earlier candidate, which is the comma.
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : ',';
}

/* ── XLSX ─────────────────────────────────────────────────────────────────── */

/** The two members of the zip we need, and nothing else. */
const SHEET_PATH = /^xl\/worksheets\/sheet1\.xml$/;
const STRINGS_PATH = /^xl\/sharedStrings\.xml$/;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Pulls named files out of a zip by walking the central directory.
 *
 * Reading the central directory rather than scanning local headers means the
 * sizes are authoritative — a local header may carry zeroes and defer to a
 * trailing data descriptor, which is exactly what streaming writers emit.
 */
async function unzip(buffer: ArrayBuffer, want: RegExp[]): Promise<Map<string, string>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const out = new Map<string, string>();

  // End-of-central-directory record, searched from the back past any comment.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65536; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw sheetReadError(m.notAZipFile);

  const entries = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();

  for (let n = 0; n < entries; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    if (want.some((re) => re.test(name))) {
      // The local header's own name/extra lengths give the data offset.
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const raw = bytes.subarray(start, start + compressedSize);
      const data = method === 0 ? raw : await inflateRaw(raw);
      out.set(name, decoder.decode(data));
    }

    p += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}

/** Cell references are A1-style; the column letters give the index. */
function columnIndex(ref: string): number {
  const letters = ref.replace(/[0-9]/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
   .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
   .replace(/&amp;/g, '&');

/** Every `<t>` run inside a shared string, concatenated. */
function sharedStrings(xml: string): string[] {
  // Group 1 is unconditional in both patterns, so a match always carries it and
  // the empty fallbacks never fire.
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    [...(m[1] ?? '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1] ?? '')).join(''),
  );
}

/**
 * Sheet XML to a grid.
 *
 * Blank cells are omitted from the file entirely, so columns are placed by
 * their A1 reference rather than by counting the cells that happen to be
 * present — otherwise one empty cell shifts the whole row left.
 */
function sheetToRows(xml: string, strings: string[]): TableRow[] {
  const rows: TableRow[] = [];

  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    // The row body and the attribute run are unconditional groups; only the
    // cell body is genuinely optional, since `<c/>` is a legal empty cell.
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? '';
      const body = cellMatch[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /t="([^"]+)"/.exec(attrs)?.[1];

      let value = '';
      if (type === 'inlineStr') {
        value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1] ?? '')).join('');
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        value = type === 's' ? strings[Number(v)] ?? '' : unescapeXml(v);
      }

      const at = ref ? columnIndex(ref) : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = value;
    }
    if (cells.some((c) => c.trim() !== '')) rows.push(cells);
  }

  return rows;
}

export async function parseXlsx(buffer: ArrayBuffer): Promise<TableRow[]> {
  const files = await unzip(buffer, [SHEET_PATH, STRINGS_PATH]);
  const sheet = [...files.entries()].find(([n]) => SHEET_PATH.test(n))?.[1];
  if (!sheet) throw sheetReadError(m.noWorksheet);
  const stringsXml = [...files.entries()].find(([n]) => STRINGS_PATH.test(n))?.[1];
  return sheetToRows(sheet, stringsXml ? sharedStrings(stringsXml) : []);
}

/** Reads whichever tabular format this is into a grid of cells. */
export async function readTable(file: File): Promise<TableRow[]> {
  const ext = extensionOf(file.name);
  if (ext === 'xlsx' || ext === 'xls') return parseXlsx(await file.arrayBuffer());
  const text = await file.text();
  return parseDelimited(text, ext === 'tsv' ? '\t' : sniffDelimiter(text));
}

/* ── working out what the columns are ─────────────────────────────────────── */

/**
 * Column names we understand, per role, in order of preference.
 *
 * The order inside each role is the point. A purchase sheet routinely carries
 * Net, VAT and Total, and all three are "amounts" — but the figure that goes
 * to the ledger is the gross. Matching header-by-header instead of role-by-role
 * let whichever column appeared first take the role, so a sheet laid out
 * Net · VAT · Total booked every line at its net value and quietly lost the
 * VAT. Roles claim their best available column first.
 */
const ROLES: { key: keyof ColumnMap; patterns: RegExp[] }[] = [
  { key: 'date', patterns: [/^(transaction|document|invoice|posting)? ?date$/i, /^posted$/i, /^when$/i] },
  { key: 'balance', patterns: [/^(running |closing )?balance$/i] },
  { key: 'moneyIn', patterns: [/^(money in|paid in)$/i, /^credits?$/i, /^receipts?$/i, /^deposits?$/i, /^income$/i] },
  { key: 'moneyOut', patterns: [/^(money out|paid out)$/i, /^debits?$/i, /^payments?$/i, /^withdrawals?$/i, /^spend$/i] },
  { key: 'tax', patterns: [/^(vat|tax|sales tax)( amount)?$/i, /^vat \(.*\)$/i] },
  {
    key: 'amount',
    // Gross first, net last — the ledger wants what was actually paid.
    patterns: [/^(total|gross)( \(.*\))?$/i, /^amount( \(.*\))?$/i, /^value$/i, /^net( \(.*\))?$/i, /^subtotal$/i],
  },
  { key: 'party', patterns: [/^(supplier|vendor|customer|client|payee|merchant|counterparty)$/i, /^(company|name)$/i] },
  { key: 'category', patterns: [/^(category|nominal|class)$/i, /^account( code)?$/i, /^type$/i] },
  { key: 'reference', patterns: [/^(invoice|document) (number|no\.?)$/i, /^(reference|ref)$/i, /^(number|id)$/i] },
  { key: 'description', patterns: [/^(description|details|narrative|memo|particulars)$/i, /^notes?$/i, /^item$/i] },
];

const normalise = (h: string) => h.replace(/\s+/g, ' ').trim();

export function mapColumns(headers: string[]): { mapping: ColumnMap; unmapped: string[] } {
  const mapping: ColumnMap = {};
  const claimed = new Set<number>();
  const clean = headers.map(normalise);

  for (const role of ROLES) {
    for (const pattern of role.patterns) {
      const at = clean.findIndex((h, i) => h && !claimed.has(i) && pattern.test(h));
      if (at >= 0) { mapping[role.key] = at; claimed.add(at); break; }
    }
  }

  const unmapped = clean.filter((h, i) => h && !claimed.has(i));
  return { mapping, unmapped };
}

/**
 * What kind of sheet this is.
 *
 * A bank export and a purchase listing look similar until you notice that only
 * one of them carries a running balance and a paid-in/paid-out pair. Getting
 * this wrong does not just mislabel things — it puts rows in a place where the
 * accountant will never think to look for them.
 */
export function sniffSheet(headers: string[], mapping: ColumnMap): { kind: SheetKind; reason: string } {
  const has = (k: keyof ColumnMap) => mapping[k] !== undefined;

  if (has('balance') && (has('moneyIn') || has('moneyOut'))) {
    return { kind: 'bank', reason: 'a running balance with paid-in and paid-out columns' };
  }
  if (has('balance') && has('amount')) {
    return { kind: 'bank', reason: 'a running balance beside the amounts' };
  }
  if (has('party') || has('reference') || has('tax')) {
    return { kind: 'documents', reason: `a ${headers.length}-column listing with names and amounts` };
  }
  return { kind: 'documents', reason: 'no bank-statement columns found' };
}

/** Everything about a sheet, from raw cells to what its rows are. */
export function analyseSheet(rows: TableRow[]): SheetAnalysis {
  if (!rows.length) {
    return { kind: 'documents', headers: [], mapping: {}, unmapped: [], rows: [], reason: 'the file is empty' };
  }

  // The header is the first row that names at least two things we recognise —
  // exports habitually open with a title line or two of account details.
  let headerAt = 0;
  for (const [i, row] of rows.slice(0, 10).entries()) {
    const { mapping } = mapColumns(row);
    if (Object.keys(mapping).length >= 2) { headerAt = i; break; }
  }

  // headerAt indexes a row we just walked, and the file is non-empty above.
  const headers = (rows[headerAt] ?? []).map(normalise);
  const { mapping, unmapped } = mapColumns(headers);
  const { kind, reason } = sniffSheet(headers, mapping);

  return { kind, headers, mapping, unmapped, rows: rows.slice(headerAt + 1), reason };
}

/* ── reading the cells ────────────────────────────────────────────────────── */

/** Money as written by finance software, in all its variety. */
export function parseAmount(cell: string | undefined): number {
  if (!cell) return 0;
  let s = cell.trim();
  if (!s) return 0;

  // (1,234.56) is negative in accounting exports, and a trailing DR says the
  // same thing. CR is positive, which is what a bare number already means.
  const negative = /^\(.*\)$/.test(s) || /\bdr\b/i.test(s);
  s = s
    .replace(/^\(|\)$/g, '')
    .replace(/\b(cr|dr)\b/gi, '')
    // Currency symbols and codes.
    .replace(/[£$€]|\b(gbp|usd|eur)\b/gi, '')
    // Spaces group thousands across much of Europe — "10 000,50" — including
    // the non-breaking kinds that spreadsheets like to emit.
    .replace(/[\s  ]/g, '');

  /**
   * Which separator is the decimal point.
   *
   * Stripping every comma treats the European "2.000,00" as 2, off by a
   * factor of a thousand — the kind of error that reaches a VAT return. When
   * both separators appear the last one is the decimal point; when only
   * commas appear, three trailing digits means thousands and anything else
   * means a decimal. A lone dot is left as a decimal point, which is the
   * right call for a UK product and the only genuinely ambiguous case.
   */
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    s = lastComma > lastDot
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = s.length - lastComma - 1 === 3 ? s.replace(/,/g, '') : s.replace(',', '.');
  }

  const n = Number.parseFloat(s);
  if (Number.isNaN(n)) return 0;
  return negative ? -Math.abs(n) : n;
}
