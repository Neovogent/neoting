import { describe, expect, test } from 'vitest';

import type { ClientChartOfAccounts } from '../chart-of-accounts/chart-of-accounts.service.js';
import type { AiCodingSuggestion } from './ai-suggestion.js';
import type { CodingDecision } from './coding-decision.js';
import { buildSupplierRuleProposal, buildSupplierRulePayload } from './rule-proposal.js';
import type { SupplierCodingResult, SupplierHistory } from './supplier-coding.service.js';

/**
 * The proposal builder is pure, so this is where the "second invoice codes
 * itself" contract is pinned — including the one detail that breaks it
 * silently.
 */

const CHART: ClientChartOfAccounts = {
  businessId: 'biz_1',
  source: 'STORED',
  profileId: 'SERVICES_WITH_STAFF',
  basis: 'PROFILE_MATCHED',
  accounts: [],
  unmatchedCosts: [],
  knownSuppliers: ['nisbets'],
  caveat: 'seeded',
  categories: [{ code: 'COS_MATERIALS_AND_CONSUMABLES', name: 'Cost of sales: Materials and consumables' }],
};

const SUPPLIER = { name: 'Nisbets Ltd', key: 'nisbets', isNew: false };

/**
 * A `REVIEW` now always carries the `AI_INFERENCE` rung's answer — never null,
 * by construction (`ai-suggestion.ts`). It changes nothing here: a suggestion
 * is not a human's confirmed coding, so it is not something a standing rule may
 * be learned from, and `buildSupplierRuleProposal` still refuses.
 */
const NO_SUGGESTION: AiCodingSuggestion = {
  outcome: 'ESCALATE',
  authority: 'AI_INFERENCE',
  provenance: 'AI_SUGGESTED',
  basis: 'NOTHING_MATCHED',
  reason: 'NO_MATCH_ON_CHART',
  candidateCategoryCodes: [],
  confidence: null,
  advisories: [],
  note: 'nothing matched',
};

function history(over: Partial<SupplierHistory> = {}): SupplierHistory {
  return {
    entries: [
      {
        documentId: 'doc_1',
        supplierName: 'Nisbets Ltd',
        categoryCode: 'COS_MATERIALS_AND_CONSUMABLES',
        receivedAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    ],
    categoryCodes: ['COS_MATERIALS_AND_CONSUMABLES'],
    spellings: ['Nisbets Ltd'],
    ...over,
  };
}

function result(decision: CodingDecision, over: Partial<SupplierCodingResult> = {}): SupplierCodingResult {
  return { businessId: 'biz_1', chart: CHART, history: history(), decision, ...over };
}

const LEARNED: CodingDecision = {
  outcome: 'CODE',
  authority: 'LEARNED_HISTORY',
  categoryCode: 'COS_MATERIALS_AND_CONSUMABLES',
  analysisAccount: 'Cost of sales: Materials and consumables',
  sourceRuleId: null,
  supplier: SUPPLIER,
  nearMissRuleScopeKeys: [],
  reason: 'coded by hand once',
};

describe('the proposal that makes the second invoice code itself', () => {
  test('is a rule.create payload, not a rule', () => {
    const proposal = buildSupplierRuleProposal(result(LEARNED));
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.kind).toBe('rule.create');
    expect(proposal.businessId).toBe('biz_1');
    expect(proposal.payload.tier).toBe('SUPPLIER_CUSTOMER');
    expect(proposal.payload.sets).toEqual({ categoryCode: 'COS_MATERIALS_AND_CONSUMABLES' });
  });

  /**
   * ⚠ **The trap.** `extraction-pipeline.ts` matches `scopeKey` against the
   * extracted `supplierName` by exact string equality. A normalised or
   * title-cased key produces a rule that is written, renders correctly on the
   * review card, is approved by a human — and then never fires, with nothing
   * reporting it.
   */
  test('the scope key is the supplier’s exact spelling from a real document', () => {
    const proposal = buildSupplierRuleProposal(
      result(LEARNED, { history: history({ spellings: ['NISBETS LTD'], categoryCodes: ['COS_MATERIALS_AND_CONSUMABLES'] }) }),
    );
    expect(proposal.ok && proposal.payload.scopeKey).toBe('NISBETS LTD');
    // NOT the normalised key, and NOT a title-cased guess.
    expect(proposal.ok && proposal.payload.scopeKey).not.toBe('nisbets');
    expect(proposal.ok && proposal.payload.scopeKey).not.toBe('Nisbets Ltd');
  });

  test('other spellings this rule will not match are named rather than hidden', () => {
    const proposal = buildSupplierRuleProposal(
      result(LEARNED, { history: history({ spellings: ['NISBETS LTD', 'Nisbets', 'nisbets ltd.'] }) }),
    );
    expect(proposal.ok && proposal.unmatchedSpellings).toEqual(['Nisbets', 'nisbets ltd.']);
  });

  test('carries the ledger-prefixed account and a sentence a human can approve on', () => {
    const proposal = buildSupplierRuleProposal(result(LEARNED));
    expect(proposal.ok && proposal.analysisAccount).toBe('Cost of sales: Materials and consumables');
    expect(proposal.ok && proposal.rationale).toContain('Cost of sales: Materials and consumables');
    expect(proposal.ok && proposal.rationale).toContain('by hand');
  });

  test('an off-chart code is proposed with the gap stated, not substituted', () => {
    const proposal = buildSupplierRuleProposal(
      result(
        { ...LEARNED, categoryCode: 'LEGACY_CODE', analysisAccount: null },
        { history: history({ categoryCodes: ['LEGACY_CODE'] }) },
      ),
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.payload.sets.categoryCode).toBe('LEGACY_CODE');
    expect(proposal.analysisAccount).toBeNull();
    expect(proposal.rationale).toContain('not on this client');
  });

  test('conditions is omitted, never nulled — ID evaluates none of them', () => {
    expect(Object.keys(buildSupplierRulePayload('Nisbets Ltd', 'X'))).toEqual(['tier', 'scopeKey', 'sets']);
  });
});

describe('when there is nothing to propose, it says so instead', () => {
  test('a rule already codes this supplier — a second at the same tier would silently win', () => {
    const proposal = buildSupplierRuleProposal(
      result({ ...LEARNED, authority: 'ACCOUNTANT_RULE', sourceRuleId: 'rule_1' }),
    );
    expect(proposal.ok).toBe(false);
    expect(!proposal.ok && proposal.reason).toContain('already codes this supplier');
  });

  test('a practice default is a rule too', () => {
    const proposal = buildSupplierRuleProposal(result({ ...LEARNED, authority: 'PRACTICE_DEFAULT' }));
    expect(proposal.ok).toBe(false);
  });

  /**
   * ⚠ **Nothing overrides a human's correction, and that includes turning it
   * into a standing rule behind their back.** A correction is a decision about
   * one document; a rule is a decision about every future one.
   */
  test('a human-locked document yields no rule', () => {
    const proposal = buildSupplierRuleProposal(
      result({
        outcome: 'LOCKED',
        lock: 'HUMAN_CORRECTION',
        categoryCode: 'COS_PURCHASES',
        supplier: SUPPLIER,
        nearMissRuleScopeKeys: [],
        reason: 'locked',
      }),
    );
    expect(proposal.ok).toBe(false);
    expect(!proposal.ok && proposal.reason).toContain('separate thing to ask them');
  });

  test('a released or archived document yields no rule', () => {
    const proposal = buildSupplierRuleProposal(
      result({
        outcome: 'LOCKED',
        lock: 'RELEASED_OR_ARCHIVED',
        categoryCode: 'COS_PURCHASES',
        supplier: SUPPLIER,
        nearMissRuleScopeKeys: [],
        reason: 'locked',
      }),
    );
    expect(proposal.ok).toBe(false);
  });

  test('a review outcome passes its own reason through, so the accountant reads one sentence not two', () => {
    const proposal = buildSupplierRuleProposal(
      result({
        outcome: 'REVIEW',
        conflictingCategoryCodes: ['A', 'B'],
        supplier: SUPPLIER,
        nearMissRuleScopeKeys: [],
        suggestion: NO_SUGGESTION,
        reason: 'This client has coded Nisbets Ltd to more than one account before.',
      }),
    );
    expect(proposal.ok).toBe(false);
    expect(!proposal.ok && proposal.reason).toBe('This client has coded Nisbets Ltd to more than one account before.');
  });

  test('no document names the supplier, so there is no exact key a rule could use', () => {
    const proposal = buildSupplierRuleProposal(result(LEARNED, { history: history({ spellings: [] }) }));
    expect(proposal.ok).toBe(false);
    expect(!proposal.ok && proposal.reason).toContain('never fire');
  });
});
