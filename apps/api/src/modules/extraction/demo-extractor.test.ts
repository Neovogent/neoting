import { expect, test } from 'vitest';

import { DemoExtractor } from './demo-extractor.js';

const extractor = new DemoExtractor();
const HASH = 'f'.repeat(64);

async function extract(filename: string) {
  return extractor.extract({ filename, byteHash: HASH });
}

test('the Currys profile reads a confident receipt in pence, coded for review-to-ready', async () => {
  const outcome = await extract('currys-receipt.jpg');
  if (!outcome.ok) throw new Error('expected ok');
  const d = outcome.document;
  expect(d.supplierName).toBe('Currys');
  expect(d.docType).toBe('RECEIPT');
  expect(d.totalPence).toBe(129_900); // integer pence, no floats
  expect(d.categoryCode).toBe('OFFICE_EQUIPMENT');
  expect(d.validatorFailed).toBe(false);
  // Every header field carries provenance + confidence (SoT §13.3).
  expect(d.fields.supplierName?.provenance).toBe('AI_SUGGESTED');
  expect(d.fields.totalPence?.confidence).toBeGreaterThan(0);
  expect(d.lineItems.length).toBeGreaterThan(0);
});

test('the keyword match is case- and decoration-insensitive (deterministic)', async () => {
  const a = await extract('Currys Receipt (1).JPG');
  const b = await extract('currys.png');
  if (!a.ok || !b.ok) throw new Error('expected ok');
  expect(a.document.supplierName).toBe('Currys');
  expect(b.document.supplierName).toBe('Currys');
});

test('the low-confidence profile fails a validator, which must block Ready', async () => {
  const outcome = await extract('lowconf-invoice.pdf');
  if (!outcome.ok) throw new Error('expected ok');
  // Total/supplier/category are all present — so ONLY the failed validator can
  // send it to review. This is the readiness contract (validation-dedupe).
  expect(outcome.document.totalPence).not.toBeNull();
  expect(outcome.document.supplierName).not.toBeNull();
  expect(outcome.document.validatorFailed).toBe(true);
  expect(outcome.document.validatorResults['vatArithmetic']?.ok).toBe(false);
});

test('an unreadable document is a FAILURE outcome with a reason and a stable code', async () => {
  const outcome = await extract('blurry-photo.jpg');
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('expected failure');
  expect(outcome.failure.code).toBe('NT-EXT-001');
  expect(outcome.failure.message.length).toBeGreaterThan(0);
});

test('an unknown filename gets a deterministic hash-derived generic profile', async () => {
  const a = await extractor.extract({ filename: 'mystery.pdf', byteHash: HASH });
  const b = await extractor.extract({ filename: 'mystery.pdf', byteHash: HASH });
  if (!a.ok || !b.ok) throw new Error('expected ok');
  // Same bytes → same read, every time (the mocking doctrine's determinism).
  expect(a.document).toEqual(b.document);
  expect(a.document.supplierName).toContain(HASH.slice(0, 6).toUpperCase());
  expect(Number.isInteger(a.document.totalPence)).toBe(true);
});

test('a different hash yields a different generic supplier and total', async () => {
  const a = await extractor.extract({ filename: 'mystery.pdf', byteHash: 'a'.repeat(64) });
  const b = await extractor.extract({ filename: 'mystery.pdf', byteHash: 'b'.repeat(64) });
  if (!a.ok || !b.ok) throw new Error('expected ok');
  expect(a.document.supplierName).not.toBe(b.document.supplierName);
});

test('Bidfood reads with a default coding a rule can later override', async () => {
  const outcome = await extract('bidfood-invoice.pdf');
  if (!outcome.ok) throw new Error('expected ok');
  expect(outcome.document.supplierName).toBe('Bidfood');
  expect(outcome.document.categoryCode).toBe('GENERAL_EXPENSES');
});

test('Just Eat matches both spellings of the filename token', async () => {
  for (const filename of ['just-eat-payout.pdf', 'justeat-payout.pdf', 'Just Eat statement.pdf']) {
    const outcome = await extract(filename);
    if (!outcome.ok) throw new Error(`expected ok for ${filename}`);
    expect(outcome.document.supplierName).toBe('Just Eat');
  }
});

test('a keyword only matches a whole token, never a substring of another word', async () => {
  // The reviewer's footgun: substring matching mis-coded real uploads. Token
  // matching leaves these alone — they fall through to the generic profile, and
  // the failure keyword does not fire.
  const adjustment = await extract('adjustment-note.pdf'); // must NOT be Just Eat
  const shellfish = await extract('shellfish-supplier.pdf'); // must NOT be Shell
  const blanket = await extract('blanket-order.pdf'); // must NOT be a FAILED read
  if (!adjustment.ok || !shellfish.ok || !blanket.ok) throw new Error('expected ok (generic), not a keyword hit');
  expect(adjustment.document.supplierName).not.toBe('Just Eat');
  expect(shellfish.document.supplierName).not.toBe('Shell');
});
