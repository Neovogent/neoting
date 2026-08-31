import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { DocumentPreview } from './DocumentPreview';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import type { DocumentDetail } from '../../api/document-detail';
import type { Document } from '../../lib/types';

/**
 * The live document detail: hover provenance over the real original, the
 * honest Path-to-Ready panel, and the staged `document.update-coding`
 * proposal — the only door a state change has (Governance §10).
 */

// Live mode for the whole file: the fork inside DocumentPreview is on data
// source, and these tests are about the live branch.
vi.mock('../../api/config', () => ({
  API_ENABLED: true,
  API_MOCKED: false,
  API_BASE_URL: '',
  dataSourceLabel: () => 'live API' as const,
}));

vi.mock('../../context/AppContext', () => ({
  useAppContext: () => ({ updateDocumentField: vi.fn(), logAudit: vi.fn() }),
}));

const updateCodingProposal = vi.fn(async (_request: unknown) => {});

// The hook is replaced (each test hands it the detail it needs); the pure
// helpers — parseCodingDraft, isEditableLabel — stay real, because the staged
// proposal's payload shape is exactly what is under test.
let detail: DocumentDetail;
vi.mock('../../api/document-detail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/document-detail')>();
  return {
    ...actual,
    useDocumentDetail: () => detail,
    updateCodingProposal: (request: unknown) => updateCodingProposal(request as never),
    refreshDocument: vi.fn(async () => {}),
  };
});

afterEach(() => vi.clearAllMocks());

const LONG_DESCRIPTION =
  'Microsoft 365 Business Standard - Annual Subscription (May 12, 2025 – May 11, 2026)';

const doc: Document = {
  id: 'doc_f404e752a4fbb629b203dc04',
  clientId: 'biz_burger',
  clientName: 'American Burger',
  supplier: 'Nexora Solutions LLC',
  date: '12 May 2025',
  total: 54352.51,
  category: '—',
  status: 'review',
  source: 'web',
  uploader: 'Shakib',
  currency: 'USD',
  kind: 'cost',
  fields: [],
  lineItems: [],
};

function liveDetail(over: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    fields: [
      { label: 'Supplier', value: 'Nexora Solutions LLC', confidence: 0.95, provenance: 'AI suggested: bedrock' },
      // Blank provenance on purpose: the caption must fall back honestly.
      { label: 'Total', value: '£54,352.51', confidence: 0.93, provenance: '  ' },
      { label: 'Category', value: '—', confidence: 1, provenance: 'AI suggested: extraction' },
    ],
    lineItems: [{ description: LONG_DESCRIPTION, quantity: 150, total: 22500, tax: 0 }],
    state: 'TO_REVIEW',
    businessId: 'biz_burger',
    isLoading: false,
    contractError: null,
    image: { url: 'https://example.test/original.png', mimeType: 'image/png', filename: 'invoice.png' },
    events: [],
    ...over,
  };
}

function renderPreview() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AppIntlProvider>
        <DocumentPreview document={doc} />
      </AppIntlProvider>
    </QueryClientProvider>,
  );
}

test('hovering a live field frames the whole original — never an invented position — and cites its provenance', () => {
  detail = liveDetail();
  renderPreview();

  expect(screen.queryByTestId('provenance-band')).toBeNull();

  // mouseOver bubbles, so React derives the row's onMouseEnter from it.
  fireEvent.mouseOver(screen.getByText('Supplier'));

  const band = screen.getByTestId('provenance-band');
  // No fabricated coordinate: over a real photograph the band is the full
  // frame, not a hash-positioned strip.
  expect(band.style.top).toBe('');
  expect(screen.getByText('AI suggested: bedrock')).toBeTruthy();
});

test('a field with no recorded provenance gets the honest fallback caption, not an empty line', () => {
  detail = liveDetail();
  renderPreview();

  fireEvent.mouseOver(screen.getByText('Total'));

  expect(screen.getByText(/its position on the page was not captured/)).toBeTruthy();
});

test('the Ready panel names the missing mandatory field and its edit stages the update-coding proposal', async () => {
  detail = liveDetail();
  renderPreview();

  // The server rule is Total + Supplier + Category; only Category is missing.
  expect(screen.getByText('Path to Ready')).toBeTruthy();
  expect(screen.getByText(/Ready needs a value for Category/)).toBeTruthy();
  expect(screen.getByText(/approving the correction that completes the set makes this document Ready/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Add Category' }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '5100' } });
  fireEvent.keyDown(input, { key: 'Enter' });

  // The staged card is the Review → Approve gate: Approve is not mounted
  // until Read review has been opened.
  expect(await screen.findByText('Update coding')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Approve change/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Read review/ }));
  fireEvent.click(screen.getByRole('button', { name: /Approve change/ }));

  expect(updateCodingProposal).toHaveBeenCalledExactlyOnceWith({
    businessId: 'biz_burger',
    documentId: 'doc_f404e752a4fbb629b203dc04',
    fields: { categoryCode: '5100' },
  });
});

test('with every required field present the panel is honest about the missing confirm path and offers no dead button', () => {
  detail = liveDetail({
    fields: [
      { label: 'Supplier', value: 'Nexora Solutions LLC', confidence: 0.95, provenance: 'AI suggested: bedrock' },
      { label: 'Total', value: '£54,352.51', confidence: 0.93, provenance: 'AI suggested: bedrock' },
      { label: 'Category', value: '5100', confidence: 1, provenance: 'human confirmed' },
    ],
  });
  renderPreview();

  expect(screen.getByText(/has no proposal path yet/)).toBeTruthy();
  // No "confirm as-is" button exists to press: the payload cannot express it
  // (equal values collapse to zero changes server-side), so a button here
  // would be a control whose write does nothing.
  expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Add / })).toBeNull();
});

test('the panel exists only for To Review documents', () => {
  detail = liveDetail({ state: 'READY' });
  renderPreview();

  expect(screen.queryByText('Path to Ready')).toBeNull();
});

test('truncated values carry their full text as titles', () => {
  detail = liveDetail();
  renderPreview();

  // Twice: the header name and the Supplier field value both truncate.
  expect(screen.getAllByTitle('Nexora Solutions LLC').length).toBeGreaterThanOrEqual(2);
  expect(screen.getByTitle(LONG_DESCRIPTION)).toBeTruthy();
});

test('no bank-match section renders — the contract exposes no match read surface to build one from', () => {
  // Survey verdict, pinned: `BankTransaction` carries `matchState` but no
  // document id, and no endpoint exposes a suggested or confirmed match for a
  // document. Until that read surface exists (G7), the preview says nothing
  // about transactions rather than fabricating a pairing.
  detail = liveDetail();
  renderPreview();

  expect(screen.queryByText(/transaction/i)).toBeNull();
});
