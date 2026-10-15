import { useQuery } from '@tanstack/react-query';
import { getChasePolicy } from '@neoting/contracts/client';
import { getChasePolicyResponse } from '@neoting/contracts/zod';
import type { ChasePolicy } from '@neoting/contracts/model';
import { unwrapBody } from './envelope';

/**
 * The practice's chasing schedule (rush/chase-scheduler) — `GET /v1/chase-policy`.
 *
 * Read-only: changing it is a `policy.activate` proposal through the ordinary
 * Review → Approve card. Imported only by the lazy `ChaseSchedulePanel`, so the
 * generated call stays off the bundle floor (the `api/proposals.ts` rule).
 */
export const CHASE_POLICY_QUERY_KEY = ['chase-policy'] as const;

export function useChasePolicy({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: CHASE_POLICY_QUERY_KEY,
    enabled,
    queryFn: async (): Promise<ChasePolicy> => getChasePolicyResponse.parse(unwrapBody(await getChasePolicy())),
  });
}
