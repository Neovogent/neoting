import { describe, expect, it } from 'vitest';
import type { Extraction as ExtractionRow } from '@prisma/client';

import { toExtraction } from './document-response.js';

/**
 * The one seam where the stored extraction JSON becomes the contract's
 * `Extraction` (METH S7, #137).
 *
 * The write side smuggles `lineItems` inside the `fields` jsonb (METH S4's
 * no-schema-change rule), while the contract types `fields` as a strict map of
 * `ExtractedField` and gives line items their own optional array. The generated
 * client enforces that strictly, so a projection that passed the jsonb through
 * unchanged failed every extracted document in the browser — this suite pins
 * the separation.
 */

const row = (fields: unknown): ExtractionRow =>
  ({
    id: 'ext-1',
    documentId: 'doc-1',
    fields,
    extractorKind: 'demo-extractor',
    ladderRung: null,
    modelVersion: 'demo-extractor-1',
    promptVersion: null,
    overallConfidence: 0.94,
    validatorResults: null,
    isAccepted: true,
    keyedByUserId: null,
    createdAt: new Date('2026-08-19T09:00:00Z'),
  }) as ExtractionRow;

const supplier = { value: 'Currys', provenance: 'AI_SUGGESTED', confidence: 0.94, source: 'demo-extractor-1' };
const item = {
  description: { value: 'Commercial chest freezer', provenance: 'AI_SUGGESTED', confidence: 0.94, source: 'demo-extractor-1' },
  quantity: { value: 1, provenance: 'AI_SUGGESTED', confidence: 0.94, source: 'demo-extractor-1' },
  totalPence: { value: 99_900, provenance: 'AI_SUGGESTED', confidence: 0.94, source: 'demo-extractor-1' },
  taxPence: { value: 16_650, provenance: 'AI_SUGGESTED', confidence: 0.94, source: 'demo-extractor-1' },
};

describe('toExtraction and the smuggled lineItems key', () => {
  it('separates lineItems out of fields into the contracted array', () => {
    const extraction = toExtraction(row({ supplierName: supplier, lineItems: [item] }));

    expect(extraction.fields).toEqual({ supplierName: supplier });
    expect(extraction.lineItems).toEqual([item]);
  });

  it('never leaves a non-ExtractedField value under fields.lineItems', () => {
    const extraction = toExtraction(row({ supplierName: supplier, lineItems: [item] }));

    expect(Object.keys(extraction.fields)).not.toContain('lineItems');
  });

  it('omits lineItems — not null, not [] — when the stored JSON has none', () => {
    const extraction = toExtraction(row({ supplierName: supplier }));

    expect(extraction.fields).toEqual({ supplierName: supplier });
    expect('lineItems' in extraction).toBe(false);
  });

  it('strips a malformed non-array lineItems value rather than serving it', () => {
    const extraction = toExtraction(row({ supplierName: supplier, lineItems: 'not-an-array' }));

    expect(extraction.fields).toEqual({ supplierName: supplier });
    expect('lineItems' in extraction).toBe(false);
  });

  it('still refuses a fields column that is not an object at all', () => {
    const extraction = toExtraction(row(['an', 'array']));

    expect(extraction.fields).toEqual({});
    expect('lineItems' in extraction).toBe(false);
  });
});
