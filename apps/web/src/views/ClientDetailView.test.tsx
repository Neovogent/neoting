import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ClientDetailView } from './ClientDetailView';
import { AppIntlProvider } from '../i18n/AppIntlProvider';
import { createProposal } from '../api/proposals';
import type { ClientStats } from '../lib/selectors';

/**
 * The client's Settings tab is the ONE place a client can be removed — the
 * design decision of 31 Aug 2026 ("go to the client and the Settings tab, not
 * the front card"); ClientsView.test.tsx pins the board's half. These tests
 * pin the entry point: the danger zone renders with the honest copy, the
 * button opens `OffboardClientDialog` for THIS client, confirming creates the
 * `business.offboard` proposal, and seed data disables the whole affordance
 * rather than faking a removal.
 */

vi.mock('../api/proposals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/proposals')>();
  return { ...actual, createProposal: vi.fn() };
});

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

const CLIENT = {
  id: 'biz_sparkle',
  name: 'Sparkle Cleaning Ltd',
  industry: 'Cleaning',
  health: 92,
  missingDocs: 0,
  toReview: 0,
  deadline: '7 Sep 2026',
  bankConnected: true,
};

// The remove affordance is live-gated on the businesses slice; the seed test flips it.
let businessesSource: 'api' | 'seed' = 'api';
// Per-test overrides on the client row (subscription status, contact email…).
let clientOver: Partial<import('../lib/types').Client> = {};
const setActiveTab = vi.fn();

vi.mock('../context/AppContext', () => ({
  useAppContext: () => ({
    clients: [{ ...CLIENT, ...clientOver }],
    openClientId: 'biz_sparkle',
    openClient: vi.fn(),
    statsFor: () => STATS,
    documents: [],
    missing: [],
    approvals: [],
    chases: [],
    startConversation: vi.fn(),
    retryDocument: vi.fn(),
    starredClientIds: [],
    toggleStarClient: vi.fn(),
    onboardingLinks: [],
    sendOnboardingLink: vi.fn(),
    resendOnboardingLink: vi.fn(),
    tasks: [],
    setTaskStatus: vi.fn(),
    auditLog: [],
    settings: { docEmail: '' },
    conversations: [],
    selectConversation: vi.fn(),
    setActiveTab,
    approvalWorkflows: [],
    saveWorkflow: vi.fn(),
    deleteWorkflow: vi.fn(),
    businessAccounts: [],
    inviteBusinessUser: vi.fn(),
    openRegistrationLink: vi.fn(),
    colleagues: [],
    addTask: vi.fn(),
    advanceApproval: vi.fn(),
    rejectApproval: vi.fn(),
    clientSideApprovals: () => [],
    approvalRequests: [],
    sendApprovalRequest: vi.fn(),
    resendApprovalRequest: vi.fn(),
    openApprovalLink: vi.fn(),
    chasePolicy: { resendAfterHours: 24 },
    clientDetailChanges: [],
    proposeClientDetailChanges: vi.fn(),
    slices: { businesses: { source: businessesSource, loading: false, error: null } },
  }),
}));

beforeEach(() => {
  businessesSource = 'api';
  clientOver = {};
  // The tab is the address's third segment — this is how a person gets here.
  window.history.replaceState(null, '', '/clients/biz_sparkle/settings');
  vi.mocked(createProposal).mockResolvedValue({
    id: 'prop_1',
    kind: 'business.offboard',
    state: 'CREATED',
    payloadHash: 'a'.repeat(64),
    createdAt: '2026-08-31T10:00:00.000Z',
  } as Awaited<ReturnType<typeof createProposal>>);
});

afterEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});

function renderView() {
  return render(
    <AppIntlProvider>
      <ClientDetailView />
    </AppIntlProvider>,
  );
}

const removeButton = () => screen.getByRole('button', { name: 'Remove this client…' });

test('the Settings tab carries the danger zone, honest about approval and retention', () => {
  renderView();

  expect(screen.getByRole('heading', { name: 'Remove this client' })).toBeTruthy();
  const text = document.body.textContent ?? '';
  expect(text).toContain('only after it is approved');
  expect(text).toContain('Documents, books and the audit trail are retained — nothing is deleted.');
  expect((removeButton() as HTMLButtonElement).disabled).toBe(false);
  expect(vi.mocked(createProposal)).not.toHaveBeenCalled();
});

test('the button opens the confirmation dialog naming this client', () => {
  renderView();
  fireEvent.click(removeButton());

  expect(screen.getByRole('dialog', { name: 'Remove Sparkle Cleaning Ltd?' })).toBeTruthy();
  expect(vi.mocked(createProposal)).not.toHaveBeenCalled();
});

test('confirming creates the business.offboard proposal and the panel says queued, pointing at Approvals', async () => {
  renderView();
  fireEvent.click(removeButton());
  fireEvent.change(screen.getByPlaceholderText('Client moved to another practice'), {
    target: { value: 'Client moved on' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Yes, queue the removal' }));
  });

  expect(vi.mocked(createProposal)).toHaveBeenCalledWith({
    kind: 'business.offboard',
    businessId: 'biz_sparkle',
    payload: { businessId: 'biz_sparkle', reason: 'Client moved on' },
  });

  // The dialog is done; the panel says what actually happened (queued, not
  // removed) and points at the queue that decides it.
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain(
    'Removal queued — Sparkle Cleaning Ltd stays in the practice until the proposal is approved.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review in Approvals' }));
  expect(setActiveTab).toHaveBeenCalledWith('Approvals');
});

/**
 * Review item 64 — the setup-link panel's job ends when the client registers
 * and subscribes. Un-onboarded keeps today's panel; a subscription that has
 * existed at Stripe replaces it with the "Portal access" card, and a lapse is
 * said plainly with the same words the portal's own Plan panel uses.
 */
test('an un-onboarded client still gets the setup-link panel', () => {
  clientOver = { email: 'tom@sparkle.co.uk', setupLinkSentAt: '2026-09-04T10:00:00.000Z' };
  renderView();

  expect(screen.getByText('Client setup link')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Resend link' })).toBeTruthy();
  expect(screen.queryByText('Portal access')).toBeNull();
});

test('an ACTIVE client gets the portal-access card instead — no more Resend link', () => {
  clientOver = { subscriptionStatus: 'ACTIVE', email: 'tom@sparkle.co.uk', setupLinkSentAt: '2026-09-04T10:00:00.000Z' };
  renderView();

  expect(screen.getByText('Portal access')).toBeTruthy();
  expect(screen.queryByText('Client setup link')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Resend link' })).toBeNull();
  // Facts already served, nothing invented: status, sign-in address, sent date.
  expect(screen.getByText('Active')).toBeTruthy();
  // The address also renders in the details panel, so at least once here.
  expect(screen.getAllByText('tom@sparkle.co.uk').length).toBeGreaterThan(0);
  expect(screen.getByText('04 Sept 2026')).toBeTruthy();
  // The re-invite survives demoted to an edge-case action.
  expect(screen.getByRole('button', { name: 'Invite another contact' })).toBeTruthy();
});

test('TRIALING counts as onboarded too', () => {
  clientOver = { subscriptionStatus: 'TRIALING', email: 'tom@sparkle.co.uk' };
  renderView();

  expect(screen.getByText('Portal access')).toBeTruthy();
  expect(screen.getByText('Trial')).toBeTruthy();
  expect(screen.queryByText('Client setup link')).toBeNull();
});

test('a lapsed client (PAST_DUE) shows the card with the lapse said plainly, not a setup link', () => {
  clientOver = { subscriptionStatus: 'PAST_DUE', email: 'tom@sparkle.co.uk' };
  renderView();

  expect(screen.getByText('Portal access')).toBeTruthy();
  expect(screen.getByText('Payment overdue')).toBeTruthy();
  // The portal's own Plan panel says "not running … cannot send"; this agrees.
  expect(document.body.textContent).toContain('The subscription is not running, so the client cannot send new documents.');
  expect(screen.queryByRole('button', { name: 'Resend link' })).toBeNull();
});

test('CANCELED shows the card as well — a setup link cannot fix a cancellation', () => {
  clientOver = { subscriptionStatus: 'CANCELED', email: 'tom@sparkle.co.uk' };
  renderView();

  expect(screen.getByText('Portal access')).toBeTruthy();
  expect(screen.getByText('Cancelled')).toBeTruthy();
  expect(screen.queryByText('Client setup link')).toBeNull();
});

test('an INCOMPLETE checkout keeps the setup-link panel — the journey is still the door', () => {
  clientOver = { subscriptionStatus: 'INCOMPLETE', email: 'tom@sparkle.co.uk' };
  renderView();

  expect(screen.getByText('Client setup link')).toBeTruthy();
  expect(screen.queryByText('Portal access')).toBeNull();
});

test('on seed data the affordance is disabled with the reason — a removal is never faked locally', () => {
  businessesSource = 'seed';
  renderView();

  expect((removeButton() as HTMLButtonElement).disabled).toBe(true);
  expect(document.body.textContent).toContain(
    'Demo data — removing a client goes through Review → Approve, and this build is not talking to a server.',
  );
  fireEvent.click(removeButton());
  expect(screen.queryByRole('dialog')).toBeNull();
});
