import { expect, test } from 'vitest';

import {
  bedrockExtractionResult,
  BEDROCK_EXTRACTOR_KIND,
  checkVatArithmetic,
  toExtractedDocument,
} from './bedrock-extraction-schema.js';

/** The real Bidfood answer, measured against eu.anthropic.claude-opus-5. */
const ANSWER = {
  docType: 'INVOICE',
  supplierName: 'Bidfood UK Ltd',
  documentDate: '2026-08-14',
  currency: 'GBP',
  totalPence: 40_572,
  taxPence: 6_762,
  netPence: 33_810,
  reference: 'BF-2026-44817',
  vatNumber: 'GB 412 5566 78',
  confidence: { supplier: 0.98, date: 0.97, total: 0.98, tax: 0.98 },
} as const;

test('parses the shape the model actually returned', () => {
  const parsed = bedrockExtractionResult.safeParse(ANSWER);
  expect(parsed.success).toBe(true);
});

test('money stays integer pence — a decimal is refused, never rounded', () => {
  // Rounding here would put a silently-wrong number in a ledger. The repo
  // invariant is integer pence, and this is the boundary that enforces it.
  // R5 is exactly what this test proves. The float is the INPUT: a model
  // returning pounds where the schema said pence must be refused, not rounded.
  // eslint-disable-next-line no-restricted-syntax -- deliberate, see above
  const parsed = bedrockExtractionResult.safeParse({ ...ANSWER, totalPence: 405.72 });
  expect(parsed.success ? parsed.data.totalPence : 'refused').toBe(null);
});

test('a non-ISO date is dropped rather than guessed at', () => {
  const parsed = bedrockExtractionResult.parse({ ...ANSWER, documentDate: '14/08/2026' });
  // Null sends the document to a human, which beats a date parsed the American
  // way — the exact failure UK d/m/y disambiguation exists to prevent.
  expect(parsed.documentDate).toBeNull();
});

test('the field map carries provenance and this extractor as the source', () => {
  const doc = toExtractedDocument(bedrockExtractionResult.parse(ANSWER));
  expect(doc.fields.supplierName?.provenance).toBe('AI_SUGGESTED');
  expect(doc.fields.supplierName?.source).toBe(BEDROCK_EXTRACTOR_KIND);
  expect(doc.fields.totalPence?.value).toBe(40_572);
  expect(doc.fields.totalPence?.confidence).toBe(0.98);
});

test('overall confidence is the WEAKEST field, not the average', () => {
  const doc = toExtractedDocument(
    bedrockExtractionResult.parse({ ...ANSWER, confidence: { ...ANSWER.confidence, tax: 0.4 } }),
  );
  // An average lets three confident fields hide one bad one — the field that
  // needs a human is the one that should set the document's confidence.
  expect(doc.overallConfidence).toBe(0.4);
});

test('coding is left to the rules engine — never invented by the model', () => {
  const doc = toExtractedDocument(bedrockExtractionResult.parse(ANSWER));
  expect(doc.categoryCode).toBeNull();
  expect(doc.suggestions).toEqual([]);
});

test('VAT arithmetic that reconciles passes', () => {
  expect(checkVatArithmetic(bedrockExtractionResult.parse(ANSWER)).ok).toBe(true);
});

test('VAT arithmetic that does not reconcile FAILS and blocks Ready', () => {
  const doc = toExtractedDocument(bedrockExtractionResult.parse({ ...ANSWER, taxPence: 9_999 }));
  expect(doc.validatorFailed).toBe(true);
  expect(doc.validatorResults.vatArithmetic?.detail).toMatch(/out by/);
});

test('a 1p rounding difference is tolerated', () => {
  expect(checkVatArithmetic(bedrockExtractionResult.parse({ ...ANSWER, totalPence: 40_573 })).ok).toBe(true);
});

test('missing parts skip the check rather than failing it', () => {
  // Absence is already handled by a null header field sending the document to
  // To Review; reporting an arithmetic error for absent arithmetic is noise.
  const parsed = bedrockExtractionResult.parse({ ...ANSWER, netPence: null });
  expect(checkVatArithmetic(parsed).ok).toBe(true);
});

test('an unreadable field survives as null instead of failing the whole parse', () => {
  const parsed = bedrockExtractionResult.parse({ ...ANSWER, supplierName: null, totalPence: null });
  const doc = toExtractedDocument(parsed);
  // Null header fields are how a document lands in To Review — the honest
  // outcome for a smudged receipt, and far better than refusing the read.
  expect(doc.supplierName).toBeNull();
  expect(doc.totalPence).toBeNull();
});
