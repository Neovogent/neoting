import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';

import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import { LivePortalVault } from './LivePortalVault';

/**
 * **The consent return, and the one thing it must not do twice.**
 *
 * The vendor redirects the browser back to `/portal/vault?code=…&state=…` and
 * this screen posts that pair to the API with the portal bearer — the half that
 * makes the connection safe, because the signed state is then never the only
 * thing authorising the write.
 *
 * ⚠ **An authorisation code is single-use and the state is consumed on first
 * exchange**, so a second post is not a harmless duplicate: it necessarily
 * fails, and the failure was painted as a red refusal on top of a drive that
 * had just connected. The client read "that did not work" about a connection
 * that had worked, which is the worst reading available.
 *
 * The cause was ordering, not logic. React invokes a mount effect twice under
 * StrictMode; both runs read `window.location.search` while the first was still
 * suspended on the network, so both saw the code. Stripping the address sooner
 * could not have closed it — the strip is a `replaceState` and the second run is
 * already scheduled with the old address. Only a claim made BEFORE the first
 * `await` closes the window, which is what this file pins.
 *
 * ⚠ **Rendered under `StrictMode` deliberately.** Drop it and this suite passes
 * against the defect — the double-invoke is the whole subject.
 */

vi.mock('../../api/vault', () => ({
  completeDriveConnection: vi.fn(async () => 'someone@example.com'),
  disconnectDrive: vi.fn(async () => undefined),
  downloadVaultArchive: vi.fn(async () => undefined),
  fetchVault: vi.fn(async () => ({ active: true, destinations: [], latestExport: null })),
  startDriveConnection: vi.fn(async () => 'https://accounts.google.com/o/oauth2/v2/auth'),
  startVaultExport: vi.fn(async () => ({ id: 'vex_1', state: 'QUEUED' })),
}));

const api = await import('../../api/vault');

function renderAt(search: string): void {
  window.history.replaceState({}, '', `/portal/vault${search}`);
  render(
    <StrictMode>
      <AppIntlProvider>
        <LivePortalVault token="tok_1" search="" onSearch={() => undefined}>
          <div />
        </LivePortalVault>
      </AppIntlProvider>
    </StrictMode>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

test('the returned code is exchanged exactly ONCE, however many times the effect runs', async () => {
  renderAt('?code=one-shot&state=signed-state');

  await waitFor(() => expect(api.completeDriveConnection).toHaveBeenCalled());
  // Let any second invocation land before counting — a bug that beat the
  // assertion would otherwise read as a pass.
  await waitFor(() => expect(api.fetchVault).toHaveBeenCalled());

  expect(api.completeDriveConnection).toHaveBeenCalledTimes(1);
  expect(api.completeDriveConnection).toHaveBeenCalledWith('tok_1', 'one-shot', 'signed-state');
});

test('the spent code and every vendor param leave the address, Microsoft`s `iss` included', async () => {
  renderAt('?code=one-shot&state=signed-state&scope=drive.file&authuser=0&iss=https://login.microsoftonline.com/x');

  await waitFor(() => expect(window.location.search).toBe(''));
});

test('a client who pressed Cancel is not told anything failed', async () => {
  renderAt('?error=access_denied');

  await waitFor(() => expect(api.fetchVault).toHaveBeenCalled());

  expect(api.completeDriveConnection).not.toHaveBeenCalled();
  expect(window.location.search).toBe('');
  expect(screen.queryByText(/did not work|could not/i)).toBeNull();
});
