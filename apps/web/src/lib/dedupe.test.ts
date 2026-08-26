import { describe, expect, it } from 'vitest';
import { createIntl } from 'react-intl';

import { DEFAULT_DEDUPE_SETTINGS, detectDuplicates } from './dedupe';
import { DEFAULT_LOCALE } from '../i18n';
import { seedDocuments, seedDuplicateCopies } from './seed';
import type { Document } from './types';

/**
 * Duplicate detection scores evidence rather than demanding a field match, and
 * the two things that buys are the whole point: a pair survives one copy
 * having failed to extract a field, and an invoice can match its
 * receipt-formatted twin. Both are asserted here against the seed data, which
 * contains exactly those two cases.
 *
 * The signals are message descriptors formatted by the caller (#65), so the
 * detector takes an `intl`. `locale` and `defaultLocale` are both the source
 * locale, which is how react-intl resolves each message to its own
 * `defaultMessage` without reporting a missing translation — the strings
 * asserted below are the ones a user reads in en-GB.
 */

const intl = createIntl({ locale: DEFAULT_LOCALE, defaultLocale: DEFAULT_LOCALE });

const doc = (over: Partial<Document> = {}): Document => ({
  id: 'x1',
  clientId: '1',
  clientName: 'American Burger Ltd',
  supplier: 'Bidfood UK',
  date: '10 Aug 2026',
  total: 1420.5,
  category: 'Cost of Sales Food',
  status: 'review',
  source: 'email',
  uploader: 'accounts@americanburger.co.uk',
  currency: 'GBP',
  kind: 'cost',
  fields: [],
  lineItems: [],
  ...over,
});

const everything = [...seedDocuments, ...seedDuplicateCopies];

describe('detectDuplicates — the seeded pairs', () => {
  const pairs = detectDuplicates(intl, everything);

  it('finds both known copies and nothing else', () => {
    expect(pairs.map((p) => p.id)).toEqual(['dup-d1-d1b', 'dup-d3-d3b']);
  });

  it('matches an emailed invoice to its photographed receipt twin', () => {
    const pair = pairs.find((p) => p.id === 'dup-d1-d1b');

    expect(pair?.crossType).toBe(true);
    expect(pair?.left.type).not.toBe(pair?.right.type);
    expect(pair?.signals).toContain('Different uploaders');
  });

  it('matches a copy four days later, which a same-date rule would miss', () => {
    const pair = pairs.find((p) => p.id === 'dup-d3-d3b');

    expect(pair?.left.date).not.toBe(pair?.right.date);
    expect(pair?.signals).toContain('Dates 4 days apart');
  });

  it('puts the strongest evidence first — that is the order to work through', () => {
    const scores = pairs.map((p) => p.similarity);

    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores.every((s) => s >= DEFAULT_DEDUPE_SETTINGS.threshold && s <= 1)).toBe(true);
  });

  it('says what the evidence was, rather than only a number', () => {
    for (const pair of pairs) {
      expect(pair.signals).toContain('Identical total');
      expect(pair.signals).toContain('Same supplier');
      expect(pair.signals.length).toBeGreaterThan(2);
    }
  });

  it('changes nothing — detection is a flag, not a deletion', () => {
    const before = everything.map((d) => d.id);
    detectDuplicates(intl, everything);

    expect(everything.map((d) => d.id)).toEqual(before);
  });
});

describe('detectDuplicates — what it refuses to pair', () => {
  it('never pairs the same invoice sent to two different companies', () => {
    const pairs = detectDuplicates(intl, [doc({ id: 'a' }), doc({ id: 'b', clientId: '2', clientName: 'Ananda' })]);

    expect(pairs).toEqual([]);
  });

  it('never pairs money in with money out', () => {
    const pairs = detectDuplicates(intl, [doc({ id: 'a', kind: 'cost' }), doc({ id: 'b', kind: 'sales' })]);

    expect(pairs).toEqual([]);
  });

  it('leaves a document still being read alone — there is nothing to compare on yet', () => {
    const pairs = detectDuplicates(intl, [doc({ id: 'a' }), doc({ id: 'b', status: 'processing' })]);

    expect(pairs).toEqual([]);
  });

  it('will not pair two different spends that merely share a supplier and a date', () => {
    const pairs = detectDuplicates(intl, [doc({ id: 'a', total: 1420.5 }), doc({ id: 'b', total: 380 })]);

    expect(pairs).toEqual([]);
  });
});

describe('detectDuplicates — the settings that govern it', () => {
  it('honours a tighter threshold, and reports the pair it does keep', () => {
    const strict = detectDuplicates(intl, everything, { ...DEFAULT_DEDUPE_SETTINGS, threshold: 0.8 });

    expect(strict.map((p) => p.id)).toEqual(['dup-d1-d1b']);
  });

  it('scores a copy lower once the date tolerance no longer covers the gap', () => {
    const loose = detectDuplicates(intl, everything, { ...DEFAULT_DEDUPE_SETTINGS, dateToleranceDays: 5 });
    const tight = detectDuplicates(intl, everything, { ...DEFAULT_DEDUPE_SETTINGS, dateToleranceDays: 1 });

    const before = loose.find((p) => p.id === 'dup-d3-d3b')?.similarity ?? 0;
    const after = tight.find((p) => p.id === 'dup-d3-d3b')?.similarity ?? 0;

    expect(before).toBeGreaterThan(after);
  });

  it('tolerates a same-day copy whatever the tolerance is set to', () => {
    const pairs = detectDuplicates(intl, everything, { ...DEFAULT_DEDUPE_SETTINGS, dateToleranceDays: 0 });

    expect(pairs.map((p) => p.id)).toContain('dup-d1-d1b');
  });

  it('finds a copy whose extraction failed, which a field-match rule would miss', () => {
    // The right-hand copy carries no extracted fields at all — no reference,
    // no supplier line — and is still recognised on the other evidence.
    const pairs = detectDuplicates(intl, [
      doc({
        id: 'full',
        fields: [{ label: 'Invoice number', value: 'BF-2026-88412', confidence: 0.94, provenance: 'header' }],
      }),
      doc({ id: 'blank', uploader: '+44 7700 900123', source: 'whatsapp', fields: [] }),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.signals).toContain('Identical total');
  });
});
