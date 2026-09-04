import { describe, expect, it } from 'vitest';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { StoredCodingSuggestionSchema } from '../../common/documents/coding-suggestion.js';
import type { AiCodingSuggestion, CodingEvidence, SupplierCodingResult } from '../rules-suggestions/index.js';
import { adviseCoding, type DocumentCodingAdvisor, toStoredCodingSuggestion } from './coding-advice.js';
import type { ExtractedDocument } from './document-extractor.js';

/**
 * **The seam between the pipeline and the coding ladder.**
 *
 * The ladder shipped fully tested with nobody calling it, and the accountant
 * still saw a blank Category with no explanation. These are the assertions
 * about the call itself: when it happens, when it deliberately does not, and
 * that what it stores is the shape the read projection will hand back.
 *
 * No database — the advisor is an interface the step is given, which is the
 * whole reason it is one.
 */

/** A `decide()` that answers with whatever the test hands it, and records the call. */
function advisorReturning(decision: SupplierCodingResult['decision']): DocumentCodingAdvisor & {
  calls: Array<{ businessId: string; supplierName: string | null; evidence: Omit<CodingEvidence, 'supplier'> | undefined }>;
} {
  const calls: Array<{ businessId: string; supplierName: string | null; evidence: Omit<CodingEvidence, 'supplier'> | undefined }> = [];
  return {
    calls,
    decide: async (_db, businessId, supplierName, evidence) => {
      calls.push({ businessId, supplierName, evidence });
      return { businessId, decision } as unknown as SupplierCodingResult;
    },
  };
}

const DB = {} as ScopedClient;

const extracted = (over: Partial<ExtractedDocument> = {}): ExtractedDocument =>
  ({
    supplierName: 'Nexora Solutions LLC',
    currency: 'USD',
    totalPence: 5_435_251,
    taxPence: 185_251,
    lineItems: [],
    fields: {},
    ...over,
  }) as unknown as ExtractedDocument;

const SUGGEST: Extract<AiCodingSuggestion, { outcome: 'SUGGEST' }> = {
  outcome: 'SUGGEST',
  authority: 'AI_INFERENCE',
  provenance: 'AI_SUGGESTED',
  basis: 'SUBSCRIPTION_TERM_UNDER_TWO_YEARS',
  advisories: [],
  note: 'Suggested — not applied — as Software subscriptions, on an annual term stated on the document.',
  categoryCode: 'SOFTWARE_SUBSCRIPTIONS',
  analysisAccount: 'Overheads: Software subscriptions',
  confidence: 0.8,
  treatment: 'REVENUE',
  secondChoice: { categoryCode: 'IT_EQUIPMENT', analysisAccount: null, confidence: 0.55 },
};

const ESCALATE: Extract<AiCodingSuggestion, { outcome: 'ESCALATE' }> = {
  outcome: 'ESCALATE',
  authority: 'AI_INFERENCE',
  provenance: 'AI_SUGGESTED',
  basis: 'NOTHING_MATCHED',
  advisories: [],
  note: 'The licence term is not stated on this document, so it cannot be settled as capital or revenue.',
  reason: 'SOFTWARE_TERM_UNKNOWN',
  candidateCategoryCodes: ['SOFTWARE_SUBSCRIPTIONS', 'IT_EQUIPMENT'],
  confidence: null,
};

const review = (suggestion: AiCodingSuggestion) =>
  ({ outcome: 'REVIEW', suggestion, conflictingCategoryCodes: [] }) as unknown as SupplierCodingResult['decision'];

describe('adviseCoding — when the ladder is consulted at all', () => {
  it('asks about an uncoded, routed document and stores what came back', async () => {
    const advisor = advisorReturning(review(SUGGEST));
    const stored = await adviseCoding(advisor, DB, 'biz_1', null, extracted());

    expect(advisor.calls).toHaveLength(1);
    expect(advisor.calls[0]?.businessId).toBe('biz_1');
    expect(advisor.calls[0]?.supplierName).toBe('Nexora Solutions LLC');
    expect(stored?.outcome).toBe('SUGGEST');
    expect(stored?.categoryCode).toBe('SOFTWARE_SUBSCRIPTIONS');
  });

  it('⚠ is NOT consulted about a document something already coded', async () => {
    // A suggestion beside an accountant's rule is not extra information, it is
    // pressure to second-guess an explicit instruction.
    const advisor = advisorReturning(review(SUGGEST));
    expect(await adviseCoding(advisor, DB, 'biz_1', 'OFFICE_EQUIPMENT', extracted())).toBeNull();
    expect(advisor.calls).toHaveLength(0);
  });

  it('is not consulted about an unrouted document — no client, so no chart, rules or history', async () => {
    const advisor = advisorReturning(review(SUGGEST));
    expect(await adviseCoding(advisor, DB, null, null, extracted())).toBeNull();
    expect(advisor.calls).toHaveLength(0);
  });

  it('stores nothing for a decision that was not a REVIEW', async () => {
    // `LOCKED` and `CODE` structurally carry no suggestion — the type system,
    // not a runtime check, is what stops a model opinion riding beside a rule.
    const coded = { outcome: 'CODE', categoryCode: 'OFFICE_EQUIPMENT' } as unknown as SupplierCodingResult['decision'];
    expect(await adviseCoding(advisorReturning(coded), DB, 'biz_1', null, extracted())).toBeNull();
  });

  it('passes the document’s own evidence, with the lines read through the ladder’s parser', async () => {
    // The pipeline holds the lines in memory rather than in `extractions.fields`,
    // so a first read and every later `resolveForDocument` must agree about what
    // the document's lines say.
    const advisor = advisorReturning(review(ESCALATE));
    await adviseCoding(
      advisor,
      DB,
      'biz_1',
      null,
      extracted({ lineItems: [{ description: { value: 'Annual subscription' }, totalPence: { value: 1_200 } }] } as never),
    );
    const evidence = advisor.calls[0]?.evidence;
    expect(evidence?.currency).toBe('USD');
    expect(evidence?.totalPence).toBe(5_435_251);
    expect(Array.isArray(evidence?.lines)).toBe(true);
  });
});

describe('toStoredCodingSuggestion — the shape the read projection will hand back', () => {
  it('writes every property, nullable rather than omitted, for a SUGGEST', () => {
    const stored = toStoredCodingSuggestion(SUGGEST);
    // An absent key and an explicit null are different things: a suggestion that
    // omitted `escalationReason` would be indistinguishable from one written by
    // a release that did not have the concept.
    expect(Object.keys(stored).sort()).toEqual(
      [
        'advisories',
        'analysisAccount',
        'basis',
        'candidateCategoryCodes',
        'categoryCode',
        'confidence',
        'escalationReason',
        'note',
        'outcome',
        'provenance',
        'secondChoice',
        'treatment',
      ].sort(),
    );
    expect(stored.escalationReason).toBeNull();
    expect(stored.secondChoice).toEqual({ categoryCode: 'IT_EQUIPMENT', analysisAccount: null, confidence: 0.55 });
  });

  it('carries the reason and the candidates for an ESCALATE, and no coding at all', () => {
    const stored = toStoredCodingSuggestion(ESCALATE);
    expect(stored.outcome).toBe('ESCALATE');
    expect(stored.escalationReason).toBe('SOFTWARE_TERM_UNKNOWN');
    expect(stored.candidateCategoryCodes).toEqual(['SOFTWARE_SUBSCRIPTIONS', 'IT_EQUIPMENT']);
    // There is no coding to be confident about.
    expect(stored.categoryCode).toBeNull();
    expect(stored.confidence).toBeNull();
    expect(stored.treatment).toBeNull();
  });

  it('is always AI_SUGGESTED — a suggestion that claimed to be deterministic would be a coding', () => {
    expect(toStoredCodingSuggestion(SUGGEST).provenance).toBe('AI_SUGGESTED');
    expect(toStoredCodingSuggestion(ESCALATE).provenance).toBe('AI_SUGGESTED');
  });

  it('survives its own schema — a value that would not read back never reaches the column', () => {
    expect(StoredCodingSuggestionSchema.safeParse(toStoredCodingSuggestion(SUGGEST)).success).toBe(true);
    expect(StoredCodingSuggestionSchema.safeParse(toStoredCodingSuggestion(ESCALATE)).success).toBe(true);
  });
});
