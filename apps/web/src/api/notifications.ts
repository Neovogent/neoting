import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listNotifications, markNotificationsRead } from '@neoting/contracts/client';
import { listNotificationsResponse } from '@neoting/contracts/zod';
import type { NotificationItem } from '@neoting/contracts/model';
import { unwrapBody } from './envelope';

/**
 * The bell (review item 12, 5 Sep 2026) — `GET /v1/notifications` +
 * `POST /v1/notifications/read-receipts`, the read surface the pipeline's
 * notification rows waited for since Stage 8.8. Until this, a client's portal
 * upload changed nothing on the accountant's screen except by the board's 30 s
 * poll — "no real time notification ... or any sign of document arrival".
 *
 * ## Ten seconds, on the header
 *
 * The poll is 10 s plus window focus: faster than the board's 30 s because
 * arrival is the one signal this surface exists for, slower than the document
 * lists' 5 s because the endpoint is on EVERY workspace route. One page of the
 * newest rows is the bell's whole appetite — `unreadCount` is the server's
 * whole-practice number, so the badge is true even when the list is cut off.
 * TanStack structural sharing makes an unchanged poll re-render nothing.
 *
 * Plain generated functions inside our own `useQuery` (the `proposals.ts`
 * idiom), body through `unwrapBody`, parsed by the generated Zod — a contract
 * drift surfaces here with the field named.
 */
export type { NotificationItem };

const PAGE = 20;

export function useNotifications(enabled: boolean) {
  const query = useQuery({
    queryKey: ['notifications', 'bell'],
    enabled,
    refetchInterval: enabled && 10_000,
    refetchOnWindowFocus: true,
    queryFn: async () => unwrapBody(await listNotifications({ limit: PAGE })),
  });

  const parsed = useMemo(() => {
    const empty = { items: [] as NotificationItem[], unreadCount: 0, invalid: null as string | null };
    if (query.data === undefined) return empty;
    const result = listNotificationsResponse.safeParse(query.data);
    if (!result.success) {
      return { ...empty, invalid: result.error.issues[0]?.message ?? 'contract drift' };
    }
    return { items: result.data.data as NotificationItem[], unreadCount: result.data.unreadCount, invalid: null };
  }, [query.data]);

  return {
    items: parsed.items,
    unreadCount: parsed.unreadCount,
    contractError: parsed.invalid,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * Mark everything read. The response carries the server's new unread count,
 * and the caller refetches rather than trusting a prediction — the
 * `deleteDocument` render-server-truth posture.
 */
export async function markAllNotificationsRead(): Promise<void> {
  await markNotificationsRead();
}
