import { render, screen } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { describe, expect, test } from 'vitest';
import type { TaxEstimate, TaxEstimateView } from '@neoting/contracts/model';
import { TaxEstimatePanel } from './TaxEstimatePanel';

const OFFER = 'OFFER';
const PARAMS = { kind: 'VAT' as const, periodStart: '2026-07-01', periodEnd: '2026-09-30' };

const ESTIMATE: TaxEstimate = {
  country: 'GB',
  kind: 'VAT',
  currency: 'GBP',
  periodStart: '2026-07-01',
  periodEnd: '2026-09-30',
  applicable: true,
  figures: [
    { code: '1', label: 'VAT due on sales and other outputs', amountPence: 200_000 },
    { code: '4', label: 'VAT reclaimed on purchases and other inputs', amountPence: 50_000 },
  ],
  result: { amountPence: 150_000, lowPence: 140_000, highPence: 170_000 },
  completeness: {
    scorePercent: 61,
    statementCoveragePercent: 100,
    evidencedPercent: 93,
    reviewedPercent: 66,
    unevidencedDebitsPence: 1_200,
    unevidencedCreditsPence: 0,
  },
  notes: ['£12.00 of payments out have no receipt or invoice.'],
  assumptions: ['Accruals basis.'],
  lines: [],
};

function show(view: TaxEstimateView | undefined, country: 'GB' | 'AU' = 'GB') {
  return render(
    <IntlProvider locale="en-GB">
      <TaxEstimatePanel
        country={country}
        view={view}
        loading={false}
        error={null}
        params={PARAMS}
        onParams={() => undefined}
        subject="Brick Lane Bakery Ltd"
        inactive={<p>{OFFER}</p>}
      />
    </IntlProvider>,
  );
}

describe('TaxEstimatePanel', () => {
  test('always says it is an estimate that cannot be submitted, naming the right authority', () => {
    show({ active: false, estimate: null });
    expect(document.body.textContent).toMatch(/cannot be submitted to HMRC/);
    show({ active: false, estimate: null }, 'AU');
    expect(document.body.textContent).toMatch(/cannot be submitted to the ATO/);
  });

  test('without the add-on it shows the caller’s offer, not an estimate', () => {
    show({ active: false, estimate: null });
    expect(screen.getByText('OFFER')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/to pay/);
  });

  test('the central figure, the range, the score and the boxes', () => {
    show({ active: true, estimate: ESTIMATE });
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/VAT to pay/);
    expect(text).toMatch(/£1,500\.00/);
    expect(text).toMatch(/Likely between £1,400\.00 and £1,700\.00/);
    expect(text).toMatch(/61% complete/);
    expect(text).toMatch(/VAT due on sales and other outputs/);
    expect(text).toMatch(/no receipt or invoice/);
  });

  test('a negative VAT result reads as a reclaim, shown as a positive amount', () => {
    show({ active: true, estimate: { ...ESTIMATE, result: { amountPence: -30_000, lowPence: -40_000, highPence: -30_000 } } });
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/VAT to reclaim/);
    expect(text).toMatch(/£300\.00/);
    expect(text).toMatch(/Likely between £300\.00 and £400\.00 to reclaim/);
    expect(text).not.toMatch(/-£/);
  });

  test('an estimate that does not apply says why instead of showing zeros', () => {
    show({ active: true, estimate: { ...ESTIMATE, applicable: false, figures: [], notes: ['This client isn’t recorded as VAT-registered.'] } });
    expect(document.body.textContent).toMatch(/No estimate for this client/);
    expect(document.body.textContent).toMatch(/isn’t recorded as VAT-registered/);
  });

  test('a range that crosses zero says both directions', () => {
    show({ active: true, estimate: { ...ESTIMATE, result: { amountPence: -10_000, lowPence: -10_000, highPence: 25_000 } } });
    expect(document.body.textContent).toMatch(/Likely anywhere from £100\.00 to reclaim to £250\.00 to pay/);
  });
});
