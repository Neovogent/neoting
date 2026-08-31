import { describe, expect, it } from 'vitest';

import type { OcrWord } from '../../common/ocr/document-ocr.js';
import { deriveFieldBox, withFieldGeometry } from './field-geometry.js';
import { aiField } from './document-extractor.js';

/**
 * The field→box matcher. The rule under test everywhere: a box is attached
 * only when the value's rendered form appears in EXACTLY ONE place — zero and
 * "more than one" are both null, never a guess, never "the first one".
 */

/** A word at a position; x spaces words out so unions are checkable. */
function word(text: string, x: number, y: number, page = 1, width = 0.05, height = 0.02): OcrWord {
  return { text, pageNumber: page, box: { x, y, width, height } };
}

/** A typical invoice header strip, one occurrence of everything. */
const INVOICE: OcrWord[] = [
  word('INVOICE', 0.4, 0.05),
  word('Nexora', 0.1, 0.1),
  word('Solutions', 0.16, 0.1),
  word('LLC', 0.22, 0.1),
  word('Ref:', 0.1, 0.15),
  word('INV-2025-0412', 0.22, 0.15),
  word('Date:', 0.1, 0.2),
  word('12/05/2025', 0.16, 0.2),
  word('Total', 0.1, 0.3),
  word('£405.72', 0.2, 0.3),
];

describe('string values', () => {
  it('matches a multi-word run and returns the union of its word boxes', () => {
    const box = deriveFieldBox('supplierName', 'Nexora Solutions LLC', INVOICE);
    expect(box).toEqual({
      page: 1,
      x: 0.1,
      y: 0.1,
      width: expect.closeTo(0.22 + 0.05 - 0.1, 10) as number,
      height: expect.closeTo(0.02, 10) as number,
    });
  });

  it('normalises case and whitespace, and nothing else', () => {
    expect(deriveFieldBox('supplierName', '  nexora   SOLUTIONS llc ', INVOICE)).not.toBeNull();
    // A different value is a different value — no fuzzy matching.
    expect(deriveFieldBox('supplierName', 'Nexora Solutions Ltd', INVOICE)).toBeNull();
  });

  it('sheds punctuation that print attaches to a word, never letters', () => {
    const words = [word('Nexora', 0.1, 0.1), word('Solutions', 0.2, 0.1), word('LLC.', 0.3, 0.1)];
    expect(deriveFieldBox('supplierName', 'Nexora Solutions LLC', words)).not.toBeNull();
  });

  it('is null when the value does not appear', () => {
    expect(deriveFieldBox('supplierName', 'Bidfood', INVOICE)).toBeNull();
  });

  it('is null when the value appears twice — never "the first one"', () => {
    const words = [...INVOICE, word('Nexora', 0.1, 0.9), word('Solutions', 0.16, 0.9), word('LLC', 0.22, 0.9)];
    expect(deriveFieldBox('supplierName', 'Nexora Solutions LLC', words)).toBeNull();
  });

  it('never matches a run across a page boundary', () => {
    const words = [word('Nexora', 0.1, 0.95, 1), word('Solutions', 0.1, 0.05, 2), word('LLC', 0.2, 0.05, 2)];
    expect(deriveFieldBox('supplierName', 'Nexora Solutions LLC', words)).toBeNull();
  });

  it('carries the page the match sits on', () => {
    const words = [word('Nexora', 0.1, 0.1, 3), word('Solutions', 0.2, 0.1, 3), word('LLC', 0.3, 0.1, 3)];
    expect(deriveFieldBox('supplierName', 'Nexora Solutions LLC', words)?.page).toBe(3);
  });
});

describe('monetary pence values', () => {
  it('matches the plain decimal form', () => {
    expect(deriveFieldBox('totalPence', 40572, [word('405.72', 0.2, 0.3)])).not.toBeNull();
  });

  it('matches with the currency symbol attached', () => {
    expect(deriveFieldBox('totalPence', 40572, INVOICE)?.x).toBeCloseTo(0.2, 10);
  });

  it('collapses the symbol-as-its-own-word and bare forms into ONE place, and unions the symbol in', () => {
    // "£" + "405.72" as two words: the two-token candidate matches [£,405.72]
    // and the bare candidate matches [405.72] — overlapping, so one region.
    const words = [word('£', 0.18, 0.3, 1, 0.01), word('405.72', 0.2, 0.3)];
    const box = deriveFieldBox('totalPence', 40572, words);
    expect(box).not.toBeNull();
    expect(box?.x).toBeCloseTo(0.18, 10);
  });

  it('matches thousands separators and a non-sterling symbol', () => {
    expect(deriveFieldBox('totalPence', 5435251, [word('$54,352.51', 0.6, 0.4)])).not.toBeNull();
    expect(deriveFieldBox('totalPence', 5435251, [word('54,352.51', 0.6, 0.4)])).not.toBeNull();
  });

  it('matches a whole-pound rendering only WITH its symbol — a bare integer could be anything', () => {
    expect(deriveFieldBox('totalPence', 129900, [word('£1,299', 0.6, 0.4)])).not.toBeNull();
    expect(deriveFieldBox('totalPence', 129900, [word('1299', 0.6, 0.4)])).toBeNull();
    expect(deriveFieldBox('totalPence', 129900, [word('1,299', 0.6, 0.4)])).toBeNull();
  });

  it('is null when the rendered amount appears four times — the ambiguity rule', () => {
    // 150 pence renders as 1.50; a receipt with four £1.50 lines gives no
    // honest answer to "which one is the total".
    const words = [
      word('1.50', 0.6, 0.2),
      word('1.50', 0.6, 0.3),
      word('1.50', 0.6, 0.4),
      word('£1.50', 0.6, 0.5),
    ];
    expect(deriveFieldBox('totalPence', 150, words)).toBeNull();
  });

  it('handles zero and negative amounts with integer arithmetic', () => {
    expect(deriveFieldBox('taxPence', 0, [word('0.00', 0.6, 0.4)])).not.toBeNull();
    expect(deriveFieldBox('totalPence', -40572, [word('-405.72', 0.6, 0.4)])).not.toBeNull();
  });

  it('refuses a non-integer pence value outright', () => {
    expect(deriveFieldBox('totalPence', 405.72, [word('405.72', 0.6, 0.4)])).toBeNull();
  });
});

describe('date values', () => {
  const iso = '2025-05-12';

  it.each([
    ['12/05/2025'],
    ['12.05.2025'],
    ['12-05-2025'],
    ['2025-05-12'],
  ])('matches the single-token rendering %s', (rendered) => {
    expect(deriveFieldBox('documentDate', iso, [word(rendered, 0.3, 0.2)])).not.toBeNull();
  });

  it('matches unpadded UK d/m/y', () => {
    expect(deriveFieldBox('documentDate', '2026-08-04', [word('4/8/2026', 0.3, 0.2)])).not.toBeNull();
  });

  it('matches written-month forms, day-first and month-first, with ordinals and commas', () => {
    expect(deriveFieldBox('documentDate', iso, [word('12', 0.3, 0.2), word('May', 0.35, 0.2), word('2025', 0.4, 0.2)])).not.toBeNull();
    expect(deriveFieldBox('documentDate', iso, [word('12th', 0.3, 0.2), word('May', 0.35, 0.2), word('2025', 0.4, 0.2)])).not.toBeNull();
    // "May 12, 2025" — the comma rides on the day word.
    expect(deriveFieldBox('documentDate', iso, [word('May', 0.3, 0.2), word('12,', 0.35, 0.2), word('2025', 0.4, 0.2)])).not.toBeNull();
  });

  it('is null when the date is rendered twice in different forms — still two places', () => {
    const words = [word('12/05/2025', 0.3, 0.2), word('12', 0.3, 0.8), word('May', 0.35, 0.8), word('2025', 0.4, 0.8)];
    expect(deriveFieldBox('documentDate', iso, words)).toBeNull();
  });

  it('never matches a two-digit year, and refuses a non-ISO value', () => {
    expect(deriveFieldBox('documentDate', iso, [word('12/05/25', 0.3, 0.2)])).toBeNull();
    expect(deriveFieldBox('documentDate', '12 May 2025', [word('12 May 2025', 0.3, 0.2)])).toBeNull();
  });
});

describe('withFieldGeometry', () => {
  it('fills every field: a box where the value sits in one place, an explicit null everywhere else', () => {
    const fields = {
      docType: aiField('INVOICE', 0.9),
      supplierName: aiField('Nexora Solutions LLC', 0.9),
      documentDate: aiField('2025-05-12', 0.9),
      totalPence: aiField(40572, 0.9),
      taxPence: aiField(null, 0.9),
      reference: aiField('INV-2025-0412', 0.9),
    };

    const placed = withFieldGeometry(fields, INVOICE);

    expect(placed['supplierName']?.boundingBox).not.toBeNull();
    expect(placed['documentDate']?.boundingBox).not.toBeNull();
    expect(placed['totalPence']?.boundingBox).not.toBeNull();
    expect(placed['reference']?.boundingBox).not.toBeNull();
    // A classification is not a transcription — no place to point at, even
    // though the word INVOICE is on the page exactly once.
    expect(placed['docType']?.boundingBox).toBeNull();
    // A null value has no rendering to look for.
    expect(placed['taxPence']?.boundingBox).toBeNull();
    // Everything else about the field is untouched.
    expect(placed['supplierName']?.value).toBe('Nexora Solutions LLC');
    expect(placed['supplierName']?.confidence).toBe(0.9);
  });

  it('is all-null with no OCR words — the path stands without geometry', () => {
    const fields = { supplierName: aiField('Nexora Solutions LLC', 0.9) };
    expect(withFieldGeometry(fields, undefined)['supplierName']?.boundingBox).toBeNull();
    expect(withFieldGeometry(fields, [])['supplierName']?.boundingBox).toBeNull();
  });
});
