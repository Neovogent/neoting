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

/** Google registered, OneDrive not — the deployment's real shape on 24 Sep 2026. */
const GOOGLE_ONLY = { active: true, destinations: [], connectable: ['GOOGLE_DRIVE'], latestExport: null };

vi.mock('../../api/vault', () => ({
  completeDriveConnection: vi.fn(async () => 'someone@example.com'),
  disconnectDrive: vi.fn(async () => undefined),
  downloadVaultArchive: vi.fn(async () => undefined),
  fetchVault: vi.fn(async () => GOOGLE_ONLY),
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

/**
 * **A drive this deployment cannot connect is GREYED, never hidden** — and the
 * reason is on screen as text.
 *
 * OneDrive is unregistered because a personal Microsoft account cannot create
 * an app registration at all any more (see the module's own CLAUDE.md), so the
 * connect endpoint refuses it with `NT-INT-001`. Offering the button anyway
 * would be a dead end; removing it would tell the client the product does not
 * do OneDrive, which is a different and also untrue thing.
 *
 * ⚠ The list is the SERVER's (`PortalVault.connectable`), so these two tests
 * are also what pin that the browser holds no opinion of its own — flip the
 * fixture and the buttons swap, with no code change anywhere.
 */
test('an unregistered drive is offered as greyed-out, with the reason in text', async () => {
  renderAt('');

  const oneDrive = await screen.findByRole('button', { name: /OneDrive/i });
  expect(oneDrive).toBeDisabled();
  // ⚠ Not a `title`: a tooltip never appears on touch, and this portal is read
  // on a phone. A greyed button with no visible reason reads as broken.
  expect(screen.getByText(/coming soon.*not switched on yet/i)).toBeTruthy();

  // ...and the registered one is untouched by any of it.
  expect(await screen.findByRole('button', { name: /Connect Google Drive/i })).toBeEnabled();
});

test('registering the second drive needs no code change — the server says so and both light up', async () => {
  vi.mocked(api.fetchVault).mockResolvedValue({
    ...GOOGLE_ONLY,
    connectable: ['GOOGLE_DRIVE', 'ONEDRIVE'],
  } as Awaited<ReturnType<typeof api.fetchVault>>);

  renderAt('');

  expect(await screen.findByRole('button', { name: /Connect OneDrive/i })).toBeEnabled();
  expect(screen.queryByText(/coming soon/i)).toBeNull();
});
