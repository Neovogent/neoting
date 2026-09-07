import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ClientTrashPanel } from './ClientTrashPanel';
import { AppIntlProvider } from '../i18n/AppIntlProvider';
import type { Document } from '../lib/types';

/**
 * **Review item 61 — the client's own Trash.**
 *
 * Three things are worth a test here, and they are the three that would rot
 * silently:
 *
 * 1. **The listing is SERVER-scoped to this client.** A `.filter()` over the
 *    practice-wide Trash would look identical on a seeded database and be empty
 *    for exactly the client whose Trash somebody most needs — since item 67, a
 *    removed client's documents are excluded from the un-scoped listing.
 * 2. **The retention sentence carries BOTH clauses.** Thirty days, *and* the
 *    exemption for anything already exported. Half of it is a promise the
 *    product will not keep.
 * 3. **Delete permanently is offered and explained rather than hidden** from
 *    somebody who cannot approve it (item 39's rule, `document.purge` being
 *    tier 1).
 *
 * The request itself — including the every-state filter that keeps an
 * archived-then-deleted document visible — is pinned one layer down, in
 * `api/document-lifecycle.test.ts`.
 */

const CLIENT = { id: '1', name: 'Zeplow Ltd' };

const DOC = {
  id: 'doc_1',
  clientId: '1',
  clientName: 'Zeplow Ltd',
  supplier: 'Bidfood',
  category: 'Cost of Sales',
  date: '01/09/2026',
  total: 124.5,
  status: 'review',
  kind: 'cost',
} as unknown as Document;

let deletedOptions: unknown = null;
let isOwner = true;
const restoreDocument = vi.fn(async (_id: string) => {});

vi.mock('../api/document-lifecycle', () => ({
  useDeletedDocuments: (options: unknown) => {
    deletedOptions = options;
    return {
      documents: [DOC],
      contractError: null,
      truncated: false,
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    };
  },
  restoreDocument: (id: string) => restoreDocument(id),
  applyToEach: async (ids: readonly string[], op: (id: string) => Promise<void>) => {
    for (const id of ids) await op(id);
    return { done: [...ids], failedId: null, error: null };
  },
  refreshTrash: vi.fn(async () => {}),
}));

vi.mock('../api/auth', () => ({ holdsReleaseAuthority: () => isOwner }));

vi.mock('../context/AppContext', () => ({
  useAppContext: () => ({
    session: { status: 'off' },
    clientNameFor: (id: string) => id,
    // The seed↔server id bridge: the panel must send the SERVER id.
    serverClientIdFor: (id: string) => `biz_${id}`,
    slices: { documents: { source: 'api' } },
  }),
}));

beforeEach(() => {
  deletedOptions = null;
  isOwner = true;
  restoreDocument.mockClear();
});
afterEach(() => vi.clearAllMocks());

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AppIntlProvider>
        <ClientTrashPanel client={CLIENT} />
      </AppIntlProvider>
    </QueryClientProvider>,
  );
}

test('the listing asks the SERVER for this client, through the bridged business id', () => {
  renderPanel();
  expect(deletedOptions).toMatchObject({ enabled: true, businessId: 'biz_1' });
});

test('⚠ the retention policy is stated with BOTH clauses', () => {
  renderPanel();
  const text = document.body.textContent ?? '';
  expect(text).toContain('held here for 30 days and then deleted for good');
  // The half that keeps the other half honest — D43 / NT-DOC-002.
  expect(text).toContain('Anything already exported is held indefinitely');
});

test('Restore calls the lifecycle endpoint for the selected rows', async () => {
  renderPanel();
  // Select the row, then restore it.
  fireEvent.click(screen.getAllByRole('button', { pressed: false })[0]!);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  });
  expect(restoreDocument).toHaveBeenCalledWith('doc_1');
});

test('a standard user sees Delete permanently, disabled and explained — never hidden', () => {
  isOwner = false;
  renderPanel();
  fireEvent.click(screen.getAllByRole('button', { pressed: false })[0]!);

  const purge = screen.getByRole('button', { name: /Delete permanently/ }) as HTMLButtonElement;
  expect(purge.disabled).toBe(true);
  expect(purge.title).toContain('super admin');
});
