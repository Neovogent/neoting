import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { DocumentState } from '@neoting/contracts/model';
import { EVERY_STATE, purgeRequestFor, trashQueryKey, useDeletedDocuments } from './document-lifecycle';

/**
 * **The Trash request, pinned where it is built.**
 *
 * ⚠ The assertion worth having here is the one the 7 Sep 2026 walkthrough
 * found by accident: `deleted=true` COMPOSES with `state`, and an omitted
 * `state` means "every state except ARCHIVED". A document archived and then
 * deleted was counted by `GET /documents/counts` (which has no state clause)
 * and listed by nothing — the screen read "1 in Trash" over an empty table.
 * There is no way to notice that from a unit test of the component; there is
 * one from a test of the request.
 */

vi.mock('@neoting/contracts/client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@neoting/contracts/client');
  return { ...actual, listDocuments: (params: Record<string, unknown>) => listDocuments(params) };
});

const listDocuments = vi.fn(async (_params: Record<string, unknown>) => ({
  status: 200,
  data: { data: [], pageInfo: { nextCursor: null, hasMore: false } },
}));

afterEach(() => listDocuments.mockClear());

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    children,
  );

test('⚠ the Trash asks for EVERY state, ARCHIVED included', async () => {
  renderHook(() => useDeletedDocuments({ enabled: true, clientNameFor: (id) => id }), { wrapper });
  await waitFor(() => expect(listDocuments).toHaveBeenCalled());

  const params = listDocuments.mock.calls[0]![0];
  expect(params['deleted']).toBe(true);
  expect(params['state']).toEqual(EVERY_STATE);
  expect(params['state']).toContain('ARCHIVED');
});

test('EVERY_STATE is read off the contract, so a new state joins the Trash on its own', () => {
  // Typed out by hand, this list would silently stop being every state the day
  // the contract grew one — and the document in the new state would be the next
  // thing nobody could find in the Trash.
  expect([...EVERY_STATE].sort()).toEqual(Object.values(DocumentState).sort());
});

test('a client-scoped Trash sends the businessId, and keys its cache apart', async () => {
  renderHook(() => useDeletedDocuments({ enabled: true, clientNameFor: (id) => id, businessId: 'biz_1' }), {
    wrapper,
  });
  await waitFor(() => expect(listDocuments).toHaveBeenCalled());

  expect(listDocuments.mock.calls[0]![0]['businessId']).toBe('biz_1');
  // Two Trash listings on one screen must not share a cache entry; invalidation
  // still targets the shared prefix, which matches both.
  expect(trashQueryKey('biz_1')).not.toEqual(trashQueryKey());
  expect(trashQueryKey('biz_1').slice(0, 2)).toEqual(trashQueryKey().slice(0, 2));
});

test('the purge request omits an empty reason rather than filing one that says nothing', () => {
  expect(purgeRequestFor('biz_1', ['doc_1'], '   ')).toEqual({
    kind: 'document.purge',
    businessId: 'biz_1',
    payload: { documentIds: ['doc_1'] },
  });
  expect(purgeRequestFor('biz_1', ['doc_1'], 'Client sent it twice').payload).toMatchObject({
    reason: 'Client sent it twice',
  });
});
