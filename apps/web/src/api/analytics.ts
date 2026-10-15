import { useQuery } from '@tanstack/react-query';

import {
  getBusinessAnalytics,
  getGetBusinessAnalyticsCsvUrl,
  getGetPracticeAnalyticsCsvUrl,
  getPracticeAnalytics,
} from '@neoting/contracts/client';
import type { AnalyticsReport } from '@neoting/contracts/model';
import { getPracticeAnalyticsResponse } from '@neoting/contracts/zod';

import { API_BASE_URL, API_ENABLED } from './config';
import { unwrapBody } from './envelope';

/**
 * SoT §11 pipeline analytics — every figure the SERVER computed
 * (`GET /v1/analytics/practice|businesses/{id}`); the browser formats, never
 * counts. Imported only by the Analytics view's lazy chunk, so the generated
 * analytics client stays off the floor.
 */

export type { AnalyticsReport };

export interface AnalyticsPeriod {
  readonly from: string;
  readonly to: string;
}

/** `'practice'` or a server business id. */
export function useAnalyticsReport(scope: string, period: AnalyticsPeriod) {
  return useQuery({
    queryKey: ['analytics', scope, period.from, period.to],
    enabled: API_ENABLED,
    queryFn: async (): Promise<AnalyticsReport> => {
      const raw = scope === 'practice' ? await getPracticeAnalytics(period) : await getBusinessAnalytics(scope, period);
      // Both operations answer the same shape; the practice schema parses either.
      return getPracticeAnalyticsResponse.parse(unwrapBody(raw)) as AnalyticsReport;
    },
  });
}

/** The CSV of the same report — a plain link, so the session cookie rides along. */
export function analyticsCsvHref(scope: string, period: AnalyticsPeriod): string {
  const path = scope === 'practice' ? getGetPracticeAnalyticsCsvUrl(period) : getGetBusinessAnalyticsCsvUrl(scope, period);
  return `${API_BASE_URL}/v1${path}`;
}

/** `YYYY-MM-DD` for a UTC day `daysAgo` before today. */
export function isoDaysAgo(daysAgo: number, now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo)).toISOString().slice(0, 10);
}
