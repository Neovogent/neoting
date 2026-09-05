import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { InboxesView } from './InboxesView';
import { AppIntlProvider } from '../i18n/AppIntlProvider';
import type { Document } from '../lib/types';

/**
 * The Received-via column (review item 60's follow-up) with item 21's honest
 * words: the board must say where each document came from, in the same
 * vocabulary as the client's Costs tab — "Client portal" for a signed-in
 * upload, "Chase link" for a chase-link one, the accountant by name for a
 * manual entry — and never the raw `sms-link` slug, because ID sends no SMS
 * (launch M8) and the slug was the reported lie.
 */

const doc = (over: Partial<Document> & { id: string }): Document => ({
  clientId: '1',
  clientName: 'American Burger Ltd',
  supplier: 'Bidfood UK',
  date: '12 Aug 2026',
  total: 142.5,
  category: 'Cost of Sales Food',
  status: 'review',
  source: 'email',
  uploader: 'bidfood-uk.pdf',
  currency: 'GBP',
  kind: 'cost',
  fields: [],
  lineItems: [],
  ...over,
});

const DOCUMENTS: Document[] = [
  // A signed-in client-portal upload — the split's direct half.
  doc({ id: 'd1', supplier: 'Aldgate Meats', source: 'portal' }),
  // A chase-link upload — the only row allowed to say "Chase link".
  doc({ id: 'd2', supplier: 'Currys', source: 'sms-link' }),
  // The accountant's own manual entry names the person (item 62).
  doc({ id: 'd3', supplier: 'Paper Receipt Ltd', source: 'web', submitterLabel: 'Uploaded by Priya Shah' }),
];

vi.mock('../context/AppContext', () => ({
  useAppContext: () => ({
    documents: DOCUMENTS,
    clients: [],
    duplicates: [],
    transactions: [],
    ingest: () => ({ documents: [], imports: [] }),
    sheetImports: [],
    mandatoryFields: [],
    setMandatoryFields: () => undefined,
    ingestRejections: [],
    updateDocumentStatus: () => undefined,
    documentsSource: 'seed',
    documentsLoading: false,
    documentsError: null,
    moveDocuments: () => undefined,
    deleteDocuments: () => undefined,
    retryDocument: () => undefined,
    startConversation: () => undefined,
    logAudit: () => undefined,
    publishDocuments: () => undefined,
    isSameClient: (a: string, b: string) => a === b,
    serverClientIdFor: (id: string) => id,
  }),
}));

function renderView() {
  return render(
    <AppIntlProvider>
      <QueryClientProvider client={new QueryClient()}>
        <InboxesView />
      </QueryClientProvider>
    </AppIntlProvider>,
  );
}

describe('the Received-via column', () => {
  it('exists on the board and says the honest words for each door — never the raw slug, never SMS', () => {
    renderView();

    // The column header (desktop table). The phone cards carry the same words
    // inline, so every assertion below uses getAllByText.
    expect(screen.getAllByText('Received via').length).toBeGreaterThan(0);

    expect(screen.getAllByText('Client portal').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Chase link').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Uploaded by Priya Shah').length).toBeGreaterThan(0);

    // The raw slug and any SMS claim are exactly what item 21 reported.
    expect(screen.queryByText('sms-link')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bSMS\b/i);
  });
});
