import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { getChase, getListChasesQueryKey, listChases, useListSmsOutbox } from '@neoting/contracts/client';
import { getChaseResponse, listChasesResponse, listSmsOutboxResponse } from '@neoting/contracts/zod';
import type { Chase as ApiChase, ChaseDetectionEngine, ChaseState, ChaseSummary, SmsOutboxMessage } from '@neoting/contracts/model';
import { fromIsoDate, fromPence } from './documents';
import { unwrapBody } from './envelope';

/**
 * The chase read surface (METH Stage 12) — `GET /chases`, `GET /chases/{id}`
 * and the demo outbox `GET /sms-outbox`.
 *
 * This deliberately does NOT fill the AppContext `chases` array the way the
 * documents and bank slices fill theirs. Two reasons, both structural:
 *
 *   - The bundle floor has no headroom (apps/web/CLAUDE.md): a fill effect
 *     lives in `AppContext`, which would put this module and the generated
 *     chases client on every route. This module is imported by the Chases
 *     chunk alone.
 *   - The local `Chase` shape is the synthetic composer's — drafts, reminder
 *     cooldowns, item staging — none of which is contracted yet. Mapping a
 *     server chase into it would mount buttons whose writes the next poll
 *     silently reverts. The live board renders this module's own read-shape
 *     instead, and the synthetic screens keep theirs.
 *
 * The list is summaries only; the items and messages live on the detail. The
 * board needs both, so the query fetches the page and then every detail —
 * through the SAME generated client and validated row by row. Parse failures
 * throw (they surface as the slice's fallback-with-badge), because a chase
 * this code half-understood is worse than the seeds honestly labelled.
 */

export interface LiveChaseItem {
  transactionId: string;
  supplier: string;
  /** Unsigned pounds for display — a chased line is money out by definition. */
  amount: number;
  date: string;
  received: boolean;
}

export interface LiveChaseMessage {
  id: string;
  channel: string;
  body: string;
  recipient: string | null;
  deliveryState: string | null;
  at: string;
}

export interface LiveChase {
  id: string;
  businessId: string;
  engine: ChaseDetectionEngine;
  state: ChaseState;
  open: boolean;
  items: LiveChaseItem[];
  messages: LiveChaseMessage[];
  createdAt: string;
  lastSentAt: string | null;
  closedAt: string | null;
  closedReason: string | null;
  closedByDocumentId: string | null;
}

/** The states that still ask for something. Everything CLOSED_* is history. */
const OPEN_STATES: ReadonlySet<ChaseState> = new Set([
  'DETECTED',
  'PROPOSED',
  'APPROVED',
  'SENT',
  'REMINDED',
  'ESCALATED',
]);

/** A UTC instant rendered as a Europe/London day + time (the repo's render rule). */
export function fromIsoInstant(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
}

export function toLiveChase(row: ApiChase): LiveChase {
  return {
    id: row.id,
    businessId: row.businessId,
    engine: row.detectionEngine,
    state: row.state,
    open: OPEN_STATES.has(row.state),
    items: row.items.map((item) => ({
      transactionId: item.transactionId,
      supplier: item.merchantName ?? item.descriptionRaw ?? '—',
      // Signed pence on the wire (negative is money out); the board shows the
      // magnitude — the sign convention stays at this boundary, like bank.ts.
      amount: fromPence(Math.abs(item.amountPence)),
      date: fromIsoDate(item.bookedAt),
      received: item.received,
    })),
    messages: row.messages.map((msg) => ({
      id: msg.id,
      channel: msg.channel,
      body: msg.body,
      recipient: msg.recipientE164 ?? null,
      deliveryState: msg.deliveryState ?? null,
      at: fromIsoInstant(msg.sentAt ?? msg.createdAt) ?? '—',
    })),
    createdAt: fromIsoDate(row.createdAt),
    lastSentAt: fromIsoInstant(row.lastSentAt),
    closedAt: fromIsoInstant(row.closedAt),
    closedReason: row.closedReason ?? null,
    closedByDocumentId: row.closedByDocumentId ?? null,
  };
}

const contractIssue = (issues: { path: PropertyKey[]; message: string }[]): Error =>
  new Error(
    issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
      .join('; '),
  );

/**
 * ⚠ `getChaseResponse` cannot be used whole — the measured orval gap
 * `apps/api/src/modules/approvals/proposal-body.ts` documents, met again
 * here: `Chase` is `allOf [ChaseSummary, {items, messages}]` and orval emits
 * an INTERSECTION of two `.strict()` objects, each of which rejects the
 * other's keys — so the generated schema rejects every body the server can
 * send. The halves themselves are sound; this parses each against the body
 * with the other's keys stripped rather than refused, and rebuilds the Chase
 * from the two validated results. `chases.test.ts` pins the gap — when orval
 * fixes it the pin fails and this collapses to one `safeParse`.
 */
type StrictHalf = z.ZodObject<z.ZodRawShape>;
const chaseHalves = (getChaseResponse as unknown as { _def: { left: StrictHalf; right: StrictHalf } })._def;
const detailIsRight = 'items' in chaseHalves.right.shape;
const chaseSummaryHalf = (detailIsRight ? chaseHalves.left : chaseHalves.right).strip();
const chaseDetailHalf = (detailIsRight ? chaseHalves.right : chaseHalves.left).strip();

/** A detail body → a contract `Chase`, or null when either half refuses. */
export function parseChaseDetail(body: unknown): ApiChase | null {
  const summary = chaseSummaryHalf.safeParse(body);
  const detail = chaseDetailHalf.safeParse(body);
  if (!summary.success || !detail.success) return null;
  return { ...summary.data, ...detail.data } as ApiChase;
}

export interface UseChasesOptions {
  /** Off entirely when the app is running on seed data. */
  enabled: boolean;
}

/**
 * Every chase in scope, with items and messages, newest first — polled while
 * enabled, because the auto-close beat happens OUTSIDE this browser (a portal
 * upload closes the chase server-side) and this screen is where it is watched
 * happening.
 */
export function useChases({ enabled }: UseChasesOptions) {
  const query = useQuery({
    queryKey: [...getListChasesQueryKey({ limit: 50 }), 'details'],
    queryFn: async (): Promise<ApiChase[]> => {
      const list = listChasesResponse.safeParse(unwrapBody(await listChases({ limit: 50 })));
      if (!list.success) throw contractIssue(list.error.issues);

      const details = await Promise.all(list.data.data.map((summary) => getChase(summary.id)));
      return details.map((detail, i) => {
        const parsed = parseChaseDetail(unwrapBody(detail));
        if (parsed) return parsed;
        // A detail that fails its parse degrades to the summary the LIST
        // already validated — the chase stays on the board with its items and
        // messages withheld, rather than one row felling the whole surface
        // (the documents-mapper rule). The known case: a chase whose item
        // refs resolve to no visible transaction serves `items: []`, which
        // the contract's `minItems: 1` refuses — seeded `chs_003` today, and
        // structurally possible whenever RLS withholds every item. That is a
        // contract-vs-projection question for the chase module (flagged on
        // issue #140), not this surface's to settle.
        return { ...(list.data.data[i] as ChaseSummary), items: [], messages: [] };
      });
    },
    enabled,
    refetchInterval: enabled && 5_000,
  });

  const chases = useMemo(() => (query.data ?? []).map(toLiveChase), [query.data]);

  return {
    chases,
    // Contract drift throws inside the queryFn, so it arrives as the query's
    // own error — named in the fallback badge like a transport failure.
    contractError: null as string | null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

export interface LiveSms {
  id: string;
  businessId: string;
  to: string;
  body: string;
  deliveryState: string | null;
  chaseId: string | null;
  /** In-app path to the portal, or null when the body carried no link. */
  portalPath: string | null;
  at: string;
}

/**
 * The link as an address THIS app can open. The API's `portalUrl` is whatever
 * followed the body's `Upload securely: ` marker — the bare signed token from
 * the real composer, a full URL in older fixtures — so the last path segment
 * is taken and re-homed under this origin's `/p/` route (the same tolerance
 * the portal's link-entry screen applies to a pasted link).
 */
export function portalPathFrom(portalUrl: string | null | undefined): string | null {
  if (!portalUrl) return null;
  const token = portalUrl.trim().split('/').pop();
  return token ? `/p/${token}` : null;
}

export function toLiveSms(row: SmsOutboxMessage): LiveSms {
  return {
    id: row.id,
    businessId: row.businessId,
    to: row.toE164,
    body: row.body,
    deliveryState: row.deliveryState ?? null,
    chaseId: row.chaseId ?? null,
    portalPath: portalPathFrom(row.portalUrl),
    at: fromIsoInstant(row.sentAt) ?? '—',
  };
}

export interface UseSmsOutboxOptions {
  /** Off entirely when the app is running on seed data. */
  enabled: boolean;
}

/**
 * The demo "client's phone" (`x-demo` in the contract) — polled while enabled,
 * because the row lands when an approval elsewhere executes `chase.send` and
 * the whole point of the panel is watching it arrive.
 */
export function useSmsOutbox({ enabled }: UseSmsOutboxOptions) {
  const query = useListSmsOutbox({ limit: 50 }, { query: { enabled, refetchInterval: enabled && 5_000 } });

  const parsed = useMemo(() => {
    const empty = { messages: [] as LiveSms[], invalid: null as string | null };
    if (!query.data) return empty;

    const result = listSmsOutboxResponse.safeParse(unwrapBody(query.data));
    if (!result.success) {
      return {
        ...empty,
        invalid: result.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
          .join('; '),
      };
    }
    return { messages: result.data.data.map((row) => toLiveSms(row as SmsOutboxMessage)), invalid: null };
  }, [query.data]);

  return {
    messages: parsed.messages,
    /** Set when the server's answer did not match the contract. */
    contractError: parsed.invalid,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}
