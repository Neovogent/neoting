import { expect, test } from 'vitest';

import {
  CHASE_MATCH_AMOUNT_TOLERANCE_PENCE,
  CHASE_MATCH_DATE_WINDOW_DAYS,
  type ChaseCandidateDocument,
  chaseMatchesDocument,
  type ChaseTargetTransaction,
  normaliseSupplier,
} from './auto-close.js';

/**
 * The pure compare at the heart of auto-close (SoT §4 Stage 8.5). Deterministic:
 * a document matches a chased transaction on supplier + amount (+ a date window),
 * and nothing else. The DB-and-RLS side is proven in
 * `validation-dedupe/proposals/chase-auto-close.integration.test.ts`.
 */

// The Currys chase target from the demo cast — signed pence, negative is money out.
const CURRYS_TXN: ChaseTargetTransaction = {
  amountPence: -129_900,
  bookedAt: new Date('2026-08-09T12:00:00.000Z'),
  merchantName: 'Currys',
  descriptionRaw: 'CURRYS 1234 LONDON',
};

const currysDoc = (over: Partial<ChaseCandidateDocument> = {}): ChaseCandidateDocument => ({
  supplierName: 'Currys',
  totalPence: 129_900,
  documentDate: new Date('2026-08-09T00:00:00.000Z'),
  ...over,
});

test('normaliseSupplier lower-cases, drops punctuation and collapses whitespace', () => {
  expect(normaliseSupplier('CURRYS 1234  LONDON')).toBe('currys 1234 london');
  expect(normaliseSupplier('Currys/PC World')).toBe('currys pc world');
  expect(normaliseSupplier('   ')).toBe('');
});

test('an exact supplier + amount + in-window date matches', () => {
  expect(chaseMatchesDocument(currysDoc(), CURRYS_TXN)).toBe(true);
});

test('the noisy bank descriptor still matches the clean extracted supplier', () => {
  // The document supplier is `Currys`; the transaction has no merchantName, so the
  // compare falls back to the raw descriptor `CURRYS 1234 LONDON` and still matches.
  const txn: ChaseTargetTransaction = { ...CURRYS_TXN, merchantName: null };
  expect(chaseMatchesDocument(currysDoc(), txn)).toBe(true);
});

test('the sign of the transaction amount does not matter — the compare is on absolute pence', () => {
  const inbound: ChaseTargetTransaction = { ...CURRYS_TXN, amountPence: 129_900 };
  expect(chaseMatchesDocument(currysDoc(), inbound)).toBe(true);
});

test('an amount within tolerance matches; just outside it does not', () => {
  expect(chaseMatchesDocument(currysDoc({ totalPence: 129_900 + CHASE_MATCH_AMOUNT_TOLERANCE_PENCE }), CURRYS_TXN)).toBe(
    true,
  );
  expect(
    chaseMatchesDocument(currysDoc({ totalPence: 129_900 + CHASE_MATCH_AMOUNT_TOLERANCE_PENCE + 1 }), CURRYS_TXN),
  ).toBe(false);
});

test('a wrong supplier is rejected even when the amount and date agree exactly', () => {
  expect(chaseMatchesDocument(currysDoc({ supplierName: 'Google' }), CURRYS_TXN)).toBe(false);
});

test('a supplier that is only a leading SUBSTRING of the descriptor does NOT match — whole token, never substring', () => {
  // The bug this guards: `Sap` must not close a `SAPPHIRE RESTAURANTS` chase, and
  // `Al` must not close `Aldi` — a substring compare would silently close the
  // wrong supplier's chase (same business, amount within £1, date skipped/near).
  const sapphire: ChaseTargetTransaction = {
    amountPence: -129_900,
    bookedAt: new Date('2026-08-09T12:00:00.000Z'),
    merchantName: null,
    descriptionRaw: 'SAPPHIRE RESTAURANTS LTD',
  };
  expect(chaseMatchesDocument(currysDoc({ supplierName: 'Sap', documentDate: null }), sapphire)).toBe(false);

  const aldi: ChaseTargetTransaction = { ...sapphire, descriptionRaw: 'ALDI STORES 88' };
  expect(chaseMatchesDocument(currysDoc({ supplierName: 'Al', documentDate: null }), aldi)).toBe(false);
  // But the real Aldi supplier (whole token) still matches its own descriptor.
  expect(chaseMatchesDocument(currysDoc({ supplierName: 'Aldi', documentDate: null }), aldi)).toBe(true);
});

test('a date outside the window is rejected; a date at the window edge is accepted', () => {
  const edge = new Date('2026-08-09T12:00:00.000Z');
  edge.setUTCDate(edge.getUTCDate() + CHASE_MATCH_DATE_WINDOW_DAYS);
  const past = new Date('2026-08-09T12:00:00.000Z');
  past.setUTCDate(past.getUTCDate() + CHASE_MATCH_DATE_WINDOW_DAYS + 1);
  expect(chaseMatchesDocument(currysDoc({ documentDate: edge }), CURRYS_TXN)).toBe(true);
  expect(chaseMatchesDocument(currysDoc({ documentDate: past }), CURRYS_TXN)).toBe(false);
});

test('an unread document date skips the date gate — supplier + amount still identify the transaction', () => {
  expect(chaseMatchesDocument(currysDoc({ documentDate: null }), CURRYS_TXN)).toBe(true);
});

test('a document missing a supplier or a total can never match — no closing on an amount coincidence', () => {
  expect(chaseMatchesDocument(currysDoc({ supplierName: null }), CURRYS_TXN)).toBe(false);
  expect(chaseMatchesDocument(currysDoc({ totalPence: null }), CURRYS_TXN)).toBe(false);
});
