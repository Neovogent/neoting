import { useMemo } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import {
  deleteDocument,
  getDocumentCounts,
  listDocuments,
  restoreDocument as restoreDocumentCall,
} from '@neoting/contracts/client';
import { getDocumentCountsResponse, listDocumentsResponse } from '@neoting/contracts/zod';
import type { CreateActionProposalRequest, DocumentSummary } from '@neoting/contracts/model';
import { fetchAllPages, PAGE_LIMIT } from './paged';
import { toLocalDocument } from './documents';
import { unwrapBody } from './envelope';
import type { Document as LocalDocument } from '../lib/types';

/**
 * **Delete, Trash, restore — and the header counts.**
 *
 * Five operations the register was missing, all of them contracted:
 *
 * ```
 * POST /v1/documents/{documentId}/deletion      → soft-delete into Trash
 * POST /v1/documents/{documentId}/restoration   → restore
 * GET  /v1/documents?deleted=true               → the Trash listing
 * GET  /v1/documents/counts                     → the header's five numbers
 * document.purge (ActionProposal)               → permanent deletion
 * ```
 *
 * This module was written against those shapes before the client was generated
 * and rewired onto the generated client the moment it appeared, which is why
 * every call below is now a generated function and there is not one hand-built
 * URL left in it.
 *
 * Three rules it keeps:
 *
 * - **Zod at the boundary, the contract's own.** A deleted document is still a
 *   `DocumentSummary` — only the filter is new — so Trash rows go through
 *   `listDocumentsResponse` and `toLocalDocument` exactly as the register's do,
 *   and a drift is caught here rather than rendering as something plausible.
 * - **Every page.** A Trash that stopped at 100 would be the defect
 *   `api/paged.ts` exists to close, on the one surface where "it is not in the
 *   Trash either" is the worst possible answer.
 * - **It stays OFF the bundle floor.** Imported by the lazy `DocumentsView`
 *   chunk and the lazy purge dialog, never by `AppContext`.
 */

/** The Trash query's key — hand-rolled, the `proposals.ts` reasoning. */
export const TRASH_QUERY_KEY = ['documents', 'trash'] as const;
/** The header counts' key. Same reasoning; invalidated by every lifecycle write. */
export const COUNTS_QUERY_KEY = ['documents', 'counts'] as const;

/**
 * ⚠ `DocumentPurgePayload.documentIds.maxItems` — **100, not the house 500 the
 * reversible batches use.** The contract explains why (a purge cascades six
 * child tables per document inside one 10-second transaction, and a batch that
 * timed out would be a 500 rather than a refusal).
 *
 * It is written out here rather than read off orval's generated constant, and
 * that is deliberate. `ExportView` reads `createExportBodyDocumentIdsMax`
 * because that name is derived from the operation. The proposal payloads share
 * one `createActionProposalBody`, so orval numbers their collisions
 * POSITIONALLY — this one is `createActionProposalBodyPayloadDocumentIdsMaxFour`
 * — and a kind inserted before `document.purge` in the union would silently
 * repoint that name at another payload's **500**. A cap that quadruples itself
 * without a diff, on the one irreversible batch in the product, is worse than a
 * literal with the contract's own words next to it.
 */
export const PURGE_BATCH_MAX = 100;

/** `DocumentPurgePayload.reason.maxLength`, and `BusinessOffboardPayload`'s before it. */
export const PURGE_REASON_MAX = 500;

/**
 * Soft-delete into Trash. Reversible by construction — the server sets one
 * timestamp, keeps the row, the bytes, the extraction and the processing log,
 * and does not touch `state`, so a restored document is in the state it left.
 * That is why the confirmation in front of this says "Trash" and not
 * "permanently", and why it is a call rather than a proposal.
 *
 * Idempotent by contract: deleting something already in Trash is a `200`.
 */
export async function softDeleteDocument(documentId: string): Promise<void> {
  await deleteDocument(documentId);
}

/** Put a document back on the register. Idempotent in the same way. */
export async function restoreDocument(documentId: string): Promise<void> {
  await restoreDocumentCall(documentId);
}

/**
 * Walk a selection through one of the two, stopping at the first refusal and
 * reporting WHICH document it was. A partial batch is the honest outcome — the
 * ones that went through really did go through, and re-running the rest is the
 * accountant's call once they have read the server's reason.
 *
 * ⚠ This is the shape only because deletion and restoration are REVERSIBLE and
 * per-document. `document.purge` is the opposite and the contract says so in as
 * many words: it is all-or-nothing, because "a partially purged batch cannot be
 * re-run to completion — the successful half no longer exists". Nothing here is
 * a template for that one.
 */
export async function applyToEach(
  ids: readonly string[],
  op: (id: string) => Promise<void>,
): Promise<{ done: string[]; failedId: string | null; error: unknown }> {
  const done: string[] = [];
  for (const id of ids) {
    try {
      await op(id);
      done.push(id);
    } catch (error) {
      return { done, failedId: id, error };
    }
  }
  return { done, failedId: null, error: null };
}

/**
 * The permanent delete, as a proposal — **never a call**. There is deliberately
 * no `DELETE /documents/{documentId}` anywhere in the contract for it to hide
 * behind.
 *
 * This function builds only the request body. `LiveProposalFlow` makes the
 * create call and `LiveProposalCard` renders the server's own review, so
 * Approve is not in the DOM until `POST …/review` has returned and it echoes
 * that review's `renderedSummaryHash`.
 *
 * ⚠ **No client-side rule decides what may be purged.** The server refuses a
 * document that has been published, that has a `publishes` row, or that has any
 * `document_links` row — checked as ROWS, never inferred from `state`, because
 * D43 promises every exported line resolves back to its source and a purged
 * document would turn a live URL inside an accountant's VT file into a
 * permanent 410. The refusal is `NT-DOC-002` and it arrives with the server's
 * own sentence, which is what the screen renders. A mirror of that rule written
 * here could disagree with the one actually enforced, and the disagreement
 * would be invisible — the lesson `publishedOutsidePeriod` taught the export
 * screen.
 */
export function purgeRequestFor(
  businessId: string | null,
  documentIds: readonly string[],
  reason?: string,
): CreateActionProposalRequest {
  const trimmed = reason?.trim() ?? '';
  return {
    kind: 'document.purge',
    businessId,
    payload: {
      documentIds: [...documentIds],
      // An omitted key, never an empty string: the reason is stored on the
      // audit event and is the only surviving explanation of why a document is
      // gone. `''` would file one that says nothing.
      ...(trimmed === '' ? {} : { reason: trimmed }),
    },
  };
}

export interface UseDeletedDocumentsOptions {
  /** Off entirely on seed data. */
  enabled: boolean;
  clientNameFor: (businessId: string) => string;
}

/**
 * The Trash listing — `GET /documents?deleted=true`, every page.
 *
 * ⚠ `deleted` COMPOSES with the other filters rather than overriding them (the
 * contract's own words), so this asks for the deleted set and nothing else; the
 * screen's client/category/channel filters are applied to the rows it returns,
 * exactly as they are to the register's.
 *
 * It does NOT poll. Documents arrive from outside this browser and the register
 * watches them landing; nothing outside this browser moves a document INTO the
 * Trash, so a five-second poll here would be round trips bought for nothing.
 * Every delete and every restore invalidates the key by hand instead.
 */
export function useDeletedDocuments({ enabled, clientNameFor }: UseDeletedDocumentsOptions) {
  const query = useQuery({
    queryKey: TRASH_QUERY_KEY,
    enabled,
    queryFn: () =>
      fetchAllPages((cursor) =>
        listDocuments({ deleted: true, limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) }),
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
    /** The safety cap was reached and the server had more. The screen SAYS so. */
    truncated: parsed.truncated,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

export interface DocumentCounts {
  total: number;
  archived: number;
  deleted: number;
  inVault: number;
  expiring: number;
}

/**
 * The header's five numbers, from `GET /documents/counts`.
 *
 * ⚠ **They were not true before this endpoint existed, and the contract says
 * why**: `PageInfo` carries no total (keyset pagination has none to carry —
 * Governance §3 forbids offsets), so a browser could produce `total` only by
 * walking every page, and `archived` / `inVault` / `expiring` were derived
 * client-side from data that was never fetched. A decorative number on a screen
 * an accountant reconciles against is worse than no number. Every count here is
 * computed server-side over everything the caller's RLS context can see,
 * unbounded by any page.
 *
 * `expiringWithinDays` is passed explicitly rather than left to a server
 * default, because the screen's own "Expiring soon" filter uses fourteen days
 * and a header that counted a different window from the filter beneath it would
 * be two answers to one question.
 */
export function useDocumentCounts({ enabled, expiringWithinDays }: { enabled: boolean; expiringWithinDays: number }) {
  const query = useQuery({
    queryKey: [...COUNTS_QUERY_KEY, expiringWithinDays],
    enabled,
    queryFn: () => getDocumentCounts({ expiringWithinDays }),
  });

  const parsed = useMemo(() => {
    if (!query.data) return { counts: null as DocumentCounts | null, invalid: null as string | null };
    const result = getDocumentCountsResponse.safeParse(unwrapBody(query.data));
    if (!result.success) {
      return {
        counts: null,
        invalid: result.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
          .join('; '),
      };
    }
    const { total, archived, deleted, inVault, expiring } = result.data;
    return { counts: { total, archived, deleted, inVault, expiring }, invalid: null };
  }, [query.data]);

  return {
    counts: parsed.counts,
    contractError: parsed.invalid,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

/** Nudge the Trash listing and the header counts to re-read now. */
export async function refreshTrash(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: COUNTS_QUERY_KEY }),
  ]);
}
