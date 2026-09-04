import { describe, expect, test } from 'vitest';

import { chartOfAccountsFor, toCategories } from '../chart-of-accounts/chart-of-accounts.js';
import {
  type AiCodingSuggestion,
  type CodingEvidence,
  documentReconciles,
  NO_CODING_EVIDENCE,
  suggestCoding,
  type SuggestionChart,
} from './ai-suggestion.js';
import { type CapitalisationPolicy, type CodingLine, PLATFORM_DEFAULT_CAPITALISATION_POLICY } from './capital-revenue.js';
import { CODING_ESCALATION_REASONS } from './escalation.js';

/**
 * **The rung, at document level — including the invoice that started it.**
 *
 * Nexora Solutions LLC, a US supplier, USD, one document carrying five
 * different treatments. It came back from the pipeline with no category at all
 * and no explanation. Every assertion below is a thing an accountant would have
 * had to work out unaided.
 */

const general = chartOfAccountsFor(null);
const CHART: SuggestionChart = { accounts: general.accounts, categories: toCategories(general) };

function evidence(over: Partial<CodingEvidence> = {}): CodingEvidence {
  return { ...NO_CODING_EVIDENCE, supplier: { name: 'Nexora Solutions LLC', key: 'nexora solutions', isNew: true }, currency: 'USD', ...over };
}

/** The five lines as they appear on the real invoice. Subtotal $52,550.00. */
const NEXORA_LINES: readonly CodingLine[] = [
  { description: 'Microsoft 365 E3 annual subscription — 150 user seats', quantity: 150, netPence: 2_250_000, taxPence: null },
  { description: 'Dell PowerEdge R760 rack server', quantity: 2, netPence: 1_230_000, taxPence: null },
  { description: 'Veeam Backup & Replication Enterprise — 10 socket licences', quantity: 10, netPence: 875_000, taxPence: null },
  { description: 'Professional services — setup & configuration', quantity: 1, netPence: 640_000, taxPence: null },
  { description: 'Onsite administrator training, 2 days', quantity: 1, netPence: 260_000, taxPence: null },
];

const SUBTOTAL_PENCE = 5_255_000;
/** 8.875% of the subtotal, which is what the invoice says the rate is. */
const STATED_TAX_PENCE = 466_381;
/** What the invoice actually claims as its total — an implied 3.43%. */
const STATED_TOTAL_PENCE = 5_435_251;

describe('the arithmetic is checked BEFORE anything is categorised', () => {
  test('the real invoice does not reconcile, and that is a hard stop', () => {
    const suggestion = suggestCoding(evidence({ lines: NEXORA_LINES, totalPence: STATED_TOTAL_PENCE, taxPence: STATED_TAX_PENCE }), CHART);

    expect(suggestion.outcome).toBe('ESCALATE');
    if (suggestion.outcome !== 'ESCALATE') return;
    expect(suggestion.reason).toBe('ARITHMETIC_MISMATCH');
    // And nothing was categorised on top of a number that is not the number.
    expect(suggestion.candidateCategoryCodes).toEqual([]);
  });

  test('the same lines with a total that adds up get past the check', () => {
    const total = SUBTOTAL_PENCE + STATED_TAX_PENCE;
    expect(documentReconciles(evidence({ lines: NEXORA_LINES, totalPence: total, taxPence: STATED_TAX_PENCE }))).toBe(true);
  });

  test('gross line totals reconcile too — the check does not invent a mismatch out of not knowing net from gross', () => {
    const lines: CodingLine[] = [{ description: 'Widgets', quantity: 1, netPence: 12_000, taxPence: 2_000 }];
    expect(documentReconciles(evidence({ lines, totalPence: 12_000, taxPence: 2_000 }))).toBe(true);
    expect(documentReconciles(evidence({ lines, totalPence: 14_000, taxPence: 2_000 }))).toBe(true);
    expect(documentReconciles(evidence({ lines, totalPence: 99_000, taxPence: 2_000 }))).toBe(false);
  });

  test('a document with nothing to check is not failed for it', () => {
    expect(documentReconciles(evidence({ lines: [], totalPence: 999 }))).toBe(true);
    expect(documentReconciles(evidence({ lines: NEXORA_LINES, totalPence: null }))).toBe(true);
  });
});

describe('the real invoice, once its arithmetic is fixed', () => {
  const reconciled = evidence({ lines: NEXORA_LINES, totalPence: SUBTOTAL_PENCE + STATED_TAX_PENCE, taxPence: STATED_TAX_PENCE });

  test('it escalates on the most severe thing found, and names it', () => {
    const suggestion = suggestCoding(reconciled, CHART);

    expect(suggestion.outcome).toBe('ESCALATE');
    if (suggestion.outcome !== 'ESCALATE') return;
    // The Veeam line outranks the professional-services line: the term of a
    // licence is the question that has to be answered first.
    expect(suggestion.reason).toBe('SOFTWARE_TERM_UNKNOWN');
  });

  test('it shows the work it DID do rather than an empty field', () => {
    const suggestion = suggestCoding(reconciled, CHART);
    if (suggestion.outcome !== 'ESCALATE') throw new Error('expected an escalation');

    expect([...suggestion.candidateCategoryCodes].sort()).toEqual(['FA_COMPUTER_EQUIPMENT', 'SOFTWARE_AND_SUBSCRIPTIONS', 'TRAINING']);
    expect(suggestion.note).not.toBe('');
  });

  test('a US-dollar invoice says its tax is part of the cost, and what that does to a reverse charge', () => {
    const suggestion = suggestCoding(reconciled, CHART);
    expect(suggestion.advisories).toContain('FOREIGN_TAX_IN_COST');
    expect(suggestion.advisories).toContain('REVERSE_CHARGE_INCREASES_BASE');
  });

  test('a first-time supplier is stated as one', () => {
    expect(suggestCoding(reconciled, CHART).advisories).toContain('NEW_SUPPLIER');
  });

  test('once the licence term is stated, the split it still needs is named', () => {
    const stated = NEXORA_LINES.map((line) =>
      line.description.startsWith('Veeam') ? { ...line, description: 'Veeam Backup & Replication Enterprise — annual subscription, 10 sockets' } : line,
    );
    const suggestion = suggestCoding({ ...reconciled, lines: stated }, CHART);

    expect(suggestion.outcome === 'ESCALATE' && suggestion.reason).toBe('MIXED_CAPITAL_AND_REVENUE');
  });
});

describe('a document that CAN be coded is coded, with its working', () => {
  const oneLine = evidence({
    supplier: { name: 'Cloudsmith Ltd', key: 'cloudsmith', isNew: false },
    currency: 'GBP',
    lines: [{ description: 'Microsoft 365 Business Premium — annual subscription', quantity: 12, netPence: 264_000, taxPence: null }],
    totalPence: 264_000,
    taxPence: 0,
  });

  test('it suggests, with a confidence, a named basis and the emittable account', () => {
    const suggestion = suggestCoding(oneLine, CHART);

    expect(suggestion.outcome).toBe('SUGGEST');
    if (suggestion.outcome !== 'SUGGEST') return;
    expect(suggestion.categoryCode).toBe('SOFTWARE_AND_SUBSCRIPTIONS');
    expect(suggestion.analysisAccount).toBe('Expenses: Software and subscriptions');
    expect(suggestion.basis).toBe('SUBSCRIPTION_TERM_UNDER_TWO_YEARS');
    expect(suggestion.confidence).toBeGreaterThan(0);
    expect(suggestion.confidence).toBeLessThanOrEqual(1);
  });

  test('it is a SUGGESTION and says so in its provenance — never a deterministic coding', () => {
    const suggestion = suggestCoding(oneLine, CHART);
    expect(suggestion.provenance).toBe('AI_SUGGESTED');
    expect(suggestion.authority).toBe('AI_INFERENCE');
  });

  test('it offers a second choice, because published top-2 accuracy runs about ten points above top-1', () => {
    const suggestion = suggestCoding(oneLine, CHART);
    if (suggestion.outcome !== 'SUGGEST') throw new Error('expected a suggestion');
    expect(suggestion.secondChoice?.categoryCode).toBe('HOSTING_AND_INFRASTRUCTURE');
    expect(suggestion.secondChoice?.analysisAccount).toBe('Expenses: Hosting and infrastructure');
  });

  test('a new supplier is shown as less certain than a known one, on the same document', () => {
    const known = suggestCoding(oneLine, CHART);
    const unknown = suggestCoding({ ...oneLine, supplier: { ...oneLine.supplier, isNew: true } }, CHART);
    if (known.outcome !== 'SUGGEST' || unknown.outcome !== 'SUGGEST') throw new Error('expected suggestions');

    expect(unknown.confidence).toBeLessThan(known.confidence);
    expect(unknown.categoryCode).toBe(known.categoryCode);
  });
});

describe('the schema’s own limit, reported rather than papered over', () => {
  test('two accounts of the same kind on one document is named, not resolved by size', () => {
    const suggestion = suggestCoding(
      evidence({
        currency: 'GBP',
        lines: [
          { description: 'Cloud hosting — dedicated compute', quantity: 1, netPence: 900_000, taxPence: null },
          { description: 'Onsite administrator training, 1 day', quantity: 1, netPence: 60_000, taxPence: null },
        ],
        totalPence: 960_000,
        taxPence: 0,
      }),
      CHART,
    );

    expect(suggestion.outcome).toBe('ESCALATE');
    if (suggestion.outcome !== 'ESCALATE') return;
    expect(suggestion.reason).toBe('MULTIPLE_CATEGORIES_ON_ONE_DOCUMENT');
    // ⚠ The £9,000 line did NOT win because it was bigger. Both are reported.
    expect([...suggestion.candidateCategoryCodes].sort()).toEqual(['HOSTING_AND_INFRASTRUCTURE', 'TRAINING']);
  });

  test('capital and revenue together is a different, worse escalation than two overheads', () => {
    const suggestion = suggestCoding(
      evidence({
        currency: 'GBP',
        lines: [
          { description: 'Dell PowerEdge R760 rack server', quantity: 1, netPence: 615_000, taxPence: null },
          { description: 'Onsite administrator training, 1 day', quantity: 1, netPence: 60_000, taxPence: null },
        ],
        totalPence: 675_000,
        taxPence: 0,
      }),
      CHART,
    );
    expect(suggestion.outcome === 'ESCALATE' && suggestion.reason).toBe('MIXED_CAPITAL_AND_REVENUE');
  });
});

describe('no path returns a bare null', () => {
  const CORPUS: CodingEvidence[] = [
    NO_CODING_EVIDENCE,
    evidence({ lines: [] }),
    evidence({ lines: NEXORA_LINES, totalPence: STATED_TOTAL_PENCE, taxPence: STATED_TAX_PENCE }),
    evidence({ lines: NEXORA_LINES, totalPence: SUBTOTAL_PENCE + STATED_TAX_PENCE, taxPence: STATED_TAX_PENCE }),
    evidence({ lines: [{ description: '', quantity: null, netPence: null, taxPence: null }] }),
    evidence({ lines: [{ description: '???', quantity: null, netPence: null, taxPence: null }] }),
    evidence({ lines: [{ description: 'Sales tax @ 8.875%', quantity: 1, netPence: 466_381, taxPence: null }], totalPence: 466_381 }),
    evidence({ supplier: { name: null, key: '', isNew: false }, lines: [] }),
    evidence({ supplier: { name: 'Adobe', key: 'adobe', isNew: false }, lines: [] }),
    evidence({ lines: [{ description: 'Network switch', quantity: 1, netPence: null, taxPence: null }] }),
    evidence({ lines: [{ description: 'Perpetual licence — CAD suite', quantity: 1, netPence: 100_000, taxPence: null }] }),
  ];

  const POLICIES: CapitalisationPolicy[] = [
    PLATFORM_DEFAULT_CAPITALISATION_POLICY,
    { thresholdPence: 1, currency: 'USD', boundaryBandPercent: 0, source: 'PRACTICE' },
    { thresholdPence: 50_000_000, currency: 'GBP', boundaryBandPercent: 50, source: 'PRACTICE' },
  ];

  const CHARTS: SuggestionChart[] = [CHART, { accounts: [], categories: [] }, { accounts: CHART.accounts.slice(0, 3), categories: CHART.categories.slice(0, 3) }];

  test('every combination answers a code or a NAMED reason — never nothing', () => {
    for (const chart of CHARTS) {
      for (const policy of POLICIES) {
        for (const input of CORPUS) {
          assertAnswered(suggestCoding(input, chart, policy));
        }
      }
    }
  });

  test('an empty chart says so by name rather than failing silently', () => {
    const suggestion = suggestCoding(evidence({ lines: NEXORA_LINES }), { accounts: [], categories: [] });
    expect(suggestion.outcome === 'ESCALATE' && suggestion.reason).toBe('NO_CHART_OF_ACCOUNTS');
  });

  test('a first-time supplier with nothing readable lands on the terminal reason, not on an empty field', () => {
    const suggestion = suggestCoding(evidence({ supplier: { name: 'Zzyzx Holdings', key: 'zzyzx', isNew: true }, lines: [] }), CHART);
    expect(suggestion.outcome === 'ESCALATE' && suggestion.reason).toBe('NEW_SUPPLIER_NO_HISTORY');
  });
});

/** A suggestion is answered when it carries either a real code or a reason from the closed set. */
function assertAnswered(suggestion: AiCodingSuggestion): void {
  expect(suggestion.note.length).toBeGreaterThan(0);
  expect(suggestion.provenance).toBe('AI_SUGGESTED');

  if (suggestion.outcome === 'SUGGEST') {
    expect(suggestion.categoryCode).toBeTruthy();
    expect(typeof suggestion.confidence).toBe('number');
    expect(suggestion.confidence).toBeGreaterThan(0);
    return;
  }
  expect(CODING_ESCALATION_REASONS).toContain(suggestion.reason);
  expect(suggestion.confidence).toBeNull();
}
