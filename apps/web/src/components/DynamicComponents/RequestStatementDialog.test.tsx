import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import RequestStatementDialog from './RequestStatementDialog';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';

/**
 * Review item 16, the owner's 7 Sep 2026 ruling: the SMS channel is SHOWN and
 * DISABLED rather than hidden. The distinction is the point — launch M8 swept
 * every claim of texting out of this app, so a live SMS tickbox would be the
 * lie M8 removed, while a disabled one wearing its reason says something true:
 * the product knows the channel and this release does not have it.
 */

vi.mock('../../api/proposals', () => ({ requestStatementProposal: vi.fn() }));
// The dialog reads the context only for the confirm path; this suite is about
// what the channel row RENDERS, so the smallest honest stand-in serves.
vi.mock('../../context/AppContext', () => ({ useAppContext: () => ({ session: { status: 'authenticated', me: { isOwner: true, role: 'PRACTICE_ADMIN' } } }) }));

function renderDialog() {
  return render(
    <AppIntlProvider>
      <RequestStatementDialog businessId="biz_1" clientName="American Burger Ltd" onClose={() => {}} />
    </AppIntlProvider>,
  );
}

test('the SMS channel is offered, disabled, and says WHY', () => {
  renderDialog();

  const sms = screen.getByText('Text message');
  expect(sms.getAttribute('aria-disabled')).toBe('true');
  expect(sms.className).toContain('cursor-not-allowed');
  // The reason is on the page, not only in a title attribute — a title never
  // appears on touch, and a phone is where this is read.
  expect(screen.getByText(/this release sends document requests by email/)).toBeTruthy();
});

test('email is shown as the live channel, so the pair reads as a choice already made', () => {
  renderDialog();

  const email = screen.getByText('Email');
  expect(email.getAttribute('aria-disabled')).toBeNull();
});
