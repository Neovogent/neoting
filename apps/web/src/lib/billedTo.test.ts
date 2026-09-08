import { describe, expect, test } from 'vitest';

import { billedToMismatch, normaliseParty } from './billedTo';
import type { Document, ExtractedField } from './types';

/**
 * The flag that says "this document is for somebody else".
 *
 * ⚠ **The case that earned this file** (8 Sep 2026): a bank statement for
 * MERIDIAN SOFTWARE SOLUTIONS LTD sitting in Neovogent UK LTD's register with
 * nothing saying so. The check itself was right and had been working — what
 * broke it was a RENAME: the statement field table started calling that row
 * "Account holder" instead of "Customer", and this function looked the row up
 * by its label. A pure-function test costs nothing and is the only thing that
 * would have caught it.
 */

const doc = (over: Partial<Pick<Document, 'kind' | 'clientName'>> = {}) =>
  ({ kind: 'cost', clientName: 'Neovogent UK LTD', ...over }) as Pick<Document, 'kind' | 'clientName'>;

const field = (label: string, value: string): ExtractedField =>
  ({ label, value, confidence: 0.95, provenance: 'AI suggested' }) as ExtractedField;

describe('who the document is for', () => {
  test('an invoice addressed to another company is flagged', () => {
    expect(billedToMismatch(doc(), [field('Customer', 'MERIDIAN SOFTWARE SOLUTIONS LTD')])).toBe(
      'MERIDIAN SOFTWARE SOLUTIONS LTD',
    );
  });

  test('a STATEMENT is flagged too — the row is called "Account holder" there', () => {
    // The regression. Before the label set, this returned null and a bank
    // statement for another company looked exactly like one of the client's own.
    expect(billedToMismatch(doc(), [field('Account holder', 'MERIDIAN SOFTWARE SOLUTIONS LTD')])).toBe(
      'MERIDIAN SOFTWARE SOLUTIONS LTD',
    );
  });

  test('the client under its own name, however it is punctuated, is silence', () => {
    expect(billedToMismatch(doc(), [field('Account holder', 'Neovogent UK Ltd.')])).toBeNull();
    expect(billedToMismatch(doc(), [field('Customer', 'NEOVOGENT')])).toBeNull();
  });

  test('nothing to compare is silence, never a guess', () => {
    expect(billedToMismatch(doc(), [])).toBeNull();
    expect(billedToMismatch(doc(), [field('Account holder', '—')])).toBeNull();
    expect(billedToMismatch(doc(), [field('Account holder', '  ')])).toBeNull();
  });

  test('a SALES document is never flagged — the customer is somebody else by definition', () => {
    expect(billedToMismatch(doc({ kind: 'sales' }), [field('Customer', 'Anyone Else Ltd')])).toBeNull();
  });

  test('normaliseParty drops the suffixes that carry no identity', () => {
    expect(normaliseParty('Neovogent UK Ltd.')).toBe(normaliseParty('NEOVOGENT'));
  });
});
