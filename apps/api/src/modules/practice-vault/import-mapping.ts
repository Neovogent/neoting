/**
 * Column mapping for capture-tool export bundles (Dext, Hubdoc, AutoEntry,
 * Datamolino, or any CSV) — rush/documents. Pure: grid in, mapped rows out.
 *
 * Money is parsed from the TEXT into integer pence; no float ever touches it.
 * Dates are UK day/month/year first, as every one of these tools exports for
 * a UK practice.
 */

export const IMPORT_FIELDS = [
  'date',
  'supplier',
  'reference',
  'net',
  'vat',
  'total',
  'category',
  'description',
  'image',
  'currency',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ImportMapping = Partial<Record<ImportField, string>>;

/** Normalised header → field. Covers the four vendors' own export headers. */
const ALIASES: Readonly<Record<ImportField, readonly string[]>> = {
  date: ['date', 'invoice date', 'document date', 'receipt date', 'transaction date', 'issue date', 'purchase date', 'bill date'],
  supplier: ['supplier', 'supplier name', 'merchant', 'merchant name', 'vendor', 'vendor name', 'contact', 'contact name', 'payee', 'from', 'seller'],
  reference: ['reference', 'ref', 'invoice number', 'invoice no', 'invoice', 'invoice ref', 'document number', 'document no', 'receipt number', 'bill number'],
  net: ['net', 'net amount', 'net total', 'subtotal', 'sub total', 'amount net', 'total without vat', 'total excl vat', 'amount excl vat', 'net value'],
  vat: ['vat', 'tax', 'vat amount', 'tax amount', 'total vat', 'total tax', 'vat total'],
  total: ['total', 'gross', 'gross amount', 'total amount', 'amount', 'total incl vat', 'amount incl vat', 'gross total', 'total gbp'],
  category: ['category', 'account', 'account name', 'account code', 'nominal', 'nominal code', 'gl account', 'expense category', 'expense type'],
  description: ['description', 'notes', 'note', 'memo', 'details', 'comment', 'comments'],
  image: ['image', 'image name', 'image filename', 'image file', 'image url', 'file name', 'filename', 'file', 'attachment', 'attachment name', 'document', 'receipt image', 'document filename', 'original filename'],
  currency: ['currency', 'currency code'],
};

export function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export interface MappedRow {
  readonly rowNumber: number;
  readonly supplierName: string | null;
  readonly documentDate: string | null;
  readonly reference: string | null;
  readonly netPence: number | null;
  readonly taxPence: number | null;
  readonly totalPence: number | null;
  readonly currency: string | null;
  readonly categoryCode: string | null;
  readonly description: string | null;
  readonly imageFilename: string | null;
}

export interface MappingResult {
  readonly columns: string[];
  readonly mapping: Record<ImportField, string | null>;
  readonly rows: MappedRow[];
  readonly warnings: string[];
}

/** Which column index answers each field; an explicit override beats an alias. */
export function detectMapping(headers: readonly string[], override: ImportMapping = {}): Record<ImportField, number | null> {
  const normalised = headers.map(normaliseHeader);
  const taken = new Set<number>();
  const out = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, null])) as Record<ImportField, number | null>;
  for (const field of IMPORT_FIELDS) {
    const wanted = override[field];
    if (wanted === undefined || wanted === '') continue;
    const index = normalised.indexOf(normaliseHeader(wanted));
    if (index !== -1) {
      out[field] = index;
      taken.add(index);
    }
  }
  for (const field of IMPORT_FIELDS) {
    if (out[field] !== null || override[field] !== undefined) continue;
    const index = normalised.findIndex((h, i) => !taken.has(i) && ALIASES[field].includes(h));
    if (index !== -1) {
      out[field] = index;
      taken.add(index);
    }
  }
  return out;
}

/** "£1,234.56", "-12.00", "(12.00)", "12" → pence. Anything else → null. */
export function parsePence(raw: string): number | null {
  let s = raw.trim().replace(/[£$€\s,]/g, '').replace(/^(GBP|USD|EUR)/i, '');
  if (s === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (m === null) return null;
  const pence = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return negative ? -pence : pence;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** UK d/m/y, ISO y-m-d, or "12 Mar 2026" → "YYYY-MM-DD". */
export function parseUkDate(raw: string): string | null {
  const s = raw.trim();
  let y: number;
  let mo: number;
  let d: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m !== null) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/.exec(s)) !== null) {
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (m[3]?.length === 2) y += 2000;
  } else if ((m = /^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-,]+(\d{4})/.exec(s)) !== null) {
    const month = MONTHS.indexOf((m[2] ?? '').slice(0, 3).toLowerCase());
    if (month === -1) return null;
    [d, mo, y] = [Number(m[1]), month + 1, Number(m[3])];
  } else return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** The bare file name a cell points at — also strips a URL's path and query. */
export function imageBasename(raw: string): string | null {
  const s = raw.trim().split(/[?#]/)[0] ?? '';
  const base = s.split(/[\\/]/).pop()?.trim() ?? '';
  return base === '' ? null : base;
}

export function mapRows(grid: readonly string[][], override: ImportMapping = {}): MappingResult {
  const headerIndex = grid.findIndex((row) => row.filter((cell) => cell.trim() !== '').length >= 2);
  if (headerIndex === -1) {
    return { columns: [], mapping: emptyMapping(), rows: [], warnings: ['The CSV has no header row.'] };
  }
  const headers = (grid[headerIndex] ?? []).map((h) => h.trim());
  const index = detectMapping(headers, override);
  const mapping = Object.fromEntries(
    IMPORT_FIELDS.map((f) => [f, index[f] === null ? null : (headers[index[f] as number] ?? null)]),
  ) as Record<ImportField, string | null>;

  const warnings: string[] = [];
  const unused = headers.filter((h, i) => h !== '' && !Object.values(index).includes(i));
  if (unused.length > 0) warnings.push(`Columns not used: ${unused.join(', ')}.`);
  const missing = (['date', 'supplier', 'total'] as const).filter((f) => index[f] === null && !(f === 'total' && index.net !== null));
  if (missing.length > 0) warnings.push(`No column found for: ${missing.join(', ')}. Choose one by hand if the file has it.`);

  const cell = (row: readonly string[], field: ImportField): string | null => {
    const i = index[field];
    if (i === null) return null;
    const v = row[i]?.trim() ?? '';
    return v === '' ? null : v;
  };

  const rows: MappedRow[] = [];
  grid.slice(headerIndex + 1).forEach((row, offset) => {
    if (row.every((c) => c.trim() === '')) return;
    const rowNumber = headerIndex + offset + 2; // 1-based, as a spreadsheet shows it
    const money = (field: 'net' | 'vat' | 'total'): number | null => {
      const raw = cell(row, field);
      if (raw === null) return null;
      const pence = parsePence(raw);
      if (pence === null) warnings.push(`Row ${rowNumber}: could not read ${field} "${raw}".`);
      return pence;
    };
    const net = money('net');
    let vat = money('vat');
    let total = money('total');
    if (total === null && net !== null) total = net + (vat ?? 0);
    if (vat === null && total !== null && net !== null) vat = total - net;

    const rawDate = cell(row, 'date');
    const documentDate = rawDate === null ? null : parseUkDate(rawDate);
    if (rawDate !== null && documentDate === null) warnings.push(`Row ${rowNumber}: could not read date "${rawDate}".`);
    const rawImage = cell(row, 'image');

    rows.push({
      rowNumber,
      supplierName: cell(row, 'supplier'),
      documentDate,
      reference: cell(row, 'reference'),
      netPence: net,
      taxPence: vat,
      totalPence: total,
      currency: cell(row, 'currency')?.toUpperCase().slice(0, 3) ?? null,
      categoryCode: cell(row, 'category'),
      description: cell(row, 'description'),
      imageFilename: rawImage === null ? null : imageBasename(rawImage),
    });
  });
  return { columns: headers, mapping, rows, warnings };
}

function emptyMapping(): Record<ImportField, string | null> {
  return Object.fromEntries(IMPORT_FIELDS.map((f) => [f, null])) as Record<ImportField, string | null>;
}
