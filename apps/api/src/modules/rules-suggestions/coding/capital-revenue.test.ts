import { describe, expect, test } from 'vitest';

import { chartOfAccountsFor } from '../chart-of-accounts/chart-of-accounts.js';
import {
  type CapitalisationPolicy,
  capitalisesAsHardware,
  classifyLine,
  type CodingLine,
  type LineContext,
  PLATFORM_DEFAULT_CAPITALISATION_POLICY,
  thresholdVerdictFor,
} from './capital-revenue.js';

/**
 * **The decision rules, pinned one by one.**
 *
 * Every case here is one the research named as expensive and the product was
 * getting wrong — or, worse, answering with nothing at all.
 */

const CHART = chartOfAccountsFor(null);
const ALL_CODES = new Set(CHART.accounts.map((account) => account.code));

function context(over: Partial<LineContext> = {}): LineContext {
  return {
    chartCodes: ALL_CODES,
    accounts: CHART.accounts,
    policy: PLATFORM_DEFAULT_CAPITALISATION_POLICY,
    currency: 'GBP',
    hasCapitalHardware: false,
    ...over,
  };
}

function line(description: string, over: Partial<CodingLine> = {}): CodingLine {
  return { description, quantity: null, netPence: null, taxPence: null, ...over };
}

describe('rule 3 — a subscription is revenue whatever it costs', () => {
  // The invoice that started this carries £22,500 of annual Microsoft 365. A
  // number that size is exactly where a magnitude heuristic would capitalise it.
  test.each([
    ['a £5 monthly seat', 500],
    ['an ordinary annual bill', 120_000],
    ['the £22,500 annual bill from the real invoice', 2_250_000],
    ['an absurd one', 100_000_000],
  ])('%s codes to software and subscriptions, as revenue', (_label, netPence) => {
    const verdict = classifyLine(line('Microsoft 365 E3 annual subscription — 150 user seats', { quantity: 150, netPence }), context());

    expect(verdict.outcome).toBe('CODE');
    if (verdict.outcome !== 'CODE') return;
    expect(verdict.categoryCode).toBe('SOFTWARE_AND_SUBSCRIPTIONS');
    expect(verdict.treatment).toBe('REVENUE');
    expect(verdict.basis).toBe('SUBSCRIPTION_TERM_UNDER_TWO_YEARS');
  });

  test('an annual fee says so, because the unexpired part is a prepayment rather than a different category', () => {
    const verdict = classifyLine(line('Annual subscription — collaboration platform', { netPence: 2_250_000 }), context());
    expect(verdict.advisories).toContain('ANNUAL_FEE_MAY_BE_PART_PREPAID');
  });

  test('a monthly one does not claim a prepayment it has no reason to', () => {
    const verdict = classifyLine(line('Monthly per-user licence', { netPence: 12_000 }), context());
    expect(verdict.advisories).not.toContain('ANNUAL_FEE_MAY_BE_PART_PREPAID');
  });
});

describe('rule 4 — the term decides a licence, and the vendor never does', () => {
  test('a perpetual licence above the threshold is capital', () => {
    const verdict = classifyLine(line('Perpetual licence — design suite', { quantity: 1, netPence: 480_000 }), context());
    expect(verdict.outcome === 'CODE' && verdict.categoryCode).toBe('FA_SOFTWARE_LICENCES');
    expect(verdict.outcome === 'CODE' && verdict.treatment).toBe('CAPITAL');
  });

  /**
   * The single most important refusal in this file. "Veeam Backup & Replication
   * Enterprise" is capital when it is perpetual and revenue when it is annual,
   * and nothing about the vendor distinguishes them.
   */
  test('a software line with no stated term ESCALATES rather than guessing from the vendor', () => {
    const verdict = classifyLine(line('Veeam Backup & Replication Enterprise — 10 socket licences', { quantity: 10, netPence: 875_000 }), context());

    expect(verdict.outcome).toBe('ESCALATE');
    if (verdict.outcome !== 'ESCALATE') return;
    expect(verdict.reason).toBe('SOFTWARE_TERM_UNKNOWN');
    expect(verdict.basis).toBe('SOFTWARE_TERM_NOT_STATED');
  });

  test('the same line with the term stated is decided, both ways', () => {
    const annual = classifyLine(line('Veeam Backup & Replication Enterprise — annual subscription, 10 sockets', { quantity: 1, netPence: 875_000 }), context());
    const perpetual = classifyLine(line('Veeam Backup & Replication Enterprise — perpetual licence, 10 sockets', { quantity: 1, netPence: 875_000 }), context());

    expect(annual.outcome === 'CODE' && annual.categoryCode).toBe('SOFTWARE_AND_SUBSCRIPTIONS');
    expect(annual.outcome === 'CODE' && annual.treatment).toBe('REVENUE');
    expect(perpetual.outcome === 'CODE' && perpetual.categoryCode).toBe('FA_SOFTWARE_LICENCES');
    expect(perpetual.outcome === 'CODE' && perpetual.treatment).toBe('CAPITAL');
  });

  /**
   * The practice's policy applies to a perpetual licence as it does to
   * hardware: a £30 one-off licence is not a fixed asset because it is
   * perpetual. The term decides WHICH question is asked; the policy answers it.
   */
  test('a perpetual licence below the practice’s threshold is still expensed', () => {
    const verdict = classifyLine(line('Perpetual licence — utility tool', { quantity: 1, netPence: 3_000 }), context());
    expect(verdict.outcome === 'CODE' && verdict.categoryCode).toBe('SOFTWARE_AND_SUBSCRIPTIONS');
    expect(verdict.outcome === 'CODE' && verdict.basis).toBe('PERPETUAL_LICENCE_BELOW_THRESHOLD');
  });
});

describe('rule 5 — the capitalisation threshold is tested PER UNIT, not per line', () => {
  const twoServers = line('Dell PowerEdge R760 rack server', { quantity: 2, netPence: 1_230_000 });

  test('2 × $6,150 is two assets of $6,150 — capital against a £1,000 policy', () => {
    const verdict = classifyLine(twoServers, context());
    expect(verdict.outcome === 'CODE' && verdict.categoryCode).toBe('FA_COMPUTER_EQUIPMENT');
    expect(verdict.outcome === 'CODE' && verdict.treatment).toBe('CAPITAL');
    expect(verdict.advisories).toContain('PER_UNIT_THRESHOLD_APPLIED');
  });

  /**
   * The distinguishing case: against an £8,000 policy the LINE total of
   * $12,300 would capitalise and the two $6,150 units do not. Testing the line
   * is the bug; this is the test that would catch it coming back.
   */
  test('against an £8,000 policy the per-unit answer is BELOW, where the per-line answer would have been above', () => {
    const policy: CapitalisationPolicy = { ...PLATFORM_DEFAULT_CAPITALISATION_POLICY, thresholdPence: 800_000 };

    expect(thresholdVerdictFor(twoServers, policy)).toBe('BELOW');
    // Proof the two readings genuinely disagree — otherwise the test above is vacuous.
    expect(thresholdVerdictFor({ ...twoServers, quantity: 1 }, policy)).toBe('AT_OR_ABOVE');

    const verdict = classifyLine(twoServers, context({ policy }));
    expect(verdict.outcome === 'CODE' && verdict.categoryCode).toBe('IT_EQUIPMENT_AND_CONSUMABLES');
    expect(verdict.outcome === 'CODE' && verdict.treatment).toBe('REVENUE');
  });

  test('a quantity of null, zero or a fraction reads as one unit — never as zero, which would divide the policy away', () => {
    const policy = PLATFORM_DEFAULT_CAPITALISATION_POLICY;
    for (const quantity of [null, 0, -3, 0.4]) {
      expect(thresholdVerdictFor(line('Server', { quantity, netPence: 615_000 }), policy)).toBe('AT_OR_ABOVE');
    }
  });

  test('an amount ON the threshold escalates rather than rounding the practice’s own policy', () => {
    const verdict = classifyLine(line('Workstation', { quantity: 1, netPence: 100_000 }), context());
    expect(verdict.outcome === 'ESCALATE' && verdict.reason).toBe('THRESHOLD_BOUNDARY');
  });

  test('hardware with no amount at all escalates rather than assuming a side', () => {
    const verdict = classifyLine(line('Network switch'), context());
    expect(verdict.outcome === 'ESCALATE' && verdict.reason).toBe('THRESHOLD_BOUNDARY');
    expect(verdict.outcome === 'ESCALATE' && verdict.basis).toBe('HARDWARE_PER_UNIT_UNSETTLED');
  });
});

describe('rule 6 — the services line, and the one bright line inside it', () => {
  test('training is never capitalisable, even beside a capitalised asset', () => {
    const verdict = classifyLine(line('Onsite administrator training, 2 days', { netPence: 260_000 }), context({ hasCapitalHardware: true }));
    expect(verdict.outcome === 'CODE' && verdict.categoryCode).toBe('TRAINING');
    expect(verdict.outcome === 'CODE' && verdict.treatment).toBe('REVENUE');
    expect(verdict.outcome === 'CODE' && verdict.basis).toBe('TRAINING_NEVER_CAPITAL');
  });

  test('installing hardware capitalises INTO the asset when there is one on the document', () => {
    const verdict = classifyLine(line('Installation and commissioning of the new servers', { netPence: 300_000 }), context({ hasCapitalHardware: true }));
    expect(verdict.outcome === 'CODE' && verdict.categoryCode).toBe('FA_INSTALLATION_AND_COMMISSIONING');
    expect(verdict.outcome === 'CODE' && verdict.treatment).toBe('CAPITAL');
  });

  test('the same installation with no capitalised asset to attach to is expensed', () => {
    const verdict = classifyLine(line('Installation and commissioning', { netPence: 300_000 }), context({ hasCapitalHardware: false }));
    expect(verdict.outcome === 'CODE' && verdict.treatment).toBe('REVENUE');
  });

  test('configuring the supplier’s hosted software is expensed — the client controls nothing', () => {
    const verdict = classifyLine(line('Tenant configuration and data migration', { netPence: 180_000 }), context({ hasCapitalHardware: false }));
    expect(verdict.outcome === 'CODE' && verdict.categoryCode).toBe('SOFTWARE_IMPLEMENTATION');
    expect(verdict.outcome === 'CODE' && verdict.basis).toBe('CLOUD_CONFIGURATION_EXPENSED');
  });

  test('"professional services — setup & configuration" beside capitalised hardware must SPLIT', () => {
    const verdict = classifyLine(line('Professional services — setup & configuration', { netPence: 640_000 }), context({ hasCapitalHardware: true }));
    expect(verdict.outcome === 'ESCALATE' && verdict.reason).toBe('MIXED_CAPITAL_AND_REVENUE');
  });

  test('a line naming BOTH installing and configuring splits regardless of what else is on the document', () => {
    const verdict = classifyLine(line('Installation, configuration and handover', { netPence: 400_000 }), context({ hasCapitalHardware: false }));
    expect(verdict.outcome === 'ESCALATE' && verdict.reason).toBe('MIXED_CAPITAL_AND_REVENUE');
  });
});

describe('the orderings that exist because the reverse produced a wrong answer', () => {
  test('a support contract that names a server is a service, not a fixed asset', () => {
    const verdict = classifyLine(line('24×7 server support contract, 12 months', { quantity: 1, netPence: 900_000 }), context());
    expect(verdict.outcome === 'CODE' && verdict.categoryCode).toBe('IT_SUPPORT_AND_MANAGED_SERVICES');
    expect(verdict.outcome === 'CODE' && verdict.treatment).toBe('REVENUE');
  });

  test('“boiler maintenance” is not IT support — the generic words need an IT context', () => {
    const verdict = classifyLine(line('Annual boiler maintenance', { netPence: 24_000 }), context());
    expect(verdict.outcome === 'CODE' && verdict.categoryCode).toBe('REPAIRS_AND_MAINTENANCE');
  });

  test('a “rack server” is a server, not a racking service', () => {
    expect(capitalisesAsHardware(line('Dell PowerEdge R760 rack server', { quantity: 2, netPence: 1_230_000 }), PLATFORM_DEFAULT_CAPITALISATION_POLICY)).toBe(true);
  });

  test('cloud infrastructure is a service contract at any amount, never a fixed asset', () => {
    const verdict = classifyLine(line('Cloud hosting — dedicated compute', { netPence: 5_000_000 }), context());
    expect(verdict.outcome === 'CODE' && verdict.categoryCode).toBe('HOSTING_AND_INFRASTRUCTURE');
    expect(verdict.outcome === 'CODE' && verdict.treatment).toBe('REVENUE');
  });

  test('a network cable is not a fixed asset however the threshold falls', () => {
    const verdict = classifyLine(line('Cat6 patch cables, box of 50', { quantity: 1, netPence: 900_000 }), context());
    expect(verdict.outcome === 'CODE' && verdict.categoryCode).toBe('IT_EQUIPMENT_AND_CONSUMABLES');
  });
});

describe('a code the client’s chart does not carry is REFUSED, never fuzzy-matched', () => {
  test('a chart without the fixed-asset account refuses rather than substituting a near miss', () => {
    const withoutFixedAssets = CHART.accounts.filter((account) => account.code !== 'FA_COMPUTER_EQUIPMENT');
    const verdict = classifyLine(
      line('Dell PowerEdge R760 rack server', { quantity: 2, netPence: 1_230_000 }),
      context({ chartCodes: new Set(withoutFixedAssets.map((a) => a.code)), accounts: withoutFixedAssets }),
    );

    expect(verdict.outcome).toBe('ESCALATE');
    if (verdict.outcome !== 'ESCALATE') return;
    expect(verdict.reason).toBe('CODE_NOT_ON_CHART');
    expect(verdict.basis).toBe('OFF_CHART_CODE_REFUSED');
  });

  test('a second choice that is off-chart is dropped rather than offered', () => {
    const withoutSecond = CHART.accounts.filter((account) => account.code !== 'IT_EQUIPMENT_AND_CONSUMABLES');
    const verdict = classifyLine(
      line('Dell PowerEdge R760 rack server', { quantity: 2, netPence: 1_230_000 }),
      context({ chartCodes: new Set(withoutSecond.map((a) => a.code)), accounts: withoutSecond }),
    );
    expect(verdict.outcome === 'CODE' && verdict.secondChoiceCode).toBeNull();
  });
});

describe('foreign tax and the threshold currency', () => {
  test('a tax line is not a category — it is part of the cost of the lines above it', () => {
    const verdict = classifyLine(line('Sales tax @ 8.875%', { netPence: 466_381 }), context({ currency: 'USD' }));
    expect(verdict.outcome).toBe('TAX_LINE');
  });

  test('a document in another currency says the threshold was compared without an exchange rate', () => {
    const verdict = classifyLine(line('Dell PowerEdge R760 rack server', { quantity: 2, netPence: 1_230_000 }), context({ currency: 'USD' }));
    expect(verdict.advisories).toContain('THRESHOLD_COMPARED_WITHOUT_FX');
  });

  test('a GBP document does not carry an FX caveat it does not need', () => {
    const verdict = classifyLine(line('Dell PowerEdge R760 rack server', { quantity: 2, netPence: 1_230_000 }), context({ currency: 'GBP' }));
    expect(verdict.advisories).not.toContain('THRESHOLD_COMPARED_WITHOUT_FX');
  });
});

describe('the amount decides ONE thing and nothing else', () => {
  /**
   * Rule 2, as a property: change the amount by four orders of magnitude and
   * every NON-hardware answer must be identical. Only the capitalisation
   * threshold may read a number.
   */
  test('changing the amount never changes which expense account a line lands on', () => {
    const descriptions = [
      'Microsoft 365 E3 annual subscription',
      'Cloud hosting — dedicated compute',
      '24×7 server support contract',
      'Onsite administrator training, 2 days',
      'Tenant configuration and data migration',
    ];

    for (const description of descriptions) {
      const small = classifyLine(line(description, { quantity: 1, netPence: 100 }), context());
      const large = classifyLine(line(description, { quantity: 1, netPence: 100_000_000 }), context());
      expect(small).toEqual(large);
    }
  });
});
