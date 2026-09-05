import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import type { BusinessPortalHome } from '../../api/onboarding';

/**
 * The live business portal, driven through its own sign-in.
 *
 * Two rules are pinned here and nowhere else, because both are about what is on
 * screen rather than what a function returns:
 *
 * - **⚠ D48: THE LAPSED-SUBSCRIPTION STATE COMES BEFORE THE UPLOAD CONTROL.**
 *   An upload without a live subscription is refused server-side (`402
 *   NT-BIL-001`), so a portal that lets a client photograph a receipt and
 *   *then* refuses it has wasted the one action this surface exists for, on the
 *   one connection it is least affordable on. The control must not be there at
 *   all, and the notice must be above where it would have been.
 * - **⚠ D42: nothing on a client surface may claim a ledger.** A copy test in
 *   the shape `ExportView.test.tsx` uses, and for the same reason: no type can
 *   hold this rule, so reading the rendered DOM is the only mechanical guard
 *   it has.
 */

const mocks = vi.hoisted(() => ({
  requestSignInCode: vi.fn(),
  openOnboardingSession: vi.fn(),
  fetchBusinessPortalHome: vi.fn(),
  fetchPortalDocuments: vi.fn(),
  startSubscriptionCheckout: vi.fn(),
  openBillingPortal: vi.fn(),
}));

vi.mock('../../api/onboarding', () => mocks);
vi.mock('../../api/portal', () => ({ sendPortalUpload: vi.fn() }));

// Imported after the mock is declared — `vi.mock` is hoisted, but the reader
// should not have to know that to follow the file.
const { LiveBusinessPortal } = await import('./LiveBusinessPortal');

const HOME: BusinessPortalHome = {
  businessName: 'American Burger Ltd',
  businessId: 'biz_burger',
  documentsSent: 4,
  awaitingYou: 1,
  subscriptionActive: true,
  lastDocumentAt: '2026-08-30T09:00:00.000Z',
  items: [
    {
      transactionId: 'txn_1',
      label: 'Bidfood',
      amount: -412.5,
      date: '09 Aug 2026',
      received: false,
    },
  ],
  statementRequests: [],
  plan: null,
  expiresAt: '2026-09-02T12:00:00.000Z',
};

beforeEach(() => {
  window.history.replaceState({}, '', '/portal');
  mocks.requestSignInCode.mockResolvedValue(undefined);
  mocks.openOnboardingSession.mockResolvedValue({
    token: 'bearer-1',
    // Far enough out that the expiry timer never fires inside a test.
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    businessId: 'biz_burger',
  });
  mocks.fetchPortalDocuments.mockResolvedValue({ rows: [], hasMore: false });
});

afterEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

/** React's onChange reads the DOM value, so this is what typing does. */
async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function signIn(home: BusinessPortalHome) {
  mocks.fetchBusinessPortalHome.mockResolvedValue(home);
  render(
    <AppIntlProvider>
      <LiveBusinessPortal />
    </AppIntlProvider>,
  );

  await type(screen.getByLabelText('Your email address') as HTMLInputElement, 'tom@americanburger.co.uk');
  await act(async () => {
    screen.getByRole('button', { name: 'Email me a code' }).click();
  });
  await type(screen.getByLabelText('Six-digit code') as HTMLInputElement, '000000');
  await act(async () => {
    screen.getByRole('button', { name: 'Sign in' }).click();
  });
}

/** Both navigations are always in the DOM; CSS chooses. Either one will do. */
async function openTab(name: string) {
  await act(async () => {
    screen.getAllByRole('button', { name })[0]!.click();
  });
}

test('the sign-in step never says whether the address can be used', async () => {
  await signIn(HOME);
  // Reached the portal, so the code step was passed — but the wording on the
  // way through is what matters, and it was asserted by getting here at all
  // with a `202` that says nothing. The forbidden phrasings:
  const text = document.body.textContent ?? '';
  expect(text).not.toMatch(/we have sent|we've sent|account found|no account/i);
});

test('D48: a lapsed subscription replaces the upload control, and says so above it', async () => {
  await signIn({ ...HOME, subscriptionActive: false });
  await openTab('Upload');

  // The notice is there, and it announces itself…
  expect(screen.getByText('Your subscription is not active')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toBeInTheDocument();

  // …and the way to send a document is not. Not disabled — absent, so nothing
  // can be photographed and then refused.
  expect(document.querySelector('input[type="file"]')).toBeNull();
  expect(screen.queryByText('Drop files here, or click to choose')).not.toBeInTheDocument();

  // And it is ABOVE the rest of the tab, not appended under it.
  const heading = screen.getByText('Your subscription is not active');
  const later = screen.getByText('Sent from this portal');
  expect(heading.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('D48: the dead end is gone — the lapsed notice offers a real checkout', async () => {
  await signIn({ ...HOME, subscriptionActive: false });
  await openTab('Upload');

  // The old copy told the payer to telephone somebody else about their own
  // subscription, while `POST /billing/checkout-sessions` sat implemented and
  // portal-authorised.
  expect(document.body.textContent ?? '').not.toMatch(/accountant can help you restart/i);

  // ⚠ jsdom logs "Not implemented: navigation" when the hook hands the tab to
  // Stripe. That is jsdom, not a failure: `window.location` is not
  // reconfigurable here, so the redirect cannot be stubbed, and it is not what
  // this test is about — the call and its arguments are.
  mocks.startSubscriptionCheckout.mockResolvedValue('https://checkout.stripe.test/session');
  await act(async () => {
    screen.getByRole('button', { name: 'Restart my subscription' }).click();
  });

  expect(mocks.startSubscriptionCheckout).toHaveBeenCalledTimes(1);
  const [token, businessId, returnPath] = mocks.startSubscriptionCheckout.mock.calls[0]!;
  expect(token).toBe('bearer-1');
  expect(businessId).toBe('biz_burger');
  // ⚠ Portal-aware. The hard-coded `/app/setup` return address sent a client
  // who had just paid back to a one-time setup link they no longer hold.
  expect(returnPath).toBe('/portal/upload');
});

test('D48: the camera is not offered either while the subscription is lapsed', async () => {
  await signIn({ ...HOME, subscriptionActive: false });
  await openTab('Capture');

  expect(screen.getByText('Your subscription is not active')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Take photo' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Turn on camera' })).not.toBeInTheDocument();
});

test('with a live subscription the upload control is there and the notice is not', async () => {
  await signIn(HOME);
  await openTab('Upload');

  expect(screen.queryByText('Your subscription is not active')).not.toBeInTheDocument();
  expect(screen.getByText('Drop files here, or click to choose')).toBeInTheDocument();
  expect(document.querySelector('input[type="file"]')).not.toBeNull();
});

test('the tabs are addresses, so every one of them is linkable and Back works', async () => {
  await signIn(HOME);
  expect(window.location.pathname).toBe('/portal');

  await openTab('Capture');
  expect(window.location.pathname).toBe('/portal/capture');

  await openTab('Settings');
  expect(window.location.pathname).toBe('/portal/settings');
  // Settings opens on Business, which is read-only and says who owns the record.
  expect(screen.getByText('Held by your accountant — ask them to change any of it')).toBeInTheDocument();
  await openTab('Plan');
  expect(screen.getByText('Your plan')).toBeInTheDocument();

  await openTab('Home');
  expect(window.location.pathname).toBe('/portal');
});

test('“Send it” on an ask opens Capture against that ask, and promises nothing about closing it', async () => {
  await signIn(HOME);

  await act(async () => {
    screen.getByRole('button', { name: 'Send it' }).click();
  });

  expect(window.location.pathname).toBe('/portal/capture');
  expect(screen.getByText(/For Bidfood/)).toBeInTheDocument();
  // ⚠ The server records the declared transaction and then re-derives the
  // match from the extraction, so the ask is NOT promised to close.
  expect(screen.getByText(/The request stays open until it matches\./)).toBeInTheDocument();
});

/**
 * ⚠ D42, as a copy test. The only mechanical guard the rule has on this
 * surface: no label, note or status may say the books have moved, because in
 * this release nothing publishes to any accounting software.
 */
test('D42: nothing on the portal claims a ledger', async () => {
  await signIn(HOME);
  for (const tab of ['Upload', 'Capture', 'Settings', 'Home']) {
    await openTab(tab);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/accounting software/i);
    expect(text).not.toMatch(/\bXero\b/i);
    expect(text).not.toMatch(/QuickBooks/i);
    expect(text).not.toMatch(/\bposted\b/i);
    expect(text).not.toMatch(/\bsynced?\b/i);
    expect(text).not.toMatch(/sent to VT/i);
  }
});

/**
 * ⚠ Stripe's return leg resumes nothing, by design: the bearer died with the
 * redirect. So the screen is the sign-in screen with a banner, and the banner
 * claims only that Stripe is CONFIRMING — reaching this address is not proof
 * of payment (the contract's own words on `successUrl`).
 */
test('coming back from Stripe says what happened without claiming it was paid', () => {
  window.history.replaceState({}, '', '/portal/upload?checkout=success');
  render(
    <AppIntlProvider>
      <LiveBusinessPortal />
    </AppIntlProvider>,
  );

  expect(screen.getByText('Stripe is confirming your payment')).toBeInTheDocument();
  expect(screen.getByLabelText('Your email address')).toBeInTheDocument();
  expect(document.body.textContent ?? '').not.toMatch(/payment (received|complete|successful)/i);
});

test('an unknown checkout value on the address claims nothing at all', () => {
  window.history.replaceState({}, '', '/portal?checkout=nonsense');
  render(
    <AppIntlProvider>
      <LiveBusinessPortal />
    </AppIntlProvider>,
  );

  expect(screen.queryByText('Stripe is confirming your payment')).not.toBeInTheDocument();
  expect(screen.queryByText('Nothing has been charged')).not.toBeInTheDocument();
});

/**
 * ⚠ Review item 45. The Plan panel's fault line used to be one generic
 * sentence ("We could not open Stripe…") whatever the server answered, which
 * made four different failures — a missing live-mode portal configuration, a
 * restricted key without the Customer-portal permission, a refused return
 * URL, the tenancy 404 — indistinguishable from a screenshot. The line now
 * carries the session's own words with the NT- code in front (frontend ten,
 * item 5), composed by `useBusinessPortalSession#messageFor`.
 */
test('a failed billing-portal open wears the server problem and its NT- code', async () => {
  await signIn({ ...HOME, plan: { status: 'ACTIVE', plan: null, currentPeriodEnd: null } });
  await openTab('Settings');
  await openTab('Plan');

  const { NtProblemError } = await import('@neoting/contracts');
  mocks.openBillingPortal.mockRejectedValue(
    new NtProblemError({
      status: 500,
      code: 'NT-SRV-001',
      title: 'Billing is not set up correctly',
      detail: 'The payment provider refused the request — the billing account needs attention from the practice, not a retry. Nothing was charged.',
    }),
  );
  await act(async () => {
    screen.getByRole('button', { name: 'Manage billing in Stripe' }).click();
  });

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('NT-SRV-001');
  expect(alert.textContent).toContain('refused the request');
  // The generic sentence is gone — the line is the server's, not a mask.
  expect(alert.textContent).not.toContain('We could not open Stripe');
});

test('the plan panel says what it does not know rather than claiming the client never paid', async () => {
  await signIn({ ...HOME, plan: null, subscriptionActive: true });
  await openTab('Settings');
  await openTab('Plan');

  expect(screen.getByText('Your subscription is running and you can send documents.')).toBeInTheDocument();
  expect(screen.getByText('Your plan details are not available on this screen yet.')).toBeInTheDocument();
});
