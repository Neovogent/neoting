import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NtProblemError } from '@neoting/contracts';

import { ExportView } from './ExportView';
import { AppIntlProvider } from '../i18n/AppIntlProvider';
import { requestExport, useExportHistory, type Export } from '../api/exports';

/**
 * The export screen (launch stage A9).
 *
 * Two of these tests are about **copy**, and they are the point of the file:
 * D42 says no surface may imply a ledger was written to, and the only mechanical
 * way to hold that is to read the rendered text and refuse the words. Everything
 * else here is the four states and the batch cap.
 */

vi.mock('../api/config', () => ({ API_ENABLED: true }));

vi.mock('../api/exports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/exports')>();
  return { ...actual, requestExport: vi.fn(), useExportHistory: vi.fn() };
});

const BUSINESSES = [
  { id: 'biz_1', name: 'Sparkle Cleaning Ltd' },
  { id: 'biz_2', name: 'Ananda Group' },
];

let sessionStatus: 'authenticated' | 'unauthenticated' = 'authenticated';

vi.mock('../context/AppContext', () => ({
  useAppContext: () => ({
    session: sessionStatus === 'authenticated' ? { status: 'authenticated', me: {} } : { status: 'unauthenticated' },
    businesses: BUSINESSES,
  }),
}));

const EXPORT: Export = {
  id: 'exp_1',
  businessId: 'biz_1',
  target: 'VT_TRANSACTION_PLUS',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  rowCount: 12,
  documentCount: 11,
  state: 'succeeded',
  file: {
    url: 'https://storage.test/vt.csv?sig=x',
    expiresAt: '2026-02-01T09:40:00.000Z',
    mimeType: 'text/csv',
    byteSize: 900,
    filename: 'vt-transaction-plus-2026-01-01-to-2026-01-31.csv',
  },
  bundle: {
    url: 'https://storage.test/bundle.zip?sig=x',
    expiresAt: '2026-02-01T09:40:00.000Z',
    mimeType: 'application/zip',
    byteSize: 40_000,
    filename: 'source-documents-2026-01-01-to-2026-01-31.zip',
  },
  warnings: [
    {
      documentId: 'doc_9',
      code: 'analysis-collapsed',
      message: 'VT accepts one nominal per row, so this document was exported against "Purchases" for its full net.',
    },
  ],
  createdAt: '2026-02-01T09:30:00.000Z',
  completedAt: '2026-02-01T09:30:02.000Z',
};

const refetch = vi.fn();

function history(over: Partial<ReturnType<typeof useExportHistory>> = {}) {
  vi.mocked(useExportHistory).mockReturnValue({
    exports: [],
    contractError: null,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch,
    ...over,
  } as unknown as ReturnType<typeof useExportHistory>);
}

beforeEach(() => {
  sessionStatus = 'authenticated';
  history();
  vi.mocked(requestExport).mockResolvedValue(EXPORT);
});

afterEach(() => vi.clearAllMocks());

function renderView() {
  return render(
    <AppIntlProvider>
      <ExportView />
    </AppIntlProvider>,
  );
}

function pickClient(value = 'biz_1') {
  fireEvent.change(screen.getByLabelText('Client'), { target: { value } });
}

async function pressExport() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Export for VT/ }));
  });
}

// ── D42: what the screen is allowed to say ──────────────────────────────────

test('the surface is named "Export" — format-neutral, the dropdown names VT — and states what Published means', () => {
  renderView();

  expect(screen.getByRole('heading', { name: 'Export' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Export for VT/ })).toBeTruthy();
  expect(document.body.textContent).toContain('approved and released for export');
  expect(document.body.textContent).toContain('Nothing leaves Neo Accounting on its own');
});

test('⚠ D42: nothing rendered implies anything was transmitted to a ledger', async () => {
  // The forbidden vocabulary, from CLAUDE.md and the launch plan's rule 9.
  // Read off the DOM rather than off the source, so an imported component that
  // says one of these fails here too.
  history({ exports: [EXPORT] });
  renderView();
  pickClient();
  await pressExport();

  const text = document.body.textContent ?? '';
  for (const forbidden of [
    /send(ing)? to VT/i,
    /sent to VT/i,
    /publish(ing|ed)? to/i,
    /\bsync(ed|ing)?\b/i,
    /\bposted to\b/i,
    /\bXero\b/i,
    /\bQuickBooks\b/i,
    /connect(ed|ion)? to VT/i,
  ]) {
    expect(text).not.toMatch(forbidden);
  }
  // And the honest instruction is present: the human does the importing.
  expect(text).toContain('Universal Input Sheet');
});

// ── the batch cap ───────────────────────────────────────────────────────────

test('the batch cap is on the form before anyone hits it', () => {
  renderView();
  expect(document.body.textContent).toContain('Up to 500 documents per export');
});

test('hitting the cap shows the server’s own NT-EXP-003 and the one action that fixes it', async () => {
  vi.mocked(requestExport).mockRejectedValue(
    new NtProblemError({
      status: 422,
      code: 'NT-EXP-003',
      title: 'Export too large',
      detail: 'An export carries at most 500 documents at a time and this period has more.',
    }),
  );
  renderView();
  pickClient();
  await pressExport();

  const text = document.body.textContent ?? '';
  // The NT- code stays in front of the words.
  expect(text).toContain('NT-EXP-003');
  expect(text).toContain('at most 500 documents');
  expect(text).toContain('Export it a month at a time');
  // Nothing pretends a file exists.
  expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
});

test('any other refusal is shown with its code, and no download is offered', async () => {
  vi.mocked(requestExport).mockRejectedValue(
    new NtProblemError({
      status: 422,
      code: 'NT-EXP-001',
      title: 'Nothing to export',
      detail: 'No documents reached Published in 01/01/2026 to 31/01/2026 for this client.',
    }),
  );
  renderView();
  pickClient();
  await pressExport();

  expect(document.body.textContent).toContain('NT-EXP-001');
  expect(document.body.textContent).toContain('01/01/2026 to 31/01/2026');
  expect(document.body.textContent).not.toContain('Export it a month at a time');
  expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
});

// ── the success state ───────────────────────────────────────────────────────

test('a finished export offers both downloads, the counts and what did not travel', async () => {
  renderView();
  pickClient();
  await pressExport();

  expect(vi.mocked(requestExport).mock.calls[0]?.[0]).toMatchObject({
    businessId: 'biz_1',
    target: 'VT_TRANSACTION_PLUS',
  });

  const file = screen.getByRole('link', { name: 'Download VT import file' }) as HTMLAnchorElement;
  const bundle = screen.getByRole('link', { name: /Download source documents/ }) as HTMLAnchorElement;
  expect(file.href).toBe(EXPORT.file?.url);
  expect(bundle.href).toBe(EXPORT.bundle?.url);
  // The signed URL is bearer authority over a month of someone's books; it must
  // not travel in a Referer.
  expect(file.rel).toContain('noreferrer');
  expect(bundle.rel).toContain('noreferrer');

  const text = document.body.textContent ?? '';
  expect(text).toContain('12 rows in the import file');
  expect(text).toContain('11 source documents in the bundle');
  expect(text).toContain('1 thing did not travel');
  expect(text).toContain('one nominal per row');
  expect(text).toContain('Nothing was dropped silently');
});

test('the period defaults to a whole calendar month, sent as ISO and shown as ISO in the picker', async () => {
  renderView();
  const from = screen.getByLabelText('From') as HTMLInputElement;
  const to = screen.getByLabelText('To') as HTMLInputElement;

  expect(from.value).toMatch(/^\d{4}-\d{2}-01$/);
  expect(to.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  pickClient();
  await pressExport();
  expect(vi.mocked(requestExport).mock.calls[0]?.[0]).toMatchObject({
    periodStart: from.value,
    periodEnd: to.value,
  });
});

// ── the other three states ──────────────────────────────────────────────────

test('with no client chosen the button is unreachable — an export is one client at a time', () => {
  renderView();
  expect(screen.getByRole('button', { name: /Export for VT/ })).toHaveProperty('disabled', true);
});

test('the empty history teaches the next action rather than showing a blank box', () => {
  renderView();
  pickClient();
  expect(document.body.textContent).toContain('Nothing has been exported for this client yet');
});

test('history that failed to load says so, with the code and a retry — never silently empty', () => {
  history({ error: new NtProblemError({ status: 500, code: 'NT-SRV-001', title: 'Something went wrong' }) });
  renderView();
  pickClient();

  expect(document.body.textContent).toContain('Export history could not be loaded');
  expect(document.body.textContent).toContain('NT-SRV-001');
  expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
});

test('history rows read as UK d/m/y, and offer no dead download link', () => {
  history({ exports: [EXPORT] });
  renderView();
  pickClient();

  expect(document.body.textContent).toContain('01/01/2026 to 31/01/2026');
  expect(document.body.textContent).toContain('12 rows');
  expect(document.body.textContent).toContain('Download links are short-lived');
});

test('without a live session the screen says so honestly instead of pretending it can export', () => {
  sessionStatus = 'unauthenticated';
  renderView();

  expect(document.body.textContent).toContain('running on sample data');
  expect(screen.getByRole('button', { name: /Export for VT/ })).toHaveProperty('disabled', true);
  expect((screen.getByLabelText('Client') as HTMLSelectElement).disabled).toBe(true);
});
