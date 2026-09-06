import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

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
    // Review item 39: the board reads the session to decide whether Add Client
    // is this role's job at all. Mutable so one suite can render both answers;
    // 'off' is the synthetic default — every action available — which is what
    // the remove-affordance assertions above are about.
    session,
  }),
}));

/** Reassigned per test. See the item-39 block at the bottom of this file. */
let session: unknown = { status: 'off' };

const scopedColleague = {
  status: 'authenticated',
  me: {
    user: { id: 'usr_1', email: 'mubashir@ledgerline.test', firstName: 'Mubashir', lastName: 'Khan' },
    // The whole of item 39 in one field: practice staff, no practice in scope.
    practice: null,
    role: 'PRACTICE_STANDARD',
    isOwner: false,
    businesses: [],
  },
};

const practiceWide = {
  ...scopedColleague,
  me: { ...scopedColleague.me, practice: { id: 'prac_1', name: 'Ledgerline' } },
};

afterEach(() => {
  session = { status: 'off' };
  window.history.replaceState(null, '', '/clients');
});

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

/**
 * **Review item 39 — the refusal must arrive before the work, not after it.**
 *
 * > *"the standard user is being able to see the add client option after
 * > filling all the information it is telling you can't add"*
 *
 * `POST /v1/businesses` refuses a session with no practice in scope, and a
 * `PRACTICE_STANDARD` invited with a client list is exactly that session (see
 * `api/auth.test.ts` for why the role is not the signal). The matrix's ruling
 * for this surface is **hidden**, so what is pinned is the absence of the
 * button — and, separately, that the `?add=1` ADDRESS cannot reopen what the
 * button no longer offers. A gate on the button alone would be hidden in name
 * only: that address exists precisely so it can be pasted to a colleague.
 */
test('⚠ item 39 — a colleague scoped to specific clients is not offered Add Client', () => {
  session = scopedColleague;
  renderView();
  expect(screen.queryByRole('button', { name: /add client/i })).toBeNull();
});

test('⚠ item 39 — and ?add=1 does not reopen the intake for them', () => {
  session = scopedColleague;
  window.history.replaceState(null, '', '/clients?add=1');
  renderView();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('the same role invited practice-wide keeps the button, and ?add=1 still opens', () => {
  session = practiceWide;
  window.history.replaceState(null, '', '/clients?add=1');
  renderView();
  expect(screen.getByRole('button', { name: /add client/i })).toBeTruthy();
  // Proves the assertion above is not vacuous: the dialog IS reachable by that
  // address for a session that may use it, so its absence for the scoped
  // colleague is the gate and not a test that could never see one.
  expect(screen.getByRole('dialog')).toBeTruthy();
});
