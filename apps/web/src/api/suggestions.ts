import { useQuery } from '@tanstack/react-query';
import { getChatSuggestions } from '@neoting/contracts/client';
import { getChatSuggestionsResponse } from '@neoting/contracts/zod';
import { unwrapBody } from './envelope';
import { API_ENABLED } from './config';
import type { Suggestion } from '../lib/promptSuggestions';

/**
 * The chat box's live briefing (`GET /v1/chat/suggestions`).
 *
 * Floor-resident by the same argument as `chat.ts`: the chat input is the
 * shell, so its data source cannot live on a lazy chunk. The marginal cost is
 * one generated function and one Zod schema (the reachability rule — the
 * barrels are already floor-resident), and like `proposals.ts` it calls the
 * plain generated function inside its own `useQuery` rather than pulling the
 * generated hook machinery.
 *
 * Returns `null` until a live answer exists — the caller keeps the local
 * heuristic ranking as its fallback, so the box always has something honest
 * to offer. `source` rides along because the contract makes provenance
 * load-bearing: `model` sentences were written by the pinned model from this
 * practice's own pipeline state; `derived` is the server's deterministic
 * fallback (model unreachable or the daily budget spent).
 */

export interface LiveSuggestions {
  readonly suggestions: readonly Suggestion[];
  readonly source: 'model' | 'derived';
}

export function useLiveSuggestions(sessionOn: boolean, businessId: string | undefined): LiveSuggestions | null {
  const query = useQuery({
    queryKey: ['chat', 'suggestions', businessId ?? ''],
    enabled: API_ENABLED && sessionOn,
    // A briefing, not a feed: refreshed on a slow poll because pipeline state
    // moves in minutes, and the server caches per practice anyway.
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: async () => {
      const raw = await getChatSuggestions(businessId === undefined ? undefined : { businessId });
      const parsed = getChatSuggestionsResponse.safeParse(unwrapBody(raw));
      if (!parsed.success) {
        throw new Error(`off-contract suggestions response (${parsed.error.issues[0]?.path.join('.') || 'body'})`);
      }
      return parsed.data;
    },
  });

  if (query.data === undefined) return null;
  return {
    suggestions: query.data.suggestions.map((s) => ({ text: s.text, because: s.because, weight: s.weight })),
    source: query.data.source,
  };
}
