import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { RemovedClientsPanel } from './RemovedClientsPanel';
import { AppIntlProvider } from '../i18n/AppIntlProvider';

/**
 * **Review item 67's third layer, and the two things it must not claim.**
 *
 * The arithmetic (days left to restore) is the only real logic on this screen,
 * and the copy around it is the only place in the product where a countdown
 * appears next to a client's name — so both are pinned. What is being defended
 * is that **nothing is erased when the window lapses**: the books stay under
 * D12's six-year clock, the workspace stays reachable by id, and only the
 * one-click Restore stops being offered. A future edit that turns the expired
 * branch into "will be deleted" fails here, naming the decision.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * MS_PER_DAY).toISOString();

let businesses: unknown[] = [];

vi.mock('../api/businesses', () => ({
  useBusinesses: () => ({
    businesses,
    contractError: null,
    truncated: false,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('../context/AppContext', () => ({
  useAppContext: () => ({ slices: { businesses: { source: 'api' } }, session: { status: 'off' }, setActiveTab: vi.fn() }),
}));

/** The flow is exercised by its own suite; here it only has to render a button. */
vi.mock('../components/DynamicComponents/LiveProposalFlow', () => ({
  LiveProposalFlow: ({ stageLabel }: { stageLabel: string }) => <button type="button">{stageLabel}</button>,
}));

const ZERO = { toReview: 0, ready: 0, failed: 0, published: 0, missing: 0, requested: 0, overdue: 0, unmatched: 0, statementGaps: 0, approvals: 0 };

beforeEach(() => {
  businesses = [];
});
afterEach(() => vi.clearAllMocks());

function renderPanel() {
  return render(
    <AppIntlProvider>
      <RemovedClientsPanel />
    </AppIntlProvider>,
  );
}

test('a client removed three days ago is offered for restore, with the days remaining', () => {
  businesses = [{ id: 'biz_1', name: 'Zeplow Ltd', offboardedAt: daysAgo(3), counts: ZERO }];
  renderPanel();

  expect(screen.getByText('Zeplow Ltd')).toBeTruthy();
  expect(screen.getByText('27 days left to restore in one click')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Restore this client' })).toBeTruthy();
});

test('⚠ past the window, the client is STILL restorable and the copy says nothing was erased', () => {
  businesses = [{ id: 'biz_1', name: 'Zeplow Ltd', offboardedAt: daysAgo(40), counts: ZERO }];
  renderPanel();

  // The one sentence that must never become a threat: the window ending is the
  // end of a convenience, not the start of a deletion.
  expect(screen.getByText('Past the 30-day window — still restorable, nothing was erased')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Restore this client' })).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/will be (deleted|erased|destroyed)/i);
});

test('a client offboarded before the column existed reads as a restore offer with no countdown', () => {
  // `offboardedAt` is null for every workspace removed before the 7 Sep 2026
  // migration. Back-dating a moment nobody recorded would be worse than saying
  // we do not have one.
  businesses = [{ id: 'biz_1', name: 'Zeplow Ltd', offboardedAt: null, counts: ZERO }];
  renderPanel();

  expect(screen.getByText('Removed before this product recorded the date')).toBeTruthy();
  expect(screen.queryByText(/left to restore/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Restore this client' })).toBeTruthy();
});

test('the intro states that removal deleted nothing, and where removal happens', () => {
  renderPanel();

  const text = document.body.textContent ?? '';
  expect(text).toContain('removal never deleted anything');
  expect(text).toContain('six-year retention requirement');
  // The empty state points at the one place a client can be removed, which is
  // deliberately not this board (31 Aug 2026).
  expect(text).toContain('that client’s own Settings tab');
});
