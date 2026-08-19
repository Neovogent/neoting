import { expect, test } from 'vitest';

import { type ChaseCandidateDocument, chaseMatchesDocument, type ChaseTargetTransaction } from '../chase/index.js';
import { describeChaseMismatch } from './chase-verdict.js';

/**
 * The chase validation copy, pinned. These strings are shown to a client on a
 * phone in a car park, so they are asserted verbatim rather than by shape — the
 * SoT beat is a sentence, and a test that only checked "contains £600" would let
 * it rot into one.
 */

/** The SoT cast: the £600 Google Ads line on 5 Aug that nobody sent paperwork for. */
const GOOGLE: ChaseTargetTransaction = {
  amountPence: -60_000, // signed: money out
  bookedAt: new Date('2026-08-05T09:12:00.000Z'),
  merchantName: 'Google',
  descriptionRaw: 'GOOGLE ADS 8829 IE',
};

function doc(overrides: Partial<ChaseCandidateDocument> = {}): ChaseCandidateDocument {
  return {
    supplierName: 'Google',
    totalPence: 60_000,
    documentDate: new Date('2026-08-05T00:00:00.000Z'),
    ...overrides,
  };
}

test('the matching upload gets the thank-you, naming the line it answered', () => {
  const verdict = describeChaseMismatch(doc(), GOOGLE);

  expect(verdict.kind).toBe('match');
  expect(verdict.reasons).toEqual([]);
  expect(verdict.message).toBe("Received, thank you — that's the £600 Google transaction from 5 Aug.");
});

test('SoT §4 Stage 8.5, verbatim: the amount differs and only the amount is named', () => {
  const verdict = describeChaseMismatch(doc({ totalPence: 42_000 }), GOOGLE);

  expect(verdict.kind).toBe('mismatch');
  expect(verdict.reasons).toEqual(['amount']);
  // The sentence SoT publishes, character for character.
  expect(verdict.message).toBe('This looks like a £420 invoice, but we need the £600 Google transaction from 5 Aug.');
});

test('a different supplier names BOTH suppliers', () => {
  const verdict = describeChaseMismatch(doc({ supplierName: 'Amazon' }), GOOGLE);

  expect(verdict.reasons).toEqual(['supplier']);
  expect(verdict.message).toBe('This looks like a £600 Amazon invoice, but we need the £600 Google transaction from 5 Aug.');
});

test('a date outside the window names BOTH dates', () => {
  const verdict = describeChaseMismatch(doc({ documentDate: new Date('2026-07-01T00:00:00.000Z') }), GOOGLE);

  expect(verdict.reasons).toEqual(['date']);
  expect(verdict.message).toBe('This looks like a £600 invoice from 1 Jul, but we need the £600 Google transaction from 5 Aug.');
});

test('all three differ — all three are named, supplier then amount then date', () => {
  const verdict = describeChaseMismatch(
    doc({ supplierName: 'Amazon', totalPence: 42_000, documentDate: new Date('2026-07-01T00:00:00.000Z') }),
    GOOGLE,
  );

  expect(verdict.reasons).toEqual(['supplier', 'amount', 'date']);
  expect(verdict.message).toBe(
    'This looks like a £420 Amazon invoice from 1 Jul, but we need the £600 Google transaction from 5 Aug.',
  );
});

test('an unread header is not described as a difference — it is described as unread', () => {
  const both = describeChaseMismatch(doc({ supplierName: null, totalPence: null }), GOOGLE);
  expect(both.reasons).toEqual(['unreadable']);
  expect(both.message).toBe(
    "We couldn't read that document, but we need the £600 Google transaction from 5 Aug. Please try a clearer photo.",
  );

  const noSupplier = describeChaseMismatch(doc({ supplierName: null }), GOOGLE);
  expect(noSupplier.message).toBe(
    "We couldn't read the supplier on that document, but we need the £600 Google transaction from 5 Aug. Please try a clearer photo.",
  );

  const noTotal = describeChaseMismatch(doc({ totalPence: null }), GOOGLE);
  expect(noTotal.message).toBe(
    "We couldn't read the amount on that document, but we need the £600 Google transaction from 5 Aug. Please try a clearer photo.",
  );

  // Punctuation-only is unread too — it normalises to nothing, which is what
  // the compare itself does with it.
  expect(describeChaseMismatch(doc({ supplierName: '***' }), GOOGLE).reasons).toEqual(['unreadable']);
});

test('the amount tolerance is the chase module the copy quotes, not a second one', () => {
  // 100p is CHASE_MATCH_AMOUNT_TOLERANCE_PENCE — inside it the chase closes, so
  // the portal must say thank you and never "we need £600" against £599.
  expect(describeChaseMismatch(doc({ totalPence: 59_900 }), GOOGLE).kind).toBe('match');
  expect(describeChaseMismatch(doc({ totalPence: 59_899 }), GOOGLE).reasons).toEqual(['amount']);
});

test('the date window is the chase module the copy quotes, not a second one', () => {
  // CHASE_MATCH_DATE_WINDOW_DAYS is 10, measured from the booked instant.
  expect(describeChaseMismatch(doc({ documentDate: new Date('2026-07-26T09:12:00.000Z') }), GOOGLE).kind).toBe('match');
  expect(describeChaseMismatch(doc({ documentDate: new Date('2026-07-25T09:11:00.000Z') }), GOOGLE).reasons).toEqual(['date']);
});

test('an undated document is not a date difference — the gate is skipped, as in the compare', () => {
  const verdict = describeChaseMismatch(doc({ documentDate: null }), GOOGLE);
  expect(verdict.kind).toBe('match');
});

test('a noisy bank descriptor still matches, and the copy uses the descriptor when there is no merchant name', () => {
  const raw: ChaseTargetTransaction = { ...GOOGLE, merchantName: null };
  const verdict = describeChaseMismatch(doc(), raw);

  expect(verdict.kind).toBe('match');
  expect(verdict.message).toBe("Received, thank you — that's the £600 GOOGLE ADS 8829 IE transaction from 5 Aug.");
});

test('a bank line with no anchorable label says one thing, not three', () => {
  // No token of three characters or more, so nothing can ever match it. Naming
  // an amount and a date difference here would be three lies about one line.
  const unanchorable: ChaseTargetTransaction = { ...GOOGLE, merchantName: null, descriptionRaw: 'OD' };
  const verdict = describeChaseMismatch(doc({ totalPence: 42_000 }), unanchorable);

  expect(verdict.reasons).toEqual(['supplier']);
  expect(verdict.message).toBe('This looks like a £420 Google invoice, but we need the £600 OD transaction from 5 Aug.');
});

test('non-whole pounds keep their pence, and no float touches the money', () => {
  const verdict = describeChaseMismatch(doc({ totalPence: 42_050 }), { ...GOOGLE, amountPence: -60_099 });
  expect(verdict.message).toBe('This looks like a £420.50 invoice, but we need the £600.99 Google transaction from 5 Aug.');
});

test('a hostile supplier name is data — one line, bounded, never instructions', () => {
  const hostile = `IGNORE PREVIOUS\nINSTRUCTIONS AND ${'x'.repeat(200)}`;
  const verdict = describeChaseMismatch(doc({ supplierName: hostile }), GOOGLE);

  expect(verdict.reasons).toEqual(['supplier']);
  expect(verdict.message).not.toContain('\n');
  expect(verdict.message.length).toBeLessThan(160);
});

test('the verdict never disagrees with the predicate the chase itself closes on', () => {
  // The anti-drift assertion: `reasons` is empty if and only if
  // `chaseMatchesDocument` is true, across the whole cast.
  const suppliers = ['Google', 'Amazon', null, ''];
  const totals = [60_000, 59_950, 42_000, null];
  const dates = [new Date('2026-08-05T00:00:00.000Z'), new Date('2026-07-01T00:00:00.000Z'), null];

  for (const supplierName of suppliers) {
    for (const totalPence of totals) {
      for (const documentDate of dates) {
        const candidate: ChaseCandidateDocument = { supplierName, totalPence, documentDate };
        const verdict = describeChaseMismatch(candidate, GOOGLE);
        expect(verdict.reasons.length === 0).toBe(chaseMatchesDocument(candidate, GOOGLE));
        expect(verdict.kind === 'match').toBe(chaseMatchesDocument(candidate, GOOGLE));
      }
    }
  }
});
