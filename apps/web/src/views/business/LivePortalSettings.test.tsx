import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { LivePortalSettings } from './LivePortalSettings';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import type { BusinessPortalHome } from '../../api/onboarding';
import { setViewport } from '../../test/viewport';

/**
 * **Review item 44 — the Plan section is not a member's.**
 *
 * > *"The team member of a client don't need to see the plan subscribed"*
 *
 * D48 makes the client the payer — in practice the business owner. A staff
 * member added to photograph receipts has no use for the price and no business
 * holding a live button that mints a Stripe billing-portal session: the card,
 * every invoice, and cancellation.
 *
 * ⚠ **This suite is the courtesy, not the protection.** The real fix is
 * server-side, in `billing.controller.ts`'s `principalFor`, which checked
 * tenancy and no authority at all until this package — so every one of these
 * buttons WORKED for every member who could see them. That guard is pinned in
 * `billing.controller.test.ts`, and it stands whatever a browser renders.
 *
 * The address half — `/portal/settings/plan` falling to Business for a member
 * rather than opening the panel the rail no longer offers — is
 * `portalTabs.test.ts`'s, over the same list, so the nav and the address cannot
 * disagree about what exists.
 */

const HOME = (canManageBilling: boolean): BusinessPortalHome => ({
  businessName: 'Zeplow Inc.',
  businessId: 'biz_zeplow',
  documentsSent: 4,
  awaitingYou: 1,
  subscriptionActive: true,
  canManageBilling,
    canSubmitExpenseClaims: false,
  lastDocumentAt: '2026-09-04T09:00:00.000Z',
  items: [],
  statementRequests: [],
  plan: null,
  expiresAt: null,
});

function renderSettings(canManageBilling: boolean, section = 'Business') {
  // Desktop, so the rail renders. `SectionStrip` is the phone twin of the same
  // list; both are built from `sectionsFor`, so one is enough to pin the list.
  setViewport('desktop');
  render(
    <AppIntlProvider>
      <LivePortalSettings
        home={HOME(canManageBilling)}
        email="staff@zeplow.test"
        busy={false}
        fault={null}
        section={section}
        onSection={vi.fn()}
        sessionToken="portal-bearer"
        onSubscribe={vi.fn()}
        onManageBilling={vi.fn()}
        onSignOut={vi.fn()}
      />
    </AppIntlProvider>,
  );
}

test('⚠ item 44 — a member gets no Plan entry, and the sections around it are untouched', () => {
  renderSettings(false);

  expect(screen.queryByRole('button', { name: 'Plan' })).toBeNull();
  // Every other section stays. Hiding one must not quietly cost the client the
  // panels they DO own — People especially, which is their own access list.
  for (const section of ['Business', 'Sending', 'Notifications', 'People', 'Security']) {
    expect(screen.getByRole('button', { name: section })).toBeTruthy();
  }
});

test('⚠ item 44 — the owner keeps it: D48 makes them the payer', () => {
  // The guard must not be the outage. A subscription its payer cannot leave is
  // not one they consented to.
  renderSettings(true);
  expect(screen.getByRole('button', { name: 'Plan' })).toBeTruthy();
});

test('⚠ item 44 — no price and no Stripe button reach a member, even on the Plan address', () => {
  // Belt to the address rule's braces: `sectionFromPath` already lands a member
  // on Business, but if a caller ever passed 'Plan' anyway, the panel must not
  // paint £8.50 and a live cancellation door.
  renderSettings(false, 'Plan');

  expect(screen.queryByText(/£8\.50/)).toBeNull();
  expect(screen.queryByRole('button', { name: /manage billing in stripe/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /start my subscription/i })).toBeNull();
});

test('the owner on the Plan address sees the price and the Stripe door', () => {
  // Proves the three assertions above are not vacuous.
  renderSettings(true, 'Plan');

  expect(screen.getByText(/£8\.50/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /manage billing in stripe/i })).toBeTruthy();
});
