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

/**
 * The coding suggestion rides in the SAME jsonb under its own reserved key,
 * and is separated here for the same reason `lineItems` is: the contract types
 * `fields` as a strict map of `ExtractedField`, so anything else left under
 * that key fails every `GET /documents/{id}` in the browser the moment a
 * document has been read. That is #137 exactly, one key over.
 */
describe('toExtraction and the smuggled codingSuggestion key', () => {
  const suggestion = {
    outcome: 'SUGGEST',
    provenance: 'AI_SUGGESTED',
    basis: 'SUBSCRIPTION_TERM_UNDER_TWO_YEARS',
    note: 'Suggested — not applied — as Software subscriptions, on an annual term stated on the document.',
    categoryCode: 'SOFTWARE_SUBSCRIPTIONS',
    analysisAccount: 'Overheads: Software subscriptions',
    confidence: 0.8,
    treatment: 'REVENUE',
    secondChoice: null,
    escalationReason: null,
    candidateCategoryCodes: [],
    advisories: [],
  };

  it('serves it on the contracted property and STRIPS it from fields', () => {
    const extraction = toExtraction(row({ supplierName: supplier, codingSuggestion: suggestion }));
    expect(extraction.codingSuggestion?.categoryCode).toBe('SOFTWARE_SUBSCRIPTIONS');
    expect(extraction.codingSuggestion?.note).toBe(suggestion.note);
    // The bug class: a non-ExtractedField value left under `fields`.
    expect(Object.keys(extraction.fields)).not.toContain('codingSuggestion');
    expect(Object.keys(extraction.fields)).toEqual(['supplierName']);
  });

  it('omits it — not null — when the ladder was never consulted', () => {
    const extraction = toExtraction(row({ supplierName: supplier }));
    expect('codingSuggestion' in extraction).toBe(false);
  });

  it('degrades a malformed payload to “no suggestion”, never to a half-rendered opinion', () => {
    // `fields` is a Json column, so what comes back is whatever was written —
    // by this release, an older one, or a hand edit. A payload that does not
    // parse is dropped and the Category row falls back to what it showed
    // before; it must never 500 the document detail.
    for (const bad of [{ outcome: 'MAYBE' }, { outcome: 'SUGGEST' }, 'not-an-object', 42, null]) {
      const extraction = toExtraction(row({ supplierName: supplier, codingSuggestion: bad }));
      expect('codingSuggestion' in extraction).toBe(false);
      expect(Object.keys(extraction.fields)).not.toContain('codingSuggestion');
    }
  });

  it('carries an ESCALATE with its reason and no coding', () => {
    const escalation = {
      ...suggestion,
      outcome: 'ESCALATE',
      categoryCode: null,
      analysisAccount: null,
      confidence: null,
      treatment: null,
      escalationReason: 'SOFTWARE_TERM_UNKNOWN',
      candidateCategoryCodes: ['SOFTWARE_SUBSCRIPTIONS', 'IT_EQUIPMENT'],
      note: 'The licence term is not stated on this document, so it cannot be settled as capital or revenue.',
    };
    const extraction = toExtraction(row({ supplierName: supplier, codingSuggestion: escalation }));
    expect(extraction.codingSuggestion?.outcome).toBe('ESCALATE');
    expect(extraction.codingSuggestion?.escalationReason).toBe('SOFTWARE_TERM_UNKNOWN');
    expect(extraction.codingSuggestion?.categoryCode).toBeNull();
  });
});
