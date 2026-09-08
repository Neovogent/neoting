import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
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
 *   · **the link alone opens it** — the code gate is gone (item 4, 8 Sep 2026:
 *     the chase travels by email and the code went to the same inbox, so it was
 *     one factor asked for twice). What used to be a six-digit challenge is now
 *     a page that opens itself and lands on the requested items;
 *   · with no token it asks for the link rather than guessing one.
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

test('/p/<token> lands on the requested items — no code, no second step', async () => {
  const { container } = renderAt('/p/chase-demo');

  // Every screen here is behind `React.lazy`, so the chunk has to resolve
  // before anything is on the page. Still offline — the only thing being
  // waited on is a dynamic `import()`, not a request.
  expect(await screen.findByRole('heading', { name: 'What we need from you' })).toBeInTheDocument();
  // The gate that used to stand here is GONE, not merely bypassed.
  expect(screen.queryByRole('heading', { name: 'Enter your code' })).not.toBeInTheDocument();
  expect(container.querySelector('#portal-otp')).toBeNull();
  // The practice app's own chrome must not be sitting behind a client address.
  expect(screen.queryByText('AI Workspace')).not.toBeInTheDocument();
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

  // WARNING: the two `NT-ING-` codes are the FILE and are PERMANENT, so neither may
  // fall to `faultRefused` ("try again in a moment") -- that is a loop with no
  // exit, and it is what an iPhone photograph met until 9 Sep 2026. Each names
  // what to send instead.
  expect(faultMessageFor({ code: 'NT-ING-002', detail: null }).id).toBe('portal.chasePortal.faultFileType');
  expect(faultMessageFor({ code: 'NT-ING-001', detail: null }).id).toBe('portal.chasePortal.faultFileTooBig');
});
