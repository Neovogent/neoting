import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { NtProblemError } from '@neoting/contracts';

import { LoginView } from './LoginView';
import { login } from '../api/auth';
import { AppIntlProvider } from '../i18n/AppIntlProvider';

/**
 * The front door, in the four states it was designed with.
 *
 * Offline by construction: the wire is `vi.mock`ed at the module seam, so
 * what is under test is the screen's own logic — the client-side gate (all
 * three credentials present, TOTP exactly six digits, refused BEFORE the
 * network), and the error state rendering the `NT-` code the server answered
 * with, per house style.
 */

vi.mock('../api/auth', () => ({ login: vi.fn() }));

afterEach(() => vi.clearAllMocks());

function renderLogin() {
  return render(
    <AppIntlProvider>
      <LoginView />
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

function fields(container: HTMLElement) {
  return {
    email: container.querySelector<HTMLInputElement>('#login-email')!,
    password: container.querySelector<HTMLInputElement>('#login-password')!,
    totp: container.querySelector<HTMLInputElement>('#login-totp')!,
  };
}

test('the gate is real: nothing submits until email, password and six digits are in', async () => {
  const { container } = renderLogin();
  const { email, password, totp } = fields(container);
  const button = screen.getByRole('button', { name: 'Sign in' });

  expect(button).toBeDisabled();

  await type(email, 'shakib@neoting.test');
  await type(password, 'demo-neoting-2026');
  expect(button).toBeDisabled();

  // Five digits is not six; non-digits never reach the field; six enables.
  await type(totp, '00000');
  expect(button).toBeDisabled();
  await type(totp, '00a0000b00');
  expect(totp.value).toBe('000000');
  expect(button).toBeEnabled();

  // The gate refuses before the network — nothing was sent while it was shut.
  expect(vi.mocked(login)).not.toHaveBeenCalled();
});

test('submit sends the trimmed credentials once', async () => {
  vi.mocked(login).mockResolvedValueOnce(undefined);
  const { container } = renderLogin();
  const { email, password, totp } = fields(container);

  await type(email, '  shakib@neoting.test  ');
  await type(password, 'demo-neoting-2026');
  await type(totp, '000000');
  await act(async () => {
    screen.getByRole('button', { name: 'Sign in' }).click();
  });

  expect(vi.mocked(login)).toHaveBeenCalledExactlyOnceWith({
    email: 'shakib@neoting.test',
    password: 'demo-neoting-2026',
    totp: '000000',
  });
  // Success is the workspace appearing (App swaps on the refetched /me);
  // this screen's own job ends in the busy state, not a message.
  expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
});

test('a refusal renders the designed error state, NT- code visible', async () => {
  vi.mocked(login).mockRejectedValueOnce(
    new NtProblemError({ status: 401, code: 'NT-AUTH-003', title: 'Invalid credentials' }),
  );
  const { container } = renderLogin();
  const { email, password, totp } = fields(container);

  await type(email, 'shakib@neoting.test');
  await type(password, 'wrong');
  await type(totp, '000000');
  await act(async () => {
    screen.getByRole('button', { name: 'Sign in' }).click();
  });

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('did not match');
  expect(alert.textContent).toContain('NT-AUTH-003');
  // The form is usable again — an error is a state, not a dead end.
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
});

test('an unreachable API says so instead of blaming the credentials', async () => {
  vi.mocked(login).mockRejectedValueOnce(new Error('Failed to fetch'));
  const { container } = renderLogin();
  const { email, password, totp } = fields(container);

  await type(email, 'shakib@neoting.test');
  await type(password, 'demo-neoting-2026');
  await type(totp, '000000');
  await act(async () => {
    screen.getByRole('button', { name: 'Sign in' }).click();
  });

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('could not reach');
  expect(alert.textContent).not.toContain('NT-');
});
