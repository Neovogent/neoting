/**
 * ⚠ **THE ENCODING DECISION POINT. Stage A10 changes the constant below and
 * nothing else.**
 *
 * Which byte encoding VT Transaction+ reads a CSV in is a **genuinely open
 * question** — it is not settled by VT's published help, and it can only be
 * settled by importing a file containing an accented supplier name into a real
 * VT on a real Windows machine, which is exactly what A10 is for. Everything
 * about this module is arranged so that answer costs one line:
 *
 *   - Nothing else in the module calls `Buffer.from(…, encoding)`.
 *   - Nothing else writes a byte-order mark.
 *   - `serialiseCsv` builds a `string`; this file turns it into bytes, once.
 *
 * **The default is `utf-8-with-bom`, and it is a considered guess, not a
 * shrug.** VT is a long-lived Windows desktop application, and on Windows a
 * leading `EF BB BF` is the conventional way a text file announces UTF-8 to a
 * reader that would otherwise assume the system ANSI code page. Without it, a
 * legacy reader renders `Café` as `CafÃ©` — and because that string is the
 * `Primary account` VT's Converter maps a supplier by, a mangled byte is not a
 * cosmetic defect: it creates a second supplier account on every import and
 * destroys the byte-stability §24.3.1 calls the highest-leverage detail in the
 * whole export.
 *
 * **The two ways the guess can be wrong, and what A10 does about each:**
 *
 * | What A10 sees in VT | Change `CSV_ENCODING` to |
 * |---|---|
 * | A stray `ï»¿` on the first cell of the first row | `'utf-8'` |
 * | `CafÃ©` where `Café` was expected | `'windows-1252'` |
 *
 * `windows-1252` is implemented here rather than imported: the module takes no
 * new dependency for it, and Node ships no encoder for it. It is Latin-1 plus a
 * 32-character block at `0x80`–`0x9F` (the curly quotes, the dashes, the euro
 * sign) — the characters a supplier name copied out of Word actually contains.
 */

/** The encodings this module can write. Anything else needs a dependency, and does not get one. */
export type CsvEncoding = 'utf-8-with-bom' | 'utf-8' | 'windows-1252';

/**
 * ⚠ **A10 CHANGES THIS LINE.** See the file header for what to change it to and
 * why. It is a single constant on purpose: an encoding decision scattered
 * across an emitter is an encoding decision nobody can revisit.
 */
export const CSV_ENCODING: CsvEncoding = 'utf-8-with-bom';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * The 0x80–0x9F block, which is where windows-1252 and Latin-1 disagree.
 * Keyed by Unicode code point, valued by the windows-1252 byte.
 */
const WINDOWS_1252_HIGH_CONTROL: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], // €
  [0x201a, 0x82], // ‚
  [0x0192, 0x83], // ƒ
  [0x201e, 0x84], // „
  [0x2026, 0x85], // …
  [0x2020, 0x86], // †
  [0x2021, 0x87], // ‡
  [0x02c6, 0x88], // ˆ
  [0x2030, 0x89], // ‰
  [0x0160, 0x8a], // Š
  [0x2039, 0x8b], // ‹
  [0x0152, 0x8c], // Œ
  [0x017d, 0x8e], // Ž
  [0x2018, 0x91], // '
  [0x2019, 0x92], // '
  [0x201c, 0x93], // "
  [0x201d, 0x94], // "
  [0x2022, 0x95], // •
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x02dc, 0x98], // ˜
  [0x2122, 0x99], // ™
  [0x0161, 0x9a], // š
  [0x203a, 0x9b], // ›
  [0x0153, 0x9c], // œ
  [0x017e, 0x9e], // ž
  [0x0178, 0x9f], // Ÿ
]);

/**
 * The byte a character that windows-1252 cannot represent becomes.
 *
 * `?` and not a silent drop: a supplier name that lost a character is a name
 * that no longer matches its saved Converter mapping, and a visible `?` is the
 * only version of that failure an accountant can see and report.
 */
const UNREPRESENTABLE = 0x3f;

function encodeWindows1252(text: string): Buffer {
  const bytes: number[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? UNREPRESENTABLE;
    if (codePoint <= 0x7f || (codePoint >= 0xa0 && codePoint <= 0xff)) {
      bytes.push(codePoint);
      continue;
    }
    bytes.push(WINDOWS_1252_HIGH_CONTROL.get(codePoint) ?? UNREPRESENTABLE);
  }
  return Buffer.from(bytes);
}

/**
 * Text to bytes, in the one place this module does it.
 *
 * `encoding` is a parameter so tests can prove all three branches; production
 * callers pass nothing and get {@link CSV_ENCODING}.
 */
export function encodeCsv(text: string, encoding: CsvEncoding = CSV_ENCODING): Buffer {
  switch (encoding) {
    case 'utf-8-with-bom':
      return Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')]);
    case 'utf-8':
      return Buffer.from(text, 'utf8');
    case 'windows-1252':
      return encodeWindows1252(text);
  }
}
