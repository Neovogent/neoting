import { describe, expect, test } from 'vitest';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { ChartOfAccountsService } from '../chart-of-accounts/chart-of-accounts.service.js';
import { documentLockFor, SupplierCodingService } from './supplier-coding.service.js';

/**
 * The authority ladder, offline.
 *
 * `decide` takes a `ScopedClient` rather than opening its own transaction —
 * the executor discipline — which is exactly what makes it testable without a
 * database. The proofs that need real RLS and the real `document.update-coding`
 * executor live in `rules-suggestions.integration.test.ts`; these are the ones
 * about precedence, and precedence is pure logic.
 */

interface RuleRow {
  readonly id: string;
  readonly tier: 'USER' | 'PAYMENT_METHOD' | 'SUPPLIER_CUSTOMER' | 'ACCOUNT_DEFAULT';
  readonly scopeKey: string | null;
  readonly sets: unknown;
}

interface DocumentRow {
  readonly id: string;
  readonly supplierName: string | null;
  readonly categoryCode: string | null;
  readonly receivedAt: Date;
  readonly extractions: readonly { readonly extractorKind: string; readonly fields: unknown }[];
}

interface World {
  readonly questionnaire?: unknown;
  readonly rules?: readonly RuleRow[];
  readonly documents?: readonly DocumentRow[];
}

/** The cleaning agency A11's intake stores, in the column's own shape. */
const CLEANING_AGENCY = {
  businessActivity: 'Commercial cleaning for offices and schools',
  typicalSuppliers: ['Nisbets'],
  typicalCosts: ['Cleaning materials'],
  hasEmployees: true,
};

/** A coding a person set through an approved `document.update-coding`. */
function humanCoded(categoryCode: string): DocumentRow['extractions'] {
  return [
    {
      extractorKind: 'human',
      fields: {
        categoryCode: {
          value: categoryCode,
          provenance: 'HUMAN_CONFIRMED',
          confidence: null,
          source: 'proposal:prop_1',
          wasCorrected: true,
        },
      },
    },
  ];
}

/** A coding the pipeline applied from a rule. Not evidence of anything a human decided. */
function machineCoded(categoryCode: string): DocumentRow['extractions'] {
  return [
    {
      extractorKind: 'bedrock',
      fields: { categoryCode: { value: categoryCode, provenance: 'DETERMINISTIC', confidence: 0.9 } },
    },
  ];
}

function doc(over: Partial<DocumentRow> & { id: string }): DocumentRow {
  return {
    supplierName: 'Nisbets Ltd',
    categoryCode: 'COS_MATERIALS_AND_CONSUMABLES',
    receivedAt: new Date('2026-08-01T00:00:00.000Z'),
    extractions: humanCoded('COS_MATERIALS_AND_CONSUMABLES'),
    ...over,
  };
}

/**
 * A `ScopedClient` stand-in with exactly the four reads this path makes.
 *
 * `integration` answers null on purpose, so the chart is derived and never
 * written — the storage behaviour is `chart-of-accounts.service.test.ts`'s job,
 * and a test that also exercised it would be testing two things.
 */
function world(state: World): ScopedClient {
  return {
    business: { findUnique: async () => ({ id: 'biz_1', contextQuestionnaire: state.questionnaire ?? null }) },
    integration: { findFirst: async () => null },
    referenceSync: { findUnique: async () => null },
    rule: { findMany: async () => state.rules ?? [] },
    document: { findMany: async () => state.documents ?? [] },
  } as unknown as ScopedClient;
}

function service(): SupplierCodingService {
  const prisma = undefined as unknown as PrismaClient; // never reached: `decide` takes the db
  return new SupplierCodingService(prisma, new ChartOfAccountsService(prisma));
}

async function decide(state: World, supplierName: string | null = 'Nisbets Ltd') {
  return service().decide(world(state), 'biz_1', supplierName);
}

// ---------------------------------------------------------------------------
// The guarantee A6's brief calls absolute
// ---------------------------------------------------------------------------

describe('an explicit accountant rule beats everything', () => {
  /**
   * ⚠ **This is the test that proves the first half of A6's absolute
   * constraint.** The client has coded Nisbets to consumables by hand, three
   * times; an accountant has since written a rule saying Purchases. The rule
   * wins, and history is not even a competitor.
   */
  test('a USER rule beats a conflicting learned history', async () => {
    const { decision } = await decide({
      questionnaire: CLEANING_AGENCY,
      rules: [{ id: 'rule_user', tier: 'USER', scopeKey: 'Nisbets Ltd', sets: { categoryCode: 'COS_PURCHASES' } }],
      documents: [doc({ id: 'd1' }), doc({ id: 'd2' }), doc({ id: 'd3' })],
    });

    expect(decision.outcome).toBe('CODE');
    if (decision.outcome !== 'CODE') return;
    expect(decision.authority).toBe('ACCOUNTANT_RULE');
    expect(decision.categoryCode).toBe('COS_PURCHASES');
    expect(decision.sourceRuleId).toBe('rule_user');
  });

  test('a USER rule beats a SUPPLIER_CUSTOMER rule — most specific tier first', async () => {
    const { decision } = await decide({
      questionnaire: CLEANING_AGENCY,
      rules: [
        { id: 'rule_supplier', tier: 'SUPPLIER_CUSTOMER', scopeKey: 'Nisbets Ltd', sets: { categoryCode: 'COS_PURCHASES' } },
        { id: 'rule_user', tier: 'USER', scopeKey: 'Nisbets Ltd', sets: { categoryCode: 'UNIFORMS_AND_PPE' } },
      ],
    });

    expect(decision.outcome === 'CODE' && decision.sourceRuleId).toBe('rule_user');
  });

  test('a supplier rule beats a scope-less practice default', async () => {
    const { decision } = await decide({
      questionnaire: CLEANING_AGENCY,
      rules: [
        { id: 'rule_default', tier: 'ACCOUNT_DEFAULT', scopeKey: null, sets: { categoryCode: 'OFFICE_COSTS' } },
        { id: 'rule_supplier', tier: 'SUPPLIER_CUSTOMER', scopeKey: 'Nisbets Ltd', sets: { categoryCode: 'COS_PURCHASES' } },
      ],
    });

    expect(decision.outcome).toBe('CODE');
    if (decision.outcome !== 'CODE') return;
    expect(decision.sourceRuleId).toBe('rule_supplier');
    expect(decision.authority).toBe('ACCOUNTANT_RULE');
  });

  test('a scope-less practice default applies when nothing more specific does', async () => {
    const { decision } = await decide({
      questionnaire: CLEANING_AGENCY,
      rules: [{ id: 'rule_default', tier: 'ACCOUNT_DEFAULT', scopeKey: null, sets: { categoryCode: 'OFFICE_COSTS' } }],
    });

    expect(decision.outcome).toBe('CODE');
    if (decision.outcome !== 'CODE') return;
    expect(decision.authority).toBe('PRACTICE_DEFAULT');
    expect(decision.categoryCode).toBe('OFFICE_COSTS');
  });

  test('a scope-less rule at any other tier applies to nothing — it names no scope to match', async () => {
    const { decision } = await decide({
      questionnaire: CLEANING_AGENCY,
      rules: [{ id: 'rule_odd', tier: 'SUPPLIER_CUSTOMER', scopeKey: null, sets: { categoryCode: 'OFFICE_COSTS' } }],
    });

    expect(decision.outcome).toBe('REVIEW');
  });

  test('a rule that sets no category is not a coding rule', async () => {
    const { decision } = await decide({
      questionnaire: CLEANING_AGENCY,
      rules: [{ id: 'rule_vat', tier: 'USER', scopeKey: 'Nisbets Ltd', sets: { vatTreatment: 'standard' } }],
    });

    expect(decision.outcome).toBe('REVIEW');
  });
});

// ---------------------------------------------------------------------------
// Learned history — the rung that makes the second invoice code itself
// ---------------------------------------------------------------------------

describe('learned history', () => {
  test('one human coding is enough to answer for the next document', async () => {
    const { decision, history } = await decide({
      questionnaire: CLEANING_AGENCY,
      documents: [doc({ id: 'd1' })],
    });

    expect(decision.outcome).toBe('CODE');
    if (decision.outcome !== 'CODE') return;
    expect(decision.authority).toBe('LEARNED_HISTORY');
    expect(decision.categoryCode).toBe('COS_MATERIALS_AND_CONSUMABLES');
    expect(decision.sourceRuleId).toBeNull();
    expect(history.entries).toHaveLength(1);
  });

  test('groups the spellings one supplier arrives under', async () => {
    const { history } = await decide(
      {
        questionnaire: CLEANING_AGENCY,
        documents: [doc({ id: 'd1', supplierName: 'NISBETS LTD' }), doc({ id: 'd2', supplierName: 'Nisbets' })],
      },
      'Nisbets Ltd.',
    );

    expect(history.entries).toHaveLength(2);
    expect(history.spellings).toEqual(['NISBETS LTD', 'Nisbets']);
  });

  /**
   * A category a RULE applied is not evidence of anything a human decided.
   * Feeding a rule's own output back in as history would make one approved
   * decision look like a growing consensus, and §24.4.5's reviewer-correction
   * metric would flatter itself.
   */
  test('a coding the machine applied is not history', async () => {
    const { decision, history } = await decide({
      questionnaire: CLEANING_AGENCY,
      documents: [doc({ id: 'd1', extractions: machineCoded('COS_PURCHASES') })],
    });

    expect(history.entries).toHaveLength(0);
    expect(decision.outcome).toBe('REVIEW');
  });

  /** §24.4.6: *a change of treatment is itself worth surfacing.* Two codes is a question, not a tie. */
  test('a history that disagrees with itself goes to review, naming both codes', async () => {
    const { decision } = await decide({
      questionnaire: CLEANING_AGENCY,
      documents: [
        doc({ id: 'd1', extractions: humanCoded('COS_PURCHASES'), categoryCode: 'COS_PURCHASES' }),
        doc({ id: 'd2' }),
      ],
    });

    expect(decision.outcome).toBe('REVIEW');
    if (decision.outcome !== 'REVIEW') return;
    expect([...decision.conflictingCategoryCodes].sort()).toEqual(['COS_MATERIALS_AND_CONSUMABLES', 'COS_PURCHASES']);
    expect(decision.reason).toContain('more than one account');
  });

  test('another supplier’s history never codes this one', async () => {
    const { decision } = await decide(
      { questionnaire: CLEANING_AGENCY, documents: [doc({ id: 'd1', supplierName: 'Costco' })] },
      'Nisbets Ltd',
    );

    expect(decision.outcome).toBe('REVIEW');
  });
});

// ---------------------------------------------------------------------------
// The exact-match trap
// ---------------------------------------------------------------------------

describe('a rule that will not fire is reported, never silently honoured', () => {
  /**
   * ⚠ `extraction-pipeline.ts` matches `scopeKey` against the extracted
   * `supplierName` by EXACT equality. A rule saying `Nisbets Ltd` does nothing
   * for a document that says `NISBETS LTD`. Matching loosely here would make
   * this service claim a coding the pipeline never applies — a disagreement
   * nobody would see until the export was wrong.
   */
  test('a differently-spelled rule does not code, and is named', async () => {
    const { decision } = await decide(
      {
        questionnaire: CLEANING_AGENCY,
        rules: [{ id: 'rule_1', tier: 'SUPPLIER_CUSTOMER', scopeKey: 'Nisbets Ltd', sets: { categoryCode: 'COS_PURCHASES' } }],
      },
      'NISBETS LTD',
    );

    expect(decision.outcome).toBe('REVIEW');
    expect(decision.nearMissRuleScopeKeys).toEqual(['Nisbets Ltd']);
  });

  test('the same rule with the same spelling does code', async () => {
    const { decision } = await decide(
      {
        questionnaire: CLEANING_AGENCY,
        rules: [{ id: 'rule_1', tier: 'SUPPLIER_CUSTOMER', scopeKey: 'Nisbets Ltd', sets: { categoryCode: 'COS_PURCHASES' } }],
      },
      'Nisbets Ltd',
    );

    expect(decision.outcome).toBe('CODE');
    expect(decision.nearMissRuleScopeKeys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The export handshake, and the new-supplier statement
// ---------------------------------------------------------------------------

describe('what a coding decision hands to A7', () => {
  test('carries the ledger-prefixed Analysis account', async () => {
    const { decision } = await decide({
      questionnaire: CLEANING_AGENCY,
      documents: [doc({ id: 'd1' })],
    });

    expect(decision.outcome === 'CODE' && decision.analysisAccount).toBe('Cost of sales: Materials and consumables');
  });

  /**
   * An accountant's rule outranks the chart, so it may legitimately name a code
   * the chart does not carry. The export genuinely cannot prefix it, and a
   * guessed ledger would put a wrong nominal in someone's books.
   */
  test('an off-chart code says so rather than inventing a ledger', async () => {
    const { decision } = await decide({
      questionnaire: CLEANING_AGENCY,
      rules: [{ id: 'rule_1', tier: 'USER', scopeKey: 'Nisbets Ltd', sets: { categoryCode: 'LEGACY_CODE_FROM_2019' } }],
    });

    expect(decision.outcome).toBe('CODE');
    if (decision.outcome !== 'CODE') return;
    expect(decision.categoryCode).toBe('LEGACY_CODE_FROM_2019');
    expect(decision.analysisAccount).toBeNull();
  });
});

describe('the new-supplier statement (§24.4.1)', () => {
  test('a supplier the client neither named nor sent before is new', async () => {
    const { decision } = await decide({ questionnaire: CLEANING_AGENCY }, 'Brand New Supplies Ltd');
    expect(decision.supplier.isNew).toBe(true);
    expect(decision.reason).toContain('always review');
  });

  test('a supplier they named at intake is not new', async () => {
    const { decision } = await decide({ questionnaire: CLEANING_AGENCY }, 'NISBETS LIMITED');
    expect(decision.supplier.isNew).toBe(false);
  });

  test('a supplier they have sent before is not new', async () => {
    const { decision } = await decide({ questionnaire: CLEANING_AGENCY, documents: [doc({ id: 'd1' })] }, 'Nisbets Ltd');
    expect(decision.supplier.isNew).toBe(false);
  });

  /** It is a statement, never a gate — the authority order is absolute. */
  test('does not stop an explicit rule from coding', async () => {
    const { decision } = await decide(
      {
        questionnaire: CLEANING_AGENCY,
        rules: [{ id: 'r', tier: 'USER', scopeKey: 'Brand New Supplies Ltd', sets: { categoryCode: 'COS_PURCHASES' } }],
      },
      'Brand New Supplies Ltd',
    );

    expect(decision.supplier.isNew).toBe(true);
    expect(decision.outcome).toBe('CODE');
  });
});

// ---------------------------------------------------------------------------
// A client with no profile
// ---------------------------------------------------------------------------

describe('a client whose business-type profile reads null', () => {
  test('still resolves, on the general chart, and says where the chart came from', async () => {
    const { decision, chart } = await decide({
      // The LEGACY shape `prisma/seed.ts` writes — no `businessActivity` at all.
      questionnaire: { sells: 'burgers', revenueStreams: ['dine-in'], companyCards: 2 },
      documents: [doc({ id: 'd1', supplierName: 'Bidfood', categoryCode: 'COS_PURCHASES', extractions: humanCoded('COS_PURCHASES') })],
    }, 'Bidfood');

    expect(chart.basis).toBe('NO_PROFILE');
    expect(decision.outcome).toBe('CODE');
    if (decision.outcome !== 'CODE') return;
    expect(decision.authority).toBe('LEARNED_HISTORY');
    // The general chart carries Purchases, so the export still gets a prefix.
    expect(decision.analysisAccount).toBe('Cost of sales: Purchases');
  });

  test('with nothing to learn from, review says the profile is missing', async () => {
    const { decision } = await decide({ questionnaire: null }, 'Someone New Ltd');
    expect(decision.outcome).toBe('REVIEW');
    expect(decision.supplier.isNew).toBe(true);
  });
});

describe('a document with no supplier read off it', () => {
  test('matches no rule and no history, and says why', async () => {
    const { decision } = await decide({ questionnaire: CLEANING_AGENCY, documents: [doc({ id: 'd1' })] }, null);
    expect(decision.outcome).toBe('REVIEW');
    expect(decision.reason).toContain('No supplier was read');
  });
});

// ---------------------------------------------------------------------------
// The human lock
// ---------------------------------------------------------------------------

describe('documentLockFor — nothing overrides a human’s correction', () => {
  /**
   * ⚠ **The second half of A6's absolute constraint.** The lock is read off the
   * accepted `extractions` row, because `documents.category_code` alone cannot
   * tell a value a person chose from one a rule applied.
   */
  test('a human-confirmed category locks the document', () => {
    expect(documentLockFor({ state: 'TO_REVIEW', extractions: humanCoded('COS_PURCHASES') })).toBe('HUMAN_CORRECTION');
  });

  test('a machine-applied category does not', () => {
    expect(documentLockFor({ state: 'TO_REVIEW', extractions: machineCoded('COS_PURCHASES') })).toBeNull();
  });

  test('a human extraction that did not touch the category does not lock the category', () => {
    const extractions = [
      { extractorKind: 'human', fields: { supplierName: { value: 'Nisbets', provenance: 'HUMAN_CONFIRMED' } } },
    ];
    expect(documentLockFor({ state: 'TO_REVIEW', extractions })).toBeNull();
  });

  test('a released or archived document is locked whatever its extraction says', () => {
    expect(documentLockFor({ state: 'PUBLISHED', extractions: machineCoded('X') })).toBe('RELEASED_OR_ARCHIVED');
    expect(documentLockFor({ state: 'ARCHIVED', extractions: [] })).toBe('RELEASED_OR_ARCHIVED');
  });

  test('malformed extraction JSON is not a lock and is not a crash', () => {
    expect(documentLockFor({ state: 'READY', extractions: [{ extractorKind: 'human', fields: null }] })).toBeNull();
    expect(documentLockFor({ state: 'READY', extractions: [{ extractorKind: 'human', fields: ['nope'] }] })).toBeNull();
    expect(
      documentLockFor({ state: 'READY', extractions: [{ extractorKind: 'human', fields: { categoryCode: 'a string' } }] }),
    ).toBeNull();
    expect(documentLockFor({ state: 'READY', extractions: [] })).toBeNull();
  });
});
