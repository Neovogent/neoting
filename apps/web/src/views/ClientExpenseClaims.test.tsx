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

vi.mock('../context/AppContext', () => ({
  useAppContext: () => ({
    expenseClaims,
    saveExpenseClaim,
    setExpenseClaimStatus,
    deleteExpenseClaim,
    ingest,
    documents: [RECEIPT],
    documentsSource,
    slices: { expenseClaims: SEED_SLICE },
  }),
}));

beforeEach(() => {
  documentsSource = 'seed';
  expenseClaims = [CLAIM];
});

afterEach(() => vi.clearAllMocks());

function renderTab() {
  return render(
    <AppIntlProvider>
      <ClientExpenseClaims client={CLIENT} />
    </AppIntlProvider>,
  );
}

// ── Live: the surface says it is not connected, and asserts nothing else ────

test('⚠ live, nothing on the tab claims to know what is or is not owed', () => {
  documentsSource = 'api';
  // What the live array actually is: `SYNTHETIC ? seedExpenseClaims : []`.
  expenseClaims = [];
  renderTab();

  const text = document.body.textContent ?? '';
  for (const forbidden of [
    /Nothing is currently owed/i,
    /owed back/i,
    /waiting on you/i,
    /No claims for/i,
  ]) {
    expect(text).not.toMatch(forbidden);
  }
  // No money at all: a total, a claim line or a threshold would all be an
  // assertion about a client's records made out of an empty array.
  expect(text).not.toMatch(/£/);
});

test('live, the tab states that the surface is not connected to the API', () => {
  documentsSource = 'api';
  expenseClaims = [];
  renderTab();

  const text = document.body.textContent ?? '';
  expect(text).toContain('not connected to the API');
  expect(text).toContain('American Burger Ltd');
  expect(text).toMatch(/unavailable/i);
});

test('live, every writer is unreachable rather than appearing to work', () => {
  documentsSource = 'api';
  expenseClaims = [];
  renderTab();

  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('button', { name: /New claim/ })).toBeNull();
  expect(saveExpenseClaim).not.toHaveBeenCalled();
  expect(setExpenseClaimStatus).not.toHaveBeenCalled();
  expect(deleteExpenseClaim).not.toHaveBeenCalled();
});

test('⚠ live, a seeded claim is never rendered even if one is somehow in the array', () => {
  // Belt and braces on the M2 rule: nothing degrades to the synthetic rows.
  documentsSource = 'api';
  expenseClaims = [CLAIM];
  renderTab();

  expect(screen.queryByText('John Doe')).toBeNull();
  expect(document.body.textContent).not.toContain('Replacement till rolls');
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
