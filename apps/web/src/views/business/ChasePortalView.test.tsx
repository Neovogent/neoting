import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import App from '../../App';
import { queryClient } from '../../api/queryClient';
import { AppProvider } from '../../context/AppContext';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import { faultMessageFor } from './ChasePortalView';

/**
 * The chase portal, driven through the real shell.
 *
 * Offline by construction: `VITE_API_ENABLED` is unset under vitest, so the
 * journey runs on its seed-data implementation, nothing opens a socket and
 * nothing waits on a timer. That is what earns this suite its place — the
 * fallback demo path (`VITE_API_ENABLED=false`) is the one nobody exercises by
 * hand, and METH_MODE §1 makes not breaking it a standing condition on every
 * stage.
 *
 * What it pins:
 *   · `/p/<token>` reaches the portal at all. A practice shell rendered at a
 *     client-facing address is a tenancy incident, not a routing bug;
 *   · the code gate is real in the UI — the button is dead until six digits are
 *     in, and non-digits never reach the field. That is the contract's own
 *     `^[0-9]{6}$`, refused before the network rather than after it;
 *   · passing it lands on the requested-items list and not on any other screen.
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

test('/p/<token> opens the chase portal on the code challenge, not the practice app', async () => {
  renderAt('/p/chase-demo');

  // Every screen here is behind `React.lazy`, so the chunk has to resolve
  // before anything is on the page. Still offline — the only thing being
  // waited on is a dynamic `import()`, not a request.
  expect(await screen.findByRole('heading', { name: 'Enter your code' })).toBeInTheDocument();
  // The practice app's own chrome must not be sitting behind a client address.
  expect(screen.queryByText('AI Workspace')).not.toBeInTheDocument();
});

test('the code gate is six digits, and passing it opens the requested items', async () => {
  const { container } = renderAt('/p/chase-demo');
  await screen.findByRole('heading', { name: 'Enter your code' });

  const field = container.querySelector<HTMLInputElement>('#portal-otp');
  expect(field).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Open my documents' })).toBeDisabled();

  await type(field!, '0000');
  expect(screen.getByRole('button', { name: 'Open my documents' })).toBeDisabled();

  // Non-digits are dropped and the field stops at the contract's six.
  await type(field!, '00000a0000');
  expect(field!.value).toBe('000000');
  expect(screen.getByRole('button', { name: 'Open my documents' })).toBeEnabled();

  await act(async () => {
    screen.getByRole('button', { name: 'Open my documents' }).click();
  });

  expect(screen.getByRole('heading', { name: 'What we need from you' })).toBeInTheDocument();
});

test('with no token in the address the portal asks for the link rather than guessing one', async () => {
  renderAt('/p');

  expect(await screen.findByRole('heading', { name: 'Open your secure link' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
});

/**
 * ⚠ "Check your signal" is true only when nothing answered.
 *
 * The `NT-` reference beside it came back over the connection the sentence
 * blames, so the two cannot both be on screen. A client sent to their signal
 * for a server-side fault stops trying, and the document we chased never
 * arrives — which is the whole thing this surface exists to collect.
 */
test('a code means the server answered — the signal is never blamed for a reply we received', () => {
  expect(faultMessageFor({ code: 'NT-VAL-001', detail: null }).id).toBe('portal.chasePortal.faultRefused');
  expect(faultMessageFor({ code: 'NT-SRV-001', detail: null }).id).toBe('portal.chasePortal.faultRefused');
  expect(faultMessageFor({ code: null, detail: null }).id).toBe('portal.chasePortal.faultUnreachable');

  // The two the client can act on keep their own sentence.
  expect(faultMessageFor({ code: 'NT-OTP-001', detail: null }).id).toBe('portal.chasePortal.faultOtp');
  expect(faultMessageFor({ code: 'NT-OTP-002', detail: null }).id).toBe('portal.chasePortal.faultSession');
});
