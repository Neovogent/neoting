import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import App from '../../App';
import { queryClient } from '../../api/queryClient';
import { AppProvider } from '../../context/AppContext';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import { faultMessageFor } from './BusinessOnboardingView';

/**
 * The invited client's journey (launch stage M6), driven through the real
 * shell — the `ChasePortalView.test.tsx` pattern, for the same reason:
 * offline by construction (`VITE_API_ENABLED` is unset under vitest), so the
 * journey runs on seed data, nothing opens a socket, and the fallback demo
 * path stays proven (METH_MODE §1).
 *
 * What it pins:
 *   · `/app/setup` reaches the sign-in journey — not the workspace, and not
 *     the login wall, which is what the address resolved to before this stage
 *     and is a dead end for exactly the person the email invited;
 *   · the copy says EMAILED. There is no SMS in this release (D47), and the
 *     contract's own words are "the copy on every screen must say 'emailed',
 *     never 'texted'";
 *   · the code gate is the contract's `^[0-9]{6}$`, refused before the
 *     network;
 *   · the price renders as "£8.50 + VAT", never a bare figure — prices are
 *     stored exclusive of VAT and displayed as such (§24.5), and there is no
 *     tier picker anywhere on the step;
 *   · the journey ends inside the business portal, signed into the account it
 *     onboarded.
 */

function renderAt(address: string) {
  window.history.replaceState({}, '', address);
  return render(
    <AppIntlProvider>
      <QueryClientProvider client={queryClient}>
        <AppProvider>
          <App />
        </AppProvider>
      </QueryClientProvider>
    </AppIntlProvider>,
  );
}

/** React's onChange reads the DOM value, so this is what typing does. */
async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const click = async (name: string | RegExp) =>
  act(async () => {
    screen.getByRole('button', { name }).click();
  });

test('/app/setup opens the sign-in journey, not the workspace and not the login wall', async () => {
  renderAt('/app/setup');

  expect(await screen.findByRole('heading', { name: 'Sign in to get set up' })).toBeInTheDocument();
  expect(screen.queryByText('AI Workspace')).not.toBeInTheDocument();
  // The privacy notice is at the point of collection (UK GDPR Art. 13).
  expect(screen.getByRole('link', { name: /Privacy Notice/ })).toBeInTheDocument();
});

test('the address gate holds until the email is plausible, and the code copy says EMAILED', async () => {
  const { container } = renderAt('/app/setup');
  await screen.findByRole('heading', { name: 'Sign in to get set up' });

  const field = container.querySelector<HTMLInputElement>('#onboarding-email');
  expect(field).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Email me a code' })).toBeDisabled();

  await type(field!, 'not-an-address');
  expect(screen.getByRole('button', { name: 'Email me a code' })).toBeDisabled();

  await type(field!, 'maria@anandagroup.co.uk');
  expect(screen.getByRole('button', { name: 'Email me a code' })).toBeEnabled();
  await click('Email me a code');

  expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
  // The required sentence, with the address in it — and never "text".
  expect(screen.getByText(/We’ve emailed a six-digit code to maria@anandagroup\.co\.uk/)).toBeInTheDocument();
  expect(screen.queryByText(/texted|by text|SMS/i)).not.toBeInTheDocument();
});

test('six digits sign in, the subscription is one VAT-labelled price, and the journey lands in the portal', async () => {
  const { container } = renderAt('/app/setup');
  await screen.findByRole('heading', { name: 'Sign in to get set up' });

  await type(container.querySelector<HTMLInputElement>('#onboarding-email')!, 'maria@anandagroup.co.uk');
  await click('Email me a code');
  await screen.findByRole('heading', { name: 'Check your email' });

  const otp = container.querySelector<HTMLInputElement>('#onboarding-otp');
  expect(otp).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();

  // Non-digits are dropped and the field stops at the contract's six.
  await type(otp!, '12a34567');
  expect(otp!.value).toBe('123456');
  await click('Sign in');

  expect(await screen.findByRole('heading', { name: 'You’re signed in' })).toBeInTheDocument();
  await click('Continue');

  // One price, exclusive of VAT and labelled as such. No tiers to pick from.
  expect(await screen.findByRole('heading', { name: 'Your subscription' })).toBeInTheDocument();
  expect(screen.getByText('£8.50 + VAT')).toBeInTheDocument();
  expect(screen.getByText('per month, per business')).toBeInTheDocument();
  expect(screen.getByText(/excluding VAT/)).toBeInTheDocument();

  await click('Continue to secure checkout');
  expect(await screen.findByRole('heading', { name: 'Subscription active' })).toBeInTheDocument();

  // Into the portal shell, signed into the account that was onboarded.
  await click('Open your portal');
  expect(await screen.findByText('Business portal')).toBeInTheDocument();
});

test('returning from a cancelled checkout says nothing was charged', async () => {
  renderAt('/app/setup?checkout=cancelled');

  expect(await screen.findByRole('heading', { name: 'Checkout cancelled' })).toBeInTheDocument();
  expect(screen.getByText(/Nothing has been charged/)).toBeInTheDocument();
});

/**
 * ⚠ The fallback splits on whether the server ANSWERED, and this is the only
 * mechanical guard that rule has.
 *
 * An `NT-` reference on screen beside "check your connection" cannot both be
 * true — the reference arrived over the connection the sentence blames. S7 walked
 * into it live: `POST /portal/sign-in-codes` and `/portal/onboarding-sessions`
 * were contracted and unimplemented, the 404 came back as `NT-VAL-001`, and an
 * invited client was told to check their wifi for a route that did not exist.
 */
test('a code means the server answered — the connection is never blamed for a reply we received', () => {
  expect(faultMessageFor({ code: 'NT-VAL-001', detail: null }, false).id).toBe('portal.onboarding.faultRefused');
  expect(faultMessageFor({ code: 'NT-SRV-001', detail: null }, false).id).toBe('portal.onboarding.faultRefused');

  // Nothing answered. Now, and only now, the connection is the honest suspect.
  expect(faultMessageFor({ code: null, detail: null }, false).id).toBe('portal.onboarding.faultUnreachable');

  // The three the client can act on keep their own sentence, and the subscribe
  // step keeps the one that says nothing was charged.
  expect(faultMessageFor({ code: 'NT-OTP-001', detail: null }, false).id).toBe('portal.onboarding.faultOtp');
  expect(faultMessageFor({ code: 'NT-OTP-002', detail: null }, false).id).toBe('portal.onboarding.faultSession');
  expect(faultMessageFor({ code: 'NT-RATE-001', detail: null }, false).id).toBe('portal.onboarding.faultRateLimited');
  expect(faultMessageFor({ code: 'NT-VAL-001', detail: null }, true).id).toBe('portal.onboarding.faultCheckout');
});
