import { inflateSync } from 'node:zlib';

import type { Grid } from './sheet-reader.js';

/**
 * A text-based PDF bank statement → the same grid a CSV produces.
 *
 * ## Why a grid, and not a model call
 *
 * A statement PDF is a table that happens to be drawn rather than delimited.
 * Every value is already exact in the file — the amounts are text, not pixels —
 * so recovering the grid keeps D41's proof available: balance continuity is
 * still arithmetic over the bank's own figures, and nothing downstream changes.
 * Sending it to a model instead would replace exact input with an opinion, and
 * a confidence score cannot prove a statement is complete.
 *
 * ## What this reads, and what it does not
 *
 * **Text-based PDFs only.** Text is recovered from the content stream's own
 * show-text operators with their positions, then grouped into rows by Y and
 * ordered into columns by X. A SCANNED statement is an image with no text
 * objects; it yields no rows and is refused rather than half-read — that case
 * needs OCR, which is the extraction lane's job, not this one.
 *
 * Encrypted PDFs are refused. Font-level encoding differences are handled only
 * to the extent of the standard escapes and hex strings, which is what a bank's
 * own generator emits; a document that decodes to nothing sensible produces no
 * rows and is refused honestly.
 */

export type PdfFailure = { reason: 'notAPdf' } | { reason: 'encrypted' } | { reason: 'noTextFound' };

export type PdfResult = { ok: true; grid: Grid } | { ok: false; failure: PdfFailure };

/** One positioned run of text, before rows are assembled. */
interface Piece {
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

/**
 * Rows are grouped by Y with a tolerance, because a table row's cells are not
 * emitted at identical Y — a font's baseline shifts by a fraction between
 * runs, and an exact match splits one row into several.
 */
const ROW_TOLERANCE = 3;

/**
 * Two runs closer than this on X are the same cell, continued.
 *
 * A PDF emits `BIDFOOD LTD` as several runs when kerning changes, and joining
 * them with a separator would invent columns that are not in the table.
 */
const CELL_GAP = 12;

/**
 * How far apart two x positions must be to be different columns.
 *
 * Generous, because a bank right-aligns its money columns: the same column's
 * runs start at different x depending on how many digits the amount has.
 */
const COLUMN_TOLERANCE = 25;

export function readPdf(bytes: Buffer): PdfResult {
  if (!bytes.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
    return { ok: false, failure: { reason: 'notAPdf' } };
  }
  // An encrypted document decodes to noise. Saying so beats returning nothing
  // and letting the caller report "no transaction table found".
  if (/\/Encrypt\b/.test(bytes.toString('latin1'))) {
    return { ok: false, failure: { reason: 'encrypted' } };
  }

  const pieces: Piece[] = [];
  for (const stream of contentStreams(bytes)) {
    collectText(stream, pieces);
  }
  if (pieces.length === 0) return { ok: false, failure: { reason: 'noTextFound' } };

  return { ok: true, grid: toGrid(pieces) };
}

/**
 * Every stream in the file, inflated where it is Flate-compressed.
 *
 * Deliberately NOT resolved through the page tree. Walking `/Root → /Pages →
 * /Contents` is the correct way to find *page* content, and it needs the xref
 * table, object streams and indirect-reference resolution — a great deal of
 * machinery whose only benefit here is skipping streams that are not page
 * content. Those streams contain no text operators, so they contribute nothing
 * and cost a regex. Reading every stream is smaller, and wrong in no way that
 * shows up in the output.
 */
function* contentStreams(bytes: Buffer): Generator<string> {
  const latin = bytes.toString('latin1');
  const re = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(latin)) !== null) {
    const start = match.index + match[0].length;
    const end = latin.indexOf('endstream', start);
    if (end === -1) continue;
    const raw = bytes.subarray(start, end);
    // The dictionary immediately before the stream says how it is encoded.
    const dict = latin.slice(Math.max(0, match.index - 400), match.index);
    if (/\/FlateDecode/.test(dict)) {
      try {
        yield inflateSync(raw).toString('latin1');
      } catch {
        // A stream we cannot inflate is one we do not have. Skipped, not fatal:
        // a statement's text usually lives in several streams and the rest may
        // still carry the table.
        continue;
      }
    } else {
      yield raw.toString('latin1');
    }
  }
}

/**
 * Walks a content stream's text operators, tracking the current position.
 *
 * Only the operators that move the text cursor or show text matter. `Tm` sets
 * the matrix absolutely (its last two numbers are the translation); `Td`/`TD`
 * move relative to the line start; `T*` and `'` begin a new line, which is why
 * the leading is tracked — a statement whose rows are emitted by `T*` has no
 * other source of Y movement.
 */
function collectText(stream: string, out: Piece[]): void {
  let x = 0;
  let y = 0;
  let lineX = 0;
  let lineY = 0;
  let leading = 12;

  const token = /(-?[\d.]+)\s+(-?[\d.]+)\s+(Td|TD)|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|(-?[\d.]+)\s+TL|(T\*)|\((?:[^()\\]|\\.)*\)\s*(?:Tj|')|\[(?:[^\][\\]|\\.)*\]\s*TJ|<([0-9A-Fa-f\s]*)>\s*Tj/g;

  let m: RegExpExecArray | null;
  while ((m = token.exec(stream)) !== null) {
    const whole = m[0];
    if (m[3] !== undefined) {
      // Td / TD — relative move from the start of the current line.
      const dx = Number.parseFloat(m[1] ?? '0');
      const dy = Number.parseFloat(m[2] ?? '0');
      if (m[3] === 'TD') leading = -dy;
      lineX += dx;
      lineY += dy;
      x = lineX;
      y = lineY;
      continue;
    }
    if (whole.endsWith('Tm')) {
      // ⚠ Groups 8 and 9, which are `e` and `f` — the TRANSLATION components of
      // the 6-number text matrix `a b c d e f`. Groups 4-7 are the scale and
      // skew. Reading 9 and 10 instead (as a first cut did) takes `f` as x and
      // the next alternative's capture as y, so every run lands at y=0 and the
      // whole statement collapses into one row.
      x = lineX = Number.parseFloat(m[8] ?? '0');
      y = lineY = Number.parseFloat(m[9] ?? '0');
      continue;
    }
    if (whole.endsWith('TL')) {
      leading = Number.parseFloat(m[10] ?? '12');
      continue;
    }
    if (m[11] !== undefined) {
      lineY -= leading;
      x = lineX;
      y = lineY;
      continue;
    }
    if (whole.endsWith('TJ')) {
      out.push({ x, y, text: decodeArray(whole) });
      continue;
    }
    if (m[12] !== undefined) {
      out.push({ x, y, text: decodeHex(m[12]) });
      continue;
    }
    // `(...) Tj` or `(...) '` — the apostrophe form also opens a new line.
    if (whole.trimEnd().endsWith("'")) {
      lineY -= leading;
      x = lineX;
      y = lineY;
    }
    out.push({ x, y, text: decodeLiteral(whole) });
  }
}

/** `[(A) -300 (B)] TJ` — the numbers are kerning, not content. */
function decodeArray(op: string): string {
  return [...op.matchAll(/\((?:[^()\\]|\\.)*\)/g)].map(([s]) => decodeLiteral(s)).join('');
}

function decodeLiteral(op: string): string {
  const open = op.indexOf('(');
  const close = op.lastIndexOf(')');
  if (open === -1 || close <= open) return '';
  return op
    .slice(open + 1, close)
    .replace(/\\([nrtbf()\\])/g, (_, c: string) =>
      c === 'n' ? '\n' : c === 'r' ? '' : c === 't' ? ' ' : c === 'b' || c === 'f' ? '' : c,
    )
    .replace(/\\([0-7]{1,3})/g, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8)));
}

function decodeHex(body: string): string {
  const hex = body.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Positioned runs → a grid.
 *
 * Rows are Y bands, ordered top-down (PDF's Y grows upward, so the sort is
 * descending). Within a row, runs are ordered by X and merged when they are
 * close enough to be one cell — which is what stops a kerned supplier name
 * becoming three columns and shifting every amount.
 */
function toGrid(pieces: Piece[]): Grid {
  const rows = new Map<number, Piece[]>();
  for (const piece of pieces) {
    if (piece.text.trim() === '') continue;
    const key = [...rows.keys()].find((k) => Math.abs(k - piece.y) <= ROW_TOLERANCE);
    if (key === undefined) rows.set(piece.y, [piece]);
    else rows.get(key)?.push(piece);
  }

  // Merge runs that are one cell continued, per row, BEFORE columns are worked
  // out — otherwise a kerned supplier name votes several times for column
  // anchors that are really the middle of one cell.
  const merged = [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, run]) => {
      const ordered = [...run].sort((a, b) => a.x - b.x);
      const cells: Piece[] = [];
      for (const piece of ordered) {
        const last = cells[cells.length - 1];
        if (last !== undefined && piece.x - (last.x + last.text.length * 5) < CELL_GAP) {
          cells[cells.length - 1] = { x: last.x, y: last.y, text: last.text + piece.text };
        } else cells.push(piece);
      }
      return cells;
    });

  // ⚠ COLUMNS COME FROM X, NOT FROM POSITION IN THE ROW.
  //
  // A PDF emits nothing at all for an empty cell. So a statement row with no
  // value under "Paid in" has one fewer run than the header, and reading the
  // runs positionally slides every later value one column left — the closing
  // balance lands under "Paid out" and the statement parses into plausible,
  // wrong numbers. This is the same failure the XLSX reader avoids by honouring
  // the cell reference; here the run's own x is the reference.
  //
  // Anchors are the distinct x positions across the whole document, clustered:
  // every row votes, so a column exists if anything ever appeared in it.
  const anchors: number[] = [];
  for (const row of merged) {
    for (const cell of row) {
      if (!anchors.some((a) => Math.abs(a - cell.x) <= COLUMN_TOLERANCE)) anchors.push(cell.x);
    }
  }
  anchors.sort((a, b) => a - b);

  return merged.map((row) => {
    const cells: string[] = new Array(anchors.length).fill('');
    for (const cell of row) {
      let best = 0;
      for (let i = 1; i < anchors.length; i += 1) {
        if (Math.abs((anchors[i] ?? 0) - cell.x) < Math.abs((anchors[best] ?? 0) - cell.x)) best = i;
      }
      // Two runs landing in one column means the clustering was too coarse for
      // this document; joining beats dropping one silently.
      cells[best] = cells[best] === '' ? cell.text.trim() : `${cells[best]} ${cell.text.trim()}`;
    }
    return cells;
  });
}
