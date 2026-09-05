import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getListDuplicatesQueryKey, listDuplicates } from '@neoting/contracts/client';
import { listDuplicatesResponse } from '@neoting/contracts/zod';
import { unwrapBody } from './envelope';

/**
 * `GET /v1/duplicates` — the recorded duplicate rulings (review item 49).
 *
 * The suspected-duplicate PAIRS are still derived client-side
 * (`lib/dedupe.ts` over the hydrated documents); what this read adds is the
 * decided ones: a pair a `document.resolve-duplicate` approval ruled on stays
 * ruled across reloads and colleagues, instead of re-flagging on every visit.
 * The views subtract `decidedPairKeys` from their derived pairs before
 * rendering a flag.
 *
 * ⚠ Imported by the VIEW chunks only (InboxesView, ClientInbox) — never from
 * AppContext, which would put the generated client on every route's floor
 * (the chases.ts placement rule).
 */

/** One key per unordered pair, so either derivation order matches the ruling. */
export function pairKey(aId: string, bId: string): string {
  return aId < bId ? `${aId}::${bId}` : `${bId}::${aId}`;
}

export interface DuplicateResolutions {
  /** Unordered-pair keys (`pairKey`) a human has ruled on — verdict ≠ PENDING. */
  decidedPairKeys: ReadonlySet<string>;
  refetch: () => void;
}

export function useDuplicateResolutions(enabled: boolean): DuplicateResolutions {
  const query = useQuery({
    queryKey: getListDuplicatesQueryKey(),
    queryFn: async () => {
      const parsed = listDuplicatesResponse.safeParse(unwrapBody(await listDuplicates()));
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'contract drift');
      return parsed.data.items;
    },
    enabled,
    staleTime: 30_000,
  });

  const decidedPairKeys = useMemo(
    () =>
      new Set(
        (query.data ?? [])
          .filter((row) => row.verdict !== 'PENDING')
          .map((row) => pairKey(row.documentAId, row.documentBId)),
      ),
    [query.data],
  );

  return { decidedPairKeys, refetch: () => void query.refetch() };
}
