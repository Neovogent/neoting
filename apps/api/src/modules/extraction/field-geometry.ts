/**
 * Field → bounding box, derived from the OCR rung's words — the pure,
 * post-extraction half of the contract's `ExtractedField.boundingBox`.
 *
 * ## What this is, and what it is not
 *
 * The model returns VALUES; Textract returns WORDS WITH POSITIONS. This module
 * joins them: for each extracted field, find where its value appears on the
 * document and record that place, normalised 0–1, so the preview can highlight
 * where a figure was read instead of framing the whole image.
 *
 * It is deliberately NOT part of extraction judgement. No prompt changes, no
 * model call, no effect on what is extracted or how confident it is — geometry
 * is post-processing over an answer that already exists, so the §14.7 eval
 * surface is untouched.
 *
 * ## Honest above clever — the matching doctrine
 *
 * A box is only ever attached when the value's rendered form appears in
 * EXACTLY ONE place on the document. Zero occurrences → null (the model may
 * have read something OCR transcribed differently — we do not fuzzy-match our
 * way to a position). Two or more occurrences → null (an invoice where the
 * total's digits also appear as a line amount gives no honest answer to
 * "where was it read", and picking the first is a guess painted over a
 * client's document). Null costs nothing: the preview falls back to framing
 * the whole original, exactly as it always has.
 */

import type { OcrWord } from '../../common/ocr/document-ocr.js';
import type { ExtractedField, FieldBoundingBox } from './document-extractor.js';

/**
 * Currency symbols accepted adjacent to a monetary value. The value itself is
 * integer pence (minor units); which symbol the document printed is the
 * document's business — matching `£405.72`, `$405.72` or `€405.72` places the
 * same read.
 */
const CURRENCY_SYMBOLS = ['£', '$', '€'];

const MONTHS = [
  ['january', 'jan'],
  ['february', 'feb'],
  ['march', 'mar'],
  ['april', 'apr'],
  ['may', 'may'],
  ['june', 'jun'],
  ['july', 'jul'],
  ['august', 'aug'],
  ['september', 'sep'],
  ['october', 'oct'],
  ['november', 'nov'],
  ['december', 'dec'],
] as const;

/** Case folded, inner whitespace collapsed — the ONLY normalisation strings get. */
function normalise(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * One rendered form of a value, as the token run it would occupy on the page.
 * `£ 405.72` is two words on some documents and one on others, so a candidate
 * is a SEQUENCE, not a string.
 */
type Candidate = readonly string[];

/** A consecutive word run that matched, by index into the flat words array. */
interface Run {
  readonly page: number;
  start: number;
  end: number; // inclusive
}

/**
 * A word token equals a candidate token when they normalise identically —
 * with one worldly concession for punctuation that ATTACHES to a word in
 * print: `LLC.`, `12,` (as in “May 12, 2025”) and a value quoted or
 * bracketed by its layout. Trailing `.,;:` and wrapping brackets/quotes are
 * shed from the WORD before comparing; the candidate itself is never altered,
 * so the value still has to appear verbatim.
 */
function tokenMatches(word: string, token: string): boolean {
  const w = normalise(word);
  if (w === token) return true;
  const shed = w.replace(/^[("'[]+/, '').replace(/[)"'\],.;:]+$/, '');
  return shed === token;
}

/** Every place any candidate matches, overlaps merged into distinct regions. */
function findRegions(words: readonly OcrWord[], candidates: readonly Candidate[]): Run[] {
  const runs: Run[] = [];
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    for (let start = 0; start + candidate.length <= words.length; start += 1) {
      const first = words[start];
      if (first === undefined) continue;
      let matched = true;
      for (let offset = 0; offset < candidate.length; offset += 1) {
        const word = words[start + offset];
        const token = candidate[offset];
        if (
          word === undefined ||
          token === undefined ||
          word.pageNumber !== first.pageNumber ||
          !tokenMatches(word.text, token)
        ) {
          matched = false;
          break;
        }
      }
      if (matched) runs.push({ page: first.pageNumber, start, end: start + candidate.length - 1 });
    }
  }

  // Merge overlapping runs into regions. Two candidates for the SAME value can
  // legitimately land on the same spot — `£` + `405.72` as a pair and `405.72`
  // alone — and that is one place on the page, not an ambiguity. Two DISJOINT
  // regions are the real ambiguity and stay two.
  runs.sort((a, b) => (a.page - b.page) || (a.start - b.start));
  const regions: Run[] = [];
  for (const run of runs) {
    const last = regions[regions.length - 1];
    if (last !== undefined && last.page === run.page && run.start <= last.end + 0) {
      last.end = Math.max(last.end, run.end);
    } else {
      regions.push({ page: run.page, start: run.start, end: run.end });
    }
  }
  return regions;
}

/** The union of the run's word boxes — the smallest box holding every word. */
function unionBox(words: readonly OcrWord[], run: Run): FieldBoundingBox {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let index = run.start; index <= run.end; index += 1) {
    const word = words[index];
    if (word === undefined) continue;
    left = Math.min(left, word.box.x);
    top = Math.min(top, word.box.y);
    right = Math.max(right, word.box.x + word.box.width);
    bottom = Math.max(bottom, word.box.y + word.box.height);
  }
  return { page: run.page, x: left, y: top, width: right - left, height: bottom - top };
}

/* ── candidate builders, one per value shape ─────────────────────────────── */

/** A string value: exactly its own words, case/whitespace-normalised. */
function stringCandidates(value: string): Candidate[] {
  const tokens = normalise(value).split(' ').filter((token) => token !== '');
  return tokens.length === 0 ? [] : [tokens];
}

/** Thousands separators into a bare digit string: `54352` → `54,352`. */
function grouped(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The rendered forms of an integer-pence value. All arithmetic is INTEGER —
 * units and minor units split by division and remainder, never a float on a
 * money path.
 *
 * With decimals the bare number is distinctive (`405.72`, `54,352.51`) and is
 * matched with or without an adjacent currency symbol. WITHOUT decimals the
 * bare integer is not — `1299` could be an invoice number — so the whole-unit
 * form (`£1,299`) is only ever matched WITH its symbol.
 */
function moneyCandidates(pence: number): Candidate[] {
  if (!Number.isInteger(pence)) return [];
  const sign = pence < 0 ? '-' : '';
  const abs = Math.abs(pence);
  const units = String(Math.trunc(abs / 100));
  const minor = String(abs % 100).padStart(2, '0');

  const decimalForms = new Set([`${sign}${units}.${minor}`, `${sign}${grouped(units)}.${minor}`]);
  const wholeForms = new Set(abs % 100 === 0 ? [`${sign}${units}`, `${sign}${grouped(units)}`] : []);

  const candidates: Candidate[] = [];
  for (const form of decimalForms) candidates.push([form]);
  for (const symbol of CURRENCY_SYMBOLS) {
    for (const form of [...decimalForms, ...wholeForms]) {
      candidates.push([`${symbol}${form}`]); // symbol attached: £405.72
      candidates.push([symbol, form]); // symbol its own word: £ 405.72
    }
  }
  return candidates;
}

/**
 * The rendered forms of a `YYYY-MM-DD` value: the ISO form itself, UK numeric
 * d/m/y with the common separators, and the written-month forms — day-first
 * (`4 August 2026`, with or without an ordinal suffix) and month-first
 * (`August 4, 2026`; the comma is the word's, shed by `tokenMatches`). Only
 * four-digit years: a two-digit year is ambiguous and honesty wins.
 */
function dateCandidates(value: string): Candidate[] {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (parts === null) return [];
  const [, year, paddedMonth, paddedDay] = parts;
  if (year === undefined || paddedMonth === undefined || paddedDay === undefined) return [];
  const monthIndex = Number.parseInt(paddedMonth, 10) - 1;
  const names = MONTHS[monthIndex];
  if (names === undefined) return [];
  const day = String(Number.parseInt(paddedDay, 10));

  const candidates: Candidate[] = [[value.toLowerCase()]];
  for (const separator of ['/', '-', '.']) {
    for (const dayForm of new Set([paddedDay, day])) {
      for (const monthForm of new Set([paddedMonth, String(monthIndex + 1)])) {
        candidates.push([`${dayForm}${separator}${monthForm}${separator}${year}`]);
      }
    }
  }
  const ordinal =
    day.endsWith('1') && day !== '11' ? 'st'
    : day.endsWith('2') && day !== '12' ? 'nd'
    : day.endsWith('3') && day !== '13' ? 'rd'
    : 'th';
  for (const month of names) {
    for (const dayForm of new Set([paddedDay, day, `${day}${ordinal}`])) {
      candidates.push([dayForm, month, year]);
    }
    candidates.push([month, day, year]);
    candidates.push([month, paddedDay, year]);
  }
  return candidates;
}

/* ── the field table ─────────────────────────────────────────────────────── */

const MONEY_FIELDS = new Set(['totalPence', 'taxPence']);
const DATE_FIELDS = new Set(['documentDate', 'dueDate']);
/**
 * Fields that are a JUDGEMENT over the whole document rather than a
 * transcription of a span on it — there is no "where it was read" to point at,
 * so no box is ever derived. (`docType` is a classification; the word
 * "INVOICE" appearing once does not make it the place the type came from.)
 */
const UNPLACEABLE_FIELDS = new Set(['docType']);

function candidatesFor(key: string, value: string | number | boolean | null): Candidate[] {
  if (value === null || typeof value === 'boolean') return [];
  if (UNPLACEABLE_FIELDS.has(key)) return [];
  if (MONEY_FIELDS.has(key)) return typeof value === 'number' ? moneyCandidates(value) : [];
  if (DATE_FIELDS.has(key)) return typeof value === 'string' ? dateCandidates(value) : [];
  return typeof value === 'string' ? stringCandidates(value) : [];
}

/**
 * The box for one field value, or null. Exposed for the tests; the pipeline
 * uses `withFieldGeometry`.
 */
export function deriveFieldBox(
  key: string,
  value: string | number | boolean | null,
  words: readonly OcrWord[],
): FieldBoundingBox | null {
  const candidates = candidatesFor(key, value);
  if (candidates.length === 0 || words.length === 0) return null;
  const regions = findRegions(words, candidates);
  const only = regions[0];
  // EXACTLY one distinct place, or nothing. Never the first of several.
  return regions.length === 1 && only !== undefined ? unionBox(words, only) : null;
}

/**
 * Every field, with its `boundingBox` filled in — a real box where the value
 * sits in exactly one place, an explicit null everywhere else (no OCR, no
 * words, no verbatim occurrence, or more than one). The explicit null is the
 * contract's own vocabulary for "not placed", and writing it uniformly keeps
 * the persisted shape identical whichever way a field failed to place.
 */
export function withFieldGeometry(
  fields: Readonly<Record<string, ExtractedField>>,
  words: readonly OcrWord[] | undefined,
): Record<string, ExtractedField> {
  const placed: Record<string, ExtractedField> = {};
  for (const [key, field] of Object.entries(fields)) {
    placed[key] = { ...field, boundingBox: deriveFieldBox(key, field.value, words ?? []) };
  }
  return placed;
}
