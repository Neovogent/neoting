import { useQuery } from '@tanstack/react-query';
import { getPortalTaxEstimate, getTaxEstimate, setBillingAddOn } from '@neoting/contracts/client';
import type { TaxEstimateView } from '@neoting/contracts/model';
import { getPortalTaxEstimateResponse, getTaxEstimateResponse, setBillingAddOnBody } from '@neoting/contracts/zod';
import { API_ENABLED } from './config';
import { unwrapBody } from './envelope';

/**
 * The tax estimate add-on (D52), client side: the accountant's read, the
 * client's own read, and the client switching an add-on on or off. The
 * estimate is computed server-side; nothing here does tax arithmetic.
 */

export type EstimateKind = 'VAT' | 'COMPANY_TAX';
export type Country = 'GB' | 'AU';

export interface EstimateParams {
  readonly kind: EstimateKind;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly vatScheme?: 'STANDARD' | 'FLAT_RATE';
  readonly flatRateBasisPoints?: number;
}

const bearer = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}` } });

/** The accountant's view of one client's estimate. */
export function useTaxEstimate(businessId: string, params: EstimateParams, enabled = true) {
  return useQuery({
    queryKey: ['tax-estimate', businessId, params],
    enabled: API_ENABLED && enabled && businessId !== '',
    staleTime: 60_000,
    queryFn: async () => getTaxEstimateResponse.parse(unwrapBody(await getTaxEstimate({ businessId, ...params }))) as TaxEstimateView,
  });
}

/**
 * The client's own estimate. `poll` keeps asking while an add-on the client
 * has just bought waits for Stripe's webhook to switch it on.
 */
export function usePortalTaxEstimate(token: string, params: EstimateParams, poll: boolean) {
  return useQuery({
    queryKey: ['portal-tax-estimate', params],
    staleTime: 60_000,
    refetchInterval: poll ? 3_000 : false,
    queryFn: async () =>
      getPortalTaxEstimateResponse.parse(unwrapBody(await getPortalTaxEstimate(params, bearer(token)))) as TaxEstimateView,
  });
}

/** Switch a paid add-on on or off on the client's own subscription. The webhook confirms it. */
export async function setPortalAddOn(
  token: string,
  businessId: string,
  addOn: 'TAX_ESTIMATE' | 'DOCUMENT_VAULT',
  enabled: boolean,
): Promise<void> {
  await setBillingAddOn(setBillingAddOnBody.parse({ businessId, addOn, enabled }), bearer(token));
}

export interface PeriodPreset {
  readonly key: 'thisQuarter' | 'lastQuarter' | 'thisYear' | 'lastYear' | 'last12Months';
  readonly start: string;
  readonly end: string;
}

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/**
 * The periods worth one click. VAT and BAS quarters are calendar quarters
 * (Jul–Sep etc.), which is also the BAS quarter in Australia; a client on a
 * different VAT stagger uses the date boxes. Company tax: the Australian
 * income year (1 July – 30 June), or the last 12 months for the UK, where
 * every company's year end differs.
 */
export function periodPresets(country: Country, kind: EstimateKind, today: Date): PeriodPreset[] {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  if (kind === 'VAT') {
    const q = m - (m % 3);
    return [
      { key: 'thisQuarter', start: iso(y, q, 1), end: iso(y, q + 3, 0) },
      { key: 'lastQuarter', start: iso(y, q - 3, 1), end: iso(y, q, 0) },
    ];
  }
  if (country === 'AU') {
    const startYear = m >= 6 ? y : y - 1;
    return [
      { key: 'thisYear', start: iso(startYear, 6, 1), end: iso(startYear + 1, 5, 30) },
      { key: 'lastYear', start: iso(startYear - 1, 6, 1), end: iso(startYear, 5, 30) },
    ];
  }
  return [{ key: 'last12Months', start: iso(y - 1, m + 1, 1), end: iso(y, m + 1, 0) }];
}

/**
 * Where both tabs open: the last COMPLETED VAT/BAS quarter (the same in both
 * countries) — a return is prepared after its quarter ends, and the current
 * quarter is mostly empty until then.
 */
export function initialParams(): EstimateParams {
  const q = periodPresets('GB', 'VAT', new Date())[1];
  return { kind: 'VAT', periodStart: q?.start ?? '', periodEnd: q?.end ?? '' };
}
