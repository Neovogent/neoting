import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { DocumentsView } from './DocumentsView';
import { ConfirmProvider } from '../components/DynamicComponents/ConfirmProvider';
import { AppIntlProvider } from '../i18n/AppIntlProvider';
import type { Document } from '../lib/types';

/**
 * The Documents screen is the practice's register, and the bug these tests
 * pin was real: the top-level view filtered to `status === 'published'`, so
 * every document that had actually arrived — by email, WhatsApp, the portal
 * or upload — was invisible until it was published, and a live practice saw
 * "0 archived" over an inbox full of paperwork. The default scope must list
 * EVERY state; Archive stays the published subset it always was; and in live
 * mode the only bulk actions offered are the ones with a real path behind
 * them (METH S14: a button whose write the next poll reverts is worse than
 * absent).
 */

const doc = (over: Partial<Document> & Pick<Document, 'id' | 'supplier' | 'status'>): Document => ({
  clientId: '1',
  clientName: 'Sparkle Cleaning Ltd',
  date: '10 Aug 2026',
  total: 120,
  category: 'Cleaning supplies',
  source: 'email',
  uploader: 'receipt.jpg',
  currency: 'GBP',
  kind: 'cost',
  fields: [],
  lineItems: [],
  ...over,
});

const DOCS: Document[] = [
  doc({ id: 'doc_1', supplier: 'Bidfood', status: 'processing', source: 'email' }),
  doc({ id: 'doc_2', supplier: 'Currys', status: 'review', source: 'whatsapp' }),
  doc({ id: 'doc_3', supplier: 'Screwfix', status: 'published', source: 'portal' }),
];

const CLIENTS = [{ id: '1', name: 'Sparkle Cleaning Ltd' }];

let ctx: Record<string, unknown>;

const baseCtx = (): Record<string, unknown> => ({
  documents: DOCS,
  vault: [],
  clients: CLIENTS,
  updateDocumentStatus: vi.fn(),
  moveDocuments: vi.fn(),
  deleteDocuments: vi.fn(),
  addVaultDocument: vi.fn(),
  updateVaultDocument: vi.fn(),
  deleteVaultDocument: vi.fn(),
  moveVaultDocument: vi.fn(),
  logAudit: vi.fn(),
  documentsSource: 'seed',
  documentsLoading: false,
  documentsError: null,
  refetchDocuments: vi.fn(),
  slices: { documents: { source: 'seed', loading: false, error: null } },
  settings: { practiceName: 'Test Practice' },
  isSameClient: (a: string, b: string) => a === b,
  serverClientIdFor: (id: string) => `biz_${id}`,
  clientNameFor: (id: string) => id,
});

vi.mock('../context/AppContext', () => ({
  useAppContext: () => ctx,
}));

beforeEach(() => {
  ctx = baseCtx();
});

function renderView() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return render(
    <AppIntlProvider>
      <QueryClientProvider client={queryClient}>
        {/* The real provider, not the context default — which resolves `true`
            immediately and would let a delete test pass without ever meeting
            the confirmation whose WORDING is half of what is under test. */}
        <ConfirmProvider>
          <DocumentsView />
        </ConfirmProvider>
      </QueryClientProvider>
    </AppIntlProvider>,
  );
}

test('the default scope lists every document, whatever its state — not only the published ones', () => {
  renderView();

  // The regression this screen shipped with: only `published` rendered, so a
  // document that had just arrived by email or WhatsApp was invisible here.
  // (getAllBy*: the DataTable keeps both its card and table layouts in the
  // DOM and lets the container query choose, so each cell appears twice.)
  expect(screen.getAllByText('Bidfood').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Currys').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Screwfix').length).toBeGreaterThan(0);

  // Each row says which state it is actually in.
  expect(screen.getAllByText('Processing').length).toBeGreaterThan(0);
  expect(screen.getAllByText('To review').length).toBeGreaterThan(0);
});

test('the counts line reports the whole register, truthfully, and Trash is one of the counts', () => {
  renderView();
  // Synthetic: the seeded arrays really are every document, so the counts are
  // derived here. Live they come from `GET /documents/counts` — see the note in
  // the view, and `api/document-lifecycle.ts`.
  expect(screen.getByText('3 documents · 1 archived · 0 in vault · 0 expiring · 0 in Trash')).toBeTruthy();
});

test('the Archive scope still lists only published documents', () => {
  renderView();
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

  expect(screen.getAllByText('Screwfix').length).toBeGreaterThan(0);
  expect(screen.queryAllByText('Bidfood')).toHaveLength(0);
  expect(screen.queryAllByText('Currys')).toHaveLength(0);
});

test('an empty register teaches where documents come from, not "nothing archived"', () => {
  ctx.documents = [];
  renderView();

  expect(screen.getAllByText(/No documents yet/).length).toBeGreaterThan(0);
  expect(screen.queryAllByText(/Nothing archived yet/)).toHaveLength(0);
});

test('every bulk action has a real path in BOTH modes — Delete included, now that it has an endpoint', () => {
  const { unmount } = renderView();

  // Seed data: the local writers are the source of truth, so they are offered.
  expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Move to client' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Export CSV' })).toBeTruthy();
  unmount();

  // ⚠ Live, Delete used to be HIDDEN, and the comment said why: "no delete
  // endpoint exists, so live the row would only come back with the next poll"
  // (METH S14). `POST …/deletion` exists now, so the S14 rule is satisfied by
  // giving the button a real path instead of by hiding it — the poll reverts
  // nothing, because the server stops listing the row and the Trash starts.
  ctx = { ...baseCtx(), documentsSource: 'api' };
  renderView();
  expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Move to client' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Export CSV' })).toBeTruthy();
});

/**
 * ⚠ **The reported bug: "Move to client and Export CSV are both greyed out."**
 *
 * They were disabled because NOTHING WAS SELECTED — every bulk action needs at
 * least one row, and Export needs two — and the only explanation on offer was a
 * hover `title`, invisible on a phone and unfindable on a desktop. Neither was
 * ever gated by live mode. The fix is to say so where a person reads it.
 */
test('an untouched screen says WHY the bulk actions are off, and names the shift-click range', () => {
  renderView();

  expect(screen.getByRole('button', { name: 'Move to client' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Export CSV' }).hasAttribute('disabled')).toBe(true);

  expect(
    screen.getAllByText(
      'Nothing is selected. Tick a row to act on it — or tick one and shift-click another to take the range.',
    ).length,
  ).toBeGreaterThan(0);
});

test('selecting a row enables the actions that only need one, and the hint goes', () => {
  renderView();
  fireEvent.click(screen.getAllByRole('button', { pressed: false })[0]!);

  expect(screen.getByRole('button', { name: 'Move to client' }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('button', { name: 'Delete' }).hasAttribute('disabled')).toBe(false);
  expect(screen.queryAllByText(/Nothing is selected/)).toHaveLength(0);
  // Export still needs two, and now says which action is short and why.
  expect(screen.getByRole('button', { name: 'Export CSV' }).hasAttribute('disabled')).toBe(true);
});

test('shift-clicking a second checkbox takes the whole range, and never un-selects half of it', async () => {
  const { taken, restore } = captureDownloads();
  try {
    renderView();
    // The card layout and the table layout are both in the DOM, so the first
    // three unchecked boxes are the table's header-less rows in order.
    const boxes = screen.getAllByRole('button', { pressed: false });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[2]!, { shiftKey: true });

    // Three rows selected from two clicks — proved through the export, which is
    // the only surface that reports exactly which rows an action received.
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    const csv = await csvOf(taken[0]!.blob);
    expect(csv).toContain('"Bidfood"');
    expect(csv).toContain('"Currys"');
    expect(csv).toContain('"Screwfix"');
  } finally {
    restore();
  }
});

/* ── Trash ────────────────────────────────────────────────────────────────── */

test('⚠ the delete confirmation says it goes to Trash and is restorable — never an irreversible warning', async () => {
  renderView();
  fireEvent.click(screen.getAllByRole('button', { pressed: false })[0]!);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

  expect(await screen.findByText('Move 1 document to Trash?')).toBeTruthy();
  expect(document.body.textContent).toContain('Nothing is lost — you can restore any of them from there.');
  // The button says where it goes. A reversible act dressed as an irreversible
  // one is how people learn to click through the warning that matters.
  expect(screen.getByRole('button', { name: 'Move to Trash' })).toBeTruthy();
  // Scoped to the dialog, and the assertion is about what it CLAIMS: no
  // irreversibility, no destruction, no "permanently" — over an act that is
  // none of those. The one mention of deleting for good is the sentence that
  // separates this act from that one, which is the opposite of a scare.
  const dialog = screen.getByRole('dialog').textContent ?? '';
  expect(dialog).not.toMatch(/cannot be undone/i);
  expect(dialog).not.toMatch(/permanent/i);
  expect(dialog).not.toMatch(/destroy/i);
  expect(dialog).toContain('Deleting for good is a separate, approved step.');
});

test('a deleted document leaves the register, appears in Trash, and comes back on Restore', async () => {
  renderView();

  fireEvent.click(screen.getAllByRole('button', { pressed: false })[0]!);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Move to Trash' }));

  // Off the register…
  await screen.findByText('2 documents · 1 archived · 0 in vault · 0 expiring · 1 in Trash');
  expect(screen.queryAllByText('Bidfood')).toHaveLength(0);

  // …and in the Trash, which says what it is for.
  fireEvent.click(screen.getByRole('button', { name: 'Trash' }));
  expect(screen.getAllByText('Bidfood').length).toBeGreaterThan(0);

  fireEvent.click(screen.getAllByRole('button', { pressed: false })[0]!);
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

  await screen.findByText('3 documents · 1 archived · 0 in vault · 0 expiring · 0 in Trash');
  fireEvent.click(screen.getByRole('button', { name: 'All documents' }));
  expect(screen.getAllByText('Bidfood').length).toBeGreaterThan(0);
});

test('an empty Trash teaches what it is for, rather than saying "nothing here"', () => {
  renderView();
  fireEvent.click(screen.getByRole('button', { name: 'Trash' }));

  expect(screen.getAllByText(/The Trash is empty/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/can be restored until somebody deletes it for good/).length).toBeGreaterThan(0);
});

/**
 * Capture what the browser was asked to download. `URL.createObjectURL` does
 * not exist in jsdom and the anchor click is a no-op, so both are stubbed —
 * what is under test is the NAME on the file and the columns inside it, which
 * is where the register's export was lying.
 */
function captureDownloads() {
  const taken: { name: string; blob: Blob }[] = [];
  let pending: Blob | null = null;
  const url = URL as unknown as { createObjectURL: unknown; revokeObjectURL: unknown };
  url.createObjectURL = (blob: Blob) => {
    pending = blob;
    return 'blob:test';
  };
  url.revokeObjectURL = () => undefined;
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      if (pending !== null) taken.push({ name: this.download, blob: pending });
      pending = null;
    });
  return { taken, restore: () => click.mockRestore() };
}

const csvOf = async (blob: Blob) => new TextDecoder().decode(await blob.arrayBuffer());

/** Tick the first two row checkboxes — unlabelled `aria-pressed` buttons. */
function selectTwoRows() {
  const boxes = screen.getAllByRole('button', { pressed: false });
  fireEvent.click(boxes[0]!);
  fireEvent.click(boxes[1]!);
}

test('⚠ the register exports `documents.csv` with a Status column — never `archive.csv` over unpublished rows', async () => {
  const { taken, restore } = captureDownloads();
  try {
    renderView();
    // Bidfood is `processing` and Currys is `review`: neither has been
    // published, released, or seen by the export screen.
    selectTwoRows();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(taken).toHaveLength(1);
    // The bug: this file was called `archive.csv`, which says these rows were
    // published and released for export. `ExportView` is the only surface that
    // may claim that, and it serves Published only (D42/D43).
    expect(taken[0]!.name).toBe('documents.csv');

    const csv = await csvOf(taken[0]!.blob);
    expect(csv.split('\n')[0]).toBe('Client,Supplier,Date,Category,Status,Source,Uploader,Currency,Total');
    // …and each row carries the state it is actually in, so the file cannot be
    // read as evidence of anything it is not.
    expect(csv).toContain('"processing"');
    expect(csv).toContain('"review"');
  } finally {
    restore();
  }
});

test('the Archive export keeps `archive.csv`, because there the name is true', async () => {
  ctx.documents = [
    doc({ id: 'doc_3', supplier: 'Screwfix', status: 'published' }),
    doc({ id: 'doc_4', supplier: 'Toolstation', status: 'published' }),
  ];
  const { taken, restore } = captureDownloads();
  try {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    selectTwoRows();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(taken).toHaveLength(1);
    expect(taken[0]!.name).toBe('archive.csv');
    // Same function, same columns — the two doors differ only in the name,
    // which is the whole point of the rule.
    expect(await csvOf(taken[0]!.blob)).toContain('"published"');
  } finally {
    restore();
  }
});

test('a supplier name with a quote in it does not break the file into extra columns', async () => {
  ctx.documents = [
    doc({ id: 'doc_1', supplier: 'Bob "Bobby" Ltd', status: 'processing' }),
    doc({ id: 'doc_2', supplier: 'Currys', status: 'review' }),
  ];
  const { taken, restore } = captureDownloads();
  try {
    renderView();
    selectTwoRows();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await csvOf(taken[0]!.blob)).toContain('"Bob ""Bobby"" Ltd"');
  } finally {
    restore();
  }
});

test('a search that matches nothing says so instead of implying an empty practice', () => {
  renderView();
  fireEvent.change(screen.getByPlaceholderText('Search every document…'), { target: { value: 'zzz' } });

  expect(screen.getAllByText('No documents match that phrase.').length).toBeGreaterThan(0);
});
