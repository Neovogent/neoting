import { useMemo } from 'react';
import { useListDocuments } from '@neoting/contracts/client';
import { listDocumentsResponse } from '@neoting/contracts/zod';
import type { DocumentSummary, ListDocumentsParams } from '@neoting/contracts/model';
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
    source: CHANNEL_TO_SOURCE[row.channel] ?? 'web',
    uploader: row.originalFilename,
    currency: row.currency ?? 'GBP',
    kind,
    fields: [],
    lineItems: [],
    splitFrom: row.parentDocumentId ? row.originalFilename : undefined,
    publishFailed: row.state === 'FAILED' ? true : undefined,
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
 * touches it. TypeScript is not a runtime gate — the types describe what the
 * server promised, and this checks what it actually sent. A contract drift
 * then surfaces here, at the boundary, with the field named, instead of as
 * `undefined is not an object` three components deep.
 */
export function useDocuments({ enabled, params, clientNameFor }: UseDocumentsOptions) {
  const query = useListDocuments(params, {
    query: { enabled },
  });

  const parsed = useMemo(() => {
    const empty = { documents: [] as LocalDocument[], invalid: null as string | null, pageInfo: null as { nextCursor?: string | null; hasMore: boolean } | null };
    if (!query.data) return empty;

    const result = listDocumentsResponse.safeParse(query.data.data);
    if (!result.success) {
      return {
        ...empty,
        invalid: result.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
          .join('; '),
      };
    }

    return {
      documents: result.data.data.map((row) => toLocalDocument(row as DocumentSummary, clientNameFor)),
      invalid: null,
      pageInfo: result.data.pageInfo,
    };
  }, [query.data, clientNameFor]);

  return {
    documents: parsed.documents,
    /** Set when the server's answer did not match the contract. */
    contractError: parsed.invalid,
    /** Taken from the validated body, not the raw union, which includes Problem. */
    pageInfo: parsed.pageInfo,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}
