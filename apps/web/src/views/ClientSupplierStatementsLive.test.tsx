import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import ClientSupplierStatementsLive from './ClientSupplierStatementsLive';
import { AppIntlProvider } from '../i18n/AppIntlProvider';
import type { Client } from '../lib/types';
import type { LiveSupplierStatement, SupplierStatementsQuery } from '../api/supplierStatements';

/**
 * The live Supplier Statements tab (issue #318). Pinned:
 *
 * - the marks on screen are the SERVER's outcomes, one pill per outcome, and
 *   the totals are the server's — nothing is re-derived from the lines;
 * - a failed read says so and offers a retry, never an empty "reconciled";
 * - the empty state says the truth about what this screen can and cannot do;
 * - there is no Upload, Remove or Chase control — none has a server path.
 */

const mocks = vi.hoisted(() => ({
  query: { value: {} as SupplierStatementsQuery },
  refetch: vi.fn(),
}));

vi.mock('../api/supplierStatements', () => ({ useSupplierStatements: () => mocks.query.value }));

const client = { id: 'biz_cosmo', name: 'Ananda Group' } as Client;

const brakes: LiveSupplierStatement = {
  id: 'sst_1',
  businessId: 'biz_cosmo',
  supplier: 'Brakes',
  documentId: 'doc_statement',
  fileName: 'brakes-statement-aug-2026.pdf',
  statementEndDate: '04 Sep 2026',
  outstandingBalance: 4860.3,
  lines: [
    { id: 'ssl_2', reference: 'BRK-551876', date: '27 Aug 2026', amount: 842.15, outcome: 'MISSING', matchedDocumentId: null },
    { id: 'ssl_1', reference: 'BRK-551204', date: '31 Aug 2026', amount: 2140.75, outcome: 'MATCHED', matchedDocumentId: 'doc_brakes' },
    { id: 'ssl_3', reference: '—', date: '—', amount: null, outcome: 'UNREADABLE', matchedDocumentId: null },
  ],
  totals: {
    lineCount: 3,
    matchedCount: 1,
    missingCount: 1,
    unreadableCount: 1,
    statementTotal: 2982.9,
    matchedTotal: 2140.75,
    missingTotal: 842.15,
  },
  uploadedAt: '05 Sep 2026',
};

function renderTab(query: Partial<SupplierStatementsQuery>) {
  mocks.query.value = {
    statements: [],
    status: { source: 'api', loading: false, error: null, loaded: 0 },
    refetch: mocks.refetch,
    ...query,
  };
  return render(
    <AppIntlProvider>
      <ClientSupplierStatementsLive client={client} />
    </AppIntlProvider>,
  );
}

beforeEach(() => {
  mocks.refetch.mockReset();
});

test('renders the server’s outcomes — one pill per outcome — and the server’s totals', () => {
  renderTab({ statements: [brakes], status: { source: 'api', loading: false, error: null, loaded: 1 } });

  expect(screen.getByText('Brakes')).toBeInTheDocument();
  expect(screen.getByText('1 missing invoice')).toBeInTheDocument();
  expect(screen.getByText('1 line could not be read')).toBeInTheDocument();
  expect(screen.getByText('£2,982.90')).toBeInTheDocument();
  expect(screen.getByText('1 of 3 matched · £842.15 missing')).toBeInTheDocument();
  expect(screen.getByText('Supplier says £4,860.30 outstanding')).toBeInTheDocument();
  expect(screen.getByText(/1 line have no document/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Show every line here' }));
  expect(screen.getByText('On file')).toBeInTheDocument();
  expect(screen.getByText('No document')).toBeInTheDocument();
  expect(screen.getByText('Amount not read')).toBeInTheDocument();
  expect(screen.getByText('Amount unknown')).toBeInTheDocument();
  expect(screen.getByText('BRK-551204')).toBeInTheDocument();
});

test('a statement with every line answered reads as fully reconciled', () => {
  const reconciled: LiveSupplierStatement = {
    ...brakes,
    lines: [brakes.lines[1]!],
    totals: { ...brakes.totals, lineCount: 1, matchedCount: 1, missingCount: 0, unreadableCount: 0, missingTotal: 0 },
  };
  renderTab({ statements: [reconciled] });
  expect(screen.getByText('Fully reconciled')).toBeInTheDocument();
  expect(screen.queryByText(/missing invoice/)).toBeNull();
  expect(screen.getByText(/Every line is answered by a document/)).toBeInTheDocument();
});

test('a failed read says so and offers a retry — never an empty list dressed as reconciled', () => {
  renderTab({ status: { source: 'error', loading: false, error: 'NT-SRV-001 — the server erred' } });
  expect(screen.getByText(/could not be read/)).toBeInTheDocument();
  expect(screen.getByText('NT-SRV-001 — the server erred')).toBeInTheDocument();
  expect(screen.queryByText(/No supplier statements on file/)).toBeNull();

  fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!);
  expect(mocks.refetch).toHaveBeenCalled();
});

test('the empty state names the client and says uploading is not available here yet', () => {
  renderTab({ statements: [] });
  expect(screen.getByText(/No supplier statements on file for Ananda Group/)).toBeInTheDocument();
  expect(screen.getByText(/cannot be uploaded from this screen yet/)).toBeInTheDocument();
});

test('there is no Upload, Remove or Chase control — none has a server path', () => {
  renderTab({ statements: [brakes] });
  expect(screen.queryByRole('button', { name: /upload/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /chase/i })).toBeNull();
  expect(screen.queryByText(/418\.60/)).toBeNull();
});

test('while loading it says so rather than claiming the client has none', () => {
  renderTab({ status: { source: 'api', loading: true, error: null, loaded: 0 } });
  expect(screen.getByRole('status')).toHaveTextContent('Reading the supplier statements…');
  expect(screen.queryByText(/No supplier statements on file/)).toBeNull();
});
