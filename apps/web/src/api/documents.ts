import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listDocuments } from '@neoting/contracts/client';
import { listDocumentsResponse } from '@neoting/contracts/zod';
import type { DocumentSummary, ListDocumentsParams } from '@neoting/contracts/model';
// The envelope problem and its one answer live in `envelope.ts` (METH S6);
// this hook shipped violating it (`query.data.data`) and was fixed in METH S7.
// `fetchAllPages` applies it per page — see `paged.ts`.
import { fetchAllPages, PAGE_LIMIT } from './paged';
import type { DocKind, Document as LocalDocument, DocStatus, SourceChannel } from '../lib/types';

/**
 * The documents surface, read from the API.
 *
 * The first screen migrated off local state. Everything else in the app still
 * runs on the seeded context, and deliberately so — the pipeline derives
 * approvals, chases, duplicates and client statistics from the document array,
 * so swapping the source under all of it at once would replace a working demo
 * with a large silent outage. This changes where documents come from and
 * nothing else about what happens to them.
 *
 * Two conversions matter and are done here, once, rather than in components:
 *
 *   MONEY. The contract is integer pence and says so loudly; the app's local
 *   shape is pounds as a float. Dividing at the boundary means no screen ever
 *   has to know, and no arithmetic downstream is done on a value that is
 *   sometimes one and sometimes the other.
 *
 *   ENUMS. `TO_REVIEW` is not `review`. Mapping through a table rather than
 *   lowercasing puts every translation in one place instead of four.
 *
 * ⚠ The tables below fall back rather than throw, so an unrecognised value
 * renders as `processing` / `web` rather than failing. That is deliberate — a
 * mapper that throws takes the whole screen down over one odd row — but it does
 * mean a NEW enum value would show as something plausible instead of announcing
 * itself. The enforcement is at test time, not run time: `documents.test.ts`
 * pins both tables against `DocumentState` and `DocumentChannel` from the
 * contract, so a value added to the spec fails there. Both tables are
 * exhaustive against the contract today; keep them that way.
 */

/** Integer pence to the pounds the local shape carries. */
export const fromPence = (pence: number | null | undefined): number => (pence == null ? 0 : pence / 100);

/**
 * Does a document belong on a status tab? (4 Sep 2026)
 *
 * One predicate for the tab lists AND the tab counts, so they cannot disagree.
 * A STATEMENT document is excluded from To Review and Ready: it has no
 * supplier, no single total and no category, so it can never leave To Review
 * and it clutters the accountant's to-do list with rows nothing can be done
 * to — its home is the Statements panel, which carries the D41 verdict. It
 * stays visible on processing/published/rejected (a failed statement READ
 * still matters) and on the Documents register, which shows every state.
 * Synthetic rows carry no `isStatement`, so synthetic mode is unchanged.
 */
export function onStatusTab(doc: Pick<LocalDocument, 'status' | 'isStatement'>, tab: DocStatus | 'duplicates'): boolean {
  // `'duplicates'` is ClientInbox's pseudo-tab: no document's status ever
  // equals it, so it falls through the compare exactly as it always did.
  if ((doc.status as string) !== tab) return false;
  return !(doc.isStatement === true && (tab === 'review' || tab === 'ready'));
}

const STATE_TO_STATUS: Record<string, DocStatus> = {
  RECEIVED: 'processing',
  PROCESSING: 'processing',
  TO_REVIEW: 'review',
  READY: 'ready',
  PUBLISHED: 'published',
  REJECTED: 'rejected',
  FAILED: 'rejected',
  ARCHIVED: 'published',
};

const CHANNEL_TO_SOURCE: Record<string, SourceChannel> = {
  WEB_UPLOAD: 'web',
  EMAIL: 'email',
  WHATSAPP: 'whatsapp',
  SMS_PORTAL: 'sms-link',
  CHAT_UPLOAD: 'chat',
  STRUCTURED_IMPORT: 'csv',
  API: 'web',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-08-10" → "10 Aug 2026", which is what every screen renders. */
export function fromIsoDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '—';
  return `${m[3]} ${MONTHS[Number(m[2]) - 1] ?? '???'} ${m[1]}`;
}

/**
 * One API row in the shape the app already renders.
 *
 * `businessId` is `biz_<clientId>` in the fixtures and will be an opaque id in
 * production, so the client name is resolved from whatever the caller knows
 * rather than parsed out of it.
 */
export function toLocalDocument(row: DocumentSummary, clientNameFor: (businessId: string) => string): LocalDocument {
  const kind: DocKind = row.inbox === 'SALES' ? 'sales' : 'cost';
  const party = (row.inbox === 'SALES' ? row.customerName : row.supplierName) ?? 'Unknown';

  return {
    id: row.id,
    clientId: row.businessId,
    clientName: clientNameFor(row.businessId),
    supplier: party,
    date: fromIsoDate(row.documentDate ?? row.receivedAt),
    total: fromPence(row.totalPence),
    category: row.categoryCode ?? '—',
    status: STATE_TO_STATUS[row.state] ?? 'processing',
    // The contract guarantees a reason on REJECTED and FAILED, so it is shown
    // as-is rather than replaced with a generic line.
    statusNote: row.failureMessage ?? undefined,
    failureCode: row.failureCode ?? undefined,
    source: CHANNEL_TO_SOURCE[row.channel] ?? 'web',
    uploader: row.originalFilename,
    currency: row.currency ?? 'GBP',
    kind,
    fields: [],
    lineItems: [],
    splitFrom: row.parentDocumentId ? row.originalFilename : undefined,
    ...(row.docType === 'STATEMENT' ? { isStatement: true } : {}),
    // A failed PUBLISH is `REJECTED` + an NT-PUB code (the follow-up's only
    // failure exit from READY); `FAILED` is extraction. This flag said
    // `state === 'FAILED'` until METH S12, which branded every unreadable
    // photo a publish failure.
    publishFailed: row.failureCode?.startsWith('NT-PUB') ? true : undefined,
  };
}

export interface UseDocumentsOptions {
  /** Off entirely when the app is running on seed data. */
  enabled: boolean;
  params?: ListDocumentsParams;
  clientNameFor: (businessId: string) => string;
}

/**
 * The inbox, from `GET /documents`.
 *
 * The response is parsed through the generated Zod schema before anything
 * touches it — read as the RAW BODY through `unwrapBody`, because the
 * generated envelope type does not exist at runtime (this hook shipped
 * reaching one level too deep, and every live inbox load reported a contract
 * error instead of rendering; fixed in METH S7 and pinned in the test).
 *
 * While enabled it also POLLS, every 5 seconds. Documents arrive from outside
 * this browser — WhatsApp, email, the OTP portal, a worker finishing an
 * extraction — and the inbox is the screen on which they are watched landing
 * (METH S7; SoT Stage 5's live pipeline states). TanStack's structural sharing
 * keeps an unchanged response the same object, so an idle poll re-renders
 * nothing. Push (SSE/websocket) replaces this post-demo; polling is honest and
 * boring, not a mock. Off entirely when `enabled` is false, which is what keeps
 * the test suite and synthetic mode timer-free.
 *
 * ## ⚠ It reads EVERY page, not the first hundred documents
 *
 * The same defect the bank feed had, from the same cause: `AppContext` asked
 * for `{ limit: 100 }` and nothing read `pageInfo`. A practice past a hundred
 * documents had the rest unreachable — and worse than a short table,
 * `DocumentsView`'s summary line, both its table footers, `InboxesView`'s item
 * count and Analytics' whole tile row are `.length` / `.filter().length` over
 * this array, so each of them silently understated the practice. See
 * `paged.ts`.
 *
 * ⚠ **The poll now costs one round trip per page.** At ID's scale that is two
 * or three requests every five seconds, which is the price of the counts being
 * true; the documented replacement for the poll is push, and it retires this
 * cost with it.
 */
export function useDocuments({ enabled, params, clientNameFor }: UseDocumentsOptions) {
  const query = useQuery({
    queryKey: ['documents', 'all', params],
    enabled,
    refetchInterval: enabled ? 5_000 : false,
    queryFn: () =>
      fetchAllPages((cursor) =>
        listDocuments({ ...params, limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) }),
      ),
  });

  const parsed = useMemo(() => {
    const empty = { documents: [] as LocalDocument[], invalid: null as string | null, truncated: false };
    if (!query.data) return empty;

    const documents: LocalDocument[] = [];
    for (const body of query.data.bodies) {
      const result = listDocumentsResponse.safeParse(body);
      if (!result.success) {
        return {
          ...empty,
          invalid: result.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
            .join('; '),
        };
      }
      for (const row of result.data.data) {
        documents.push(toLocalDocument(row as DocumentSummary, clientNameFor));
      }
    }

    return { documents, invalid: null, truncated: query.data.truncated };
  }, [query.data, clientNameFor]);

  return {
    documents: parsed.documents,
    /** Set when the server's answer did not match the contract. */
    contractError: parsed.invalid,
    /** The safety cap was reached and the server had more. Screens must SAY so. */
    truncated: parsed.truncated,
    loaded: parsed.documents.length,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}
