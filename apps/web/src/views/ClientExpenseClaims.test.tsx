import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ClientExpenseClaims } from './ClientExpenseClaims';
import { AppIntlProvider } from '../i18n/AppIntlProvider';
import { SEED_SLICE } from '../api/slices';
import type { Client, Document, ExpenseClaim } from '../lib/types';

/**
 * The expense-claims tab.
 *
 * Half of this file is a **copy** test, in the shape `ExportView.test.tsx` and
 * `SignupView.test.tsx` established: read `document.body.textContent` and
 * refuse the sentences the surface is not entitled to say. The rule here is
 * narrower than D42's but the same in kind — with the API on there is no
 * expense-claim endpoint, the context array is permanently `[]`, and the screen
 * used to read that absence as an answer and tell an accountant "Nothing is
 * currently owed" about a client whose claims nobody had ever asked for.
 *
 * The other half is the S12/S14 rule: a button whose write the next reload
 * reverts is worse than absent. Every writer on this surface is a `setState`
 * with no network call behind it, so live it must not be reachable.
 */

const CLIENT: Client = {
  id: '1',
  name: 'American Burger Ltd',
  industry: 'Hospitality',
  health: 80,
  missingDocs: 0,
  toReview: 0,
  deadline: '31 Oct 2026',
  bankConnected: false,
};

const RECEIPT: Document = {
  id: 'exp-doc-2',
  clientId: '1',
  clientName: 'American Burger Ltd',
  supplier: 'Costco',
  date: '10 Aug 2026',
  total: 62.9,
  category: 'Office Supplies',
  status: 'ready',
  source: 'whatsapp',
  uploader: 'John Doe (staff)',
  currency: 'GBP',
  kind: 'cost',
  fields: [],
  lineItems: [],
};

const CLAIM: ExpenseClaim = {
  id: 'exp-2',
  clientId: '1',
  clientName: 'American Burger Ltd',
  claimant: 'John Doe',
  period: 'August 2026',
  status: 'internally-approved',
  submittedAt: '2 days ago',
  approval: { by: 'Priya Nair', role: 'Manager', at: '1 day ago' },
  items: [
    { id: 'exp-2-a', description: 'Replacement till rolls', date: '10 Aug 2026', total: 62.9, category: 'Office Supplies', documentId: 'exp-doc-2' },
  ],
};

const saveExpenseClaim = vi.fn();
const setExpenseClaimStatus = vi.fn();
const deleteExpenseClaim = vi.fn();
const ingest = vi.fn();

let documentsSource: 'api' | 'seed' = 'seed';
let expenseClaims: ExpenseClaim[] = [];
/** Live, a claim IS a document with a claimant — so the board reads these. */
let liveDocuments: unknown[] = [];

vi.mock('../context/AppContext', () => ({
  useAppContext: () => ({
    expenseClaims,
    saveExpenseClaim,
    setExpenseClaimStatus,
    deleteExpenseClaim,
    ingest,
    documents: documentsSource === 'api' ? liveDocuments : [RECEIPT],
    documentsSource,
    isSameClient: (a: string, b: string) => a === b,
    slices: { expenseClaims: SEED_SLICE, documents: SEED_SLICE },
  }),
}));

beforeEach(() => {
  documentsSource = 'seed';
  expenseClaims = [CLAIM];
  liveDocuments = [];
});

afterEach(() => vi.clearAllMocks());

function renderTab() {
  return render(
    <AppIntlProvider>
      <ClientExpenseClaims client={CLIENT} />
    </AppIntlProvider>,
  );
}

// ── Live: real claims, read from the documents slice ───────────────────────
//
// ⚠ These four REPLACED the "not connected to the API" tests of 7 Sep 2026.
// Those were correct while nothing could read a claim, and became wrong the
// moment claims existed: they pinned a panel telling a paying accountant the
// tab does not work. A claim is a DOCUMENT with a claimant (design ⚖E), so
// there is no separate slice to wire — the board filters the one every other
// surface reads.

test('live, a claimed document is listed with WHO paid and what is owed', () => {
  documentsSource = 'api';
  liveDocuments = [
    { id: 'doc_1', clientId: CLIENT.id, supplier: 'Screwfix', displayTitle: 'Screwfix', total: 42.5, date: '10 Aug 2026', claimant: { id: 'con_1', name: 'Tom Whyte' } },
  ];
  renderTab();

  const text = document.body.textContent ?? '';
  expect(text).toContain('Screwfix');
  expect(text).toContain('Tom Whyte');
  expect(text).toContain('£42.50');
  // The old panel's sentence must be gone — it is no longer true.
  expect(text).not.toContain('not connected to the API');
});

test('⚠ live, a document with NO claimant is not a claim and never appears', () => {
  // The heart of the model: null claimant means THE COMPANY PAID. A board that
  // listed company-paid documents would say the company owes its own staff.
  documentsSource = 'api';
  liveDocuments = [
    { id: 'doc_company', clientId: CLIENT.id, supplier: 'British Gas', displayTitle: 'British Gas', total: 412.66, date: '30 Aug 2026' },
  ];
  renderTab();

  expect(document.body.textContent).not.toContain('British Gas');
  expect(document.body.textContent).not.toContain('£412.66');
});

test('live with no claims, the empty state teaches where a claim STARTS', () => {
  documentsSource = 'api';
  liveDocuments = [];
  renderTab();

  const text = document.body.textContent ?? '';
  expect(text).toMatch(/has claimed anything back/i);
  // It names the actual first step rather than stopping at "none".
  expect(text).toMatch(/portal/i);
  // And it still claims no figure it has not read.
  expect(text).not.toMatch(/£/);
});

test('live, another client’s claim is not shown on this client’s tab', () => {
  documentsSource = 'api';
  liveDocuments = [
    { id: 'doc_other', clientId: 'biz_other', supplier: 'Nisbets', displayTitle: 'Nisbets', total: 99, date: '01 Sep 2026', claimant: { id: 'con_x', name: 'Someone Else' } },
  ];
  renderTab();

  expect(document.body.textContent).not.toContain('Someone Else');
});

// ── Synthetic: the demo is exactly what it was ─────────────────────────────

test('synthetic, the seeded claim, its total and the owed figure all render', () => {
  renderTab();

  expect(screen.getByText('John Doe')).toBeTruthy();
  expect(screen.getByText('Replacement till rolls')).toBeTruthy();
  expect(document.body.textContent).toContain('£62.90 owed back');
  expect(document.body.textContent).toContain('Waiting on you');
});

test('synthetic, the writers are all present', () => {
  renderTab();

  expect(screen.getByRole('button', { name: /New claim/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Edit/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Accept for the books/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Query/ })).toBeTruthy();
});

test('synthetic with no claims, the empty state and the owed sentence are unchanged', () => {
  expenseClaims = [];
  renderTab();

  expect(document.body.textContent).toContain('Nothing is currently owed.');
  expect(document.body.textContent).toContain('No claims for American Burger Ltd');
  expect(screen.getByRole('button', { name: /New claim/ })).toBeTruthy();
});
