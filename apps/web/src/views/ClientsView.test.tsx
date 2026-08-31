import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { ClientsView } from './ClientsView';
import { AppIntlProvider } from '../i18n/AppIntlProvider';
import type { ClientStats } from '../lib/selectors';

/**
 * The Clients board carries NO remove affordance, and that is a DESIGN
 * DECISION, not an omission (31 Aug 2026): "to delete, the accountant firm
 * needs to go to the client and the Settings tab, not the front card."
 * Removal lives on ClientDetailView's Settings tab (`OffboardClientDialog`),
 * and these tests pin the board's half of that decision — someone re-adding a
 * quiet bin icon to the card footer or a trailing table column should meet a
 * red test naming the decision, not a green run.
 */

const STATS: ClientStats = {
  missing: 0,
  requested: 0,
  overdue: 0,
  unmatched: 0,
  statementGaps: 0,
  toReview: 0,
  ready: 0,
  processing: 0,
  rejected: 0,
  published: 0,
  duplicates: 0,
  approvals: 0,
  unverified: 0,
  health: 92,
  itemDelay: 0,
};

const CLIENTS = [
  { id: 'biz_sparkle', name: 'Sparkle Cleaning Ltd', industry: 'Cleaning', health: 92, missingDocs: 0, toReview: 0, deadline: '7 Sep 2026', bankConnected: true },
  { id: 'biz_ananda', name: 'Ananda Group', industry: 'Hospitality', health: 88, missingDocs: 0, toReview: 0, deadline: '14 Sep 2026', bankConnected: true },
];

vi.mock('../context/AppContext', () => ({
  useAppContext: () => ({
    clients: CLIENTS,
    statsFor: () => STATS,
    openClient: vi.fn(),
    starredClientIds: [],
    toggleStarClient: vi.fn(),
    startConversation: vi.fn(),
  }),
}));

function renderView() {
  return render(
    <AppIntlProvider>
      <ClientsView />
    </AppIntlProvider>,
  );
}

test('the card grid carries no remove affordance — removal lives on the client Settings tab', () => {
  renderView();

  // Neither the live title, the seed-mode title, nor any remove-shaped control.
  expect(screen.queryByTitle(/remove/i)).toBeNull();
  expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
});

test('the table view carries no remove affordance either', () => {
  renderView();
  fireEvent.click(screen.getByRole('button', { name: 'Table' }));

  expect(screen.getByRole('table')).toBeTruthy();
  expect(screen.queryByTitle(/remove/i)).toBeNull();
  expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
});
