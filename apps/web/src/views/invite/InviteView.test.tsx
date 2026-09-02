import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NtProblemError } from '@neoting/contracts';

import { InviteView } from './InviteView';
import { acceptInvite, readInvitation } from '../../api/invitation';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';

/**
 * The invited colleague's journey.
 *
 * Offline by construction, the `SignupView.test.tsx` way: the wire is
 * `vi.mock`ed at the module seam, so what is under test is the screen's own
 * logic. Two of these are not "does it render" tests at all —
 *
 *  - the token must be SCRUBBED from the address BEFORE the first request. It
 *    is a credential arriving in a URL, and one left in `location.search` is in
 *    the history and in the next outbound `Referer`. M9's rule, inherited.
 *  - "check your connection" may appear ONLY when the server did not answer.
 *    A code means a reply came back over the very connection that sentence
 *    blames, and the two on screen together is the bug that sent an invited
 *    client to their wifi settings for an `NT-VAL-001`.
 */

vi.mock('../../api/invitation', async (importOriginal) => {
  // The constants and `invitationFaultOf` are real; only the two calls are
  // stubbed — the password minimum in particular is read from the contract and
  // one assertion below depends on it being the real number.
  const actual = await importOriginal<typeof import('../../api/invitation')>();
  return { ...actual, readInvitation: vi.fn(), acceptInvite: vi.fn() };
});

const PREVIEW = {
  practiceName: 'Ledgerline',
  email: 'sam@ledgerline.test',
  role: 'PRACTICE_STANDARD' as const,
  expiresAt: '2026-09-09T09:00:00.000Z',
  invitedByName: 'Priya Shah',
};

const TOKEN = 'a-real-looking-invitation-token';

beforeEach(() => window.history.replaceState({}, '', '/invite'));
afterEach(() => vi.clearAllMocks());

function renderAt(href: string) {
  window.history.replaceState({}, '', href);
  return render(
    <AppIntlProvider>
      <InviteView />
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

const click = async (element: Element) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

test('⚠ the token is scrubbed from the address BEFORE the preview request goes out', async () => {
  let addressWhenAsked = '';
  vi.mocked(readInvitation).mockImplementation(async () => {
    addressWhenAsked = window.location.search;
    return PREVIEW;
  });

  renderAt(`/invite?token=${TOKEN}`);
  await act(async () => {});

  // Before, not after: a token that survives even one render is in the history.
  expect(addressWhenAsked).not.toContain(TOKEN);
  expect(window.location.search).not.toContain(TOKEN);
  // …and it was still SENT — scrubbing must not lose it.
  expect(readInvitation).toHaveBeenCalledWith(TOKEN);
});

test('the screen names the practice, the address and the role — it may, and it must', async () => {
  vi.mocked(readInvitation).mockResolvedValue(PREVIEW);
  renderAt(`/invite?token=${TOKEN}`);
  await act(async () => {});

  const text = document.body.textContent ?? '';
  // Unlike /signup/check-email this caller holds a token we emailed to the
  // address it names, so every fact here is already in their inbox. A password
  // form for an unnamed employer is the phishing shape, not the safe one.
  expect(text).toContain('Ledgerline');
  expect(text).toContain('sam@ledgerline.test');
  expect(text).toContain('Priya Shah');
  expect(text).toContain('Standard user');
});

test('an address with no token says the link is incomplete, and asks the server nothing', async () => {
  renderAt('/invite');
  await act(async () => {});
  expect(readInvitation).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('no invitation in it');
});

test('an expired invitation says so; an invalid one gives the uniform answer', async () => {
  vi.mocked(readInvitation).mockRejectedValue(new NtProblemError({ code: 'NT-AUTH-005', status: 401, title: 'x' } as never));
  renderAt(`/invite?token=${TOKEN}`);
  await act(async () => {});
  expect(document.body.textContent).toContain('expired');

  vi.clearAllMocks();
  vi.mocked(readInvitation).mockRejectedValue(new NtProblemError({ code: 'NT-AUTH-004', status: 401, title: 'x' } as never));
  renderAt(`/invite?token=${TOKEN}`);
  await act(async () => {});
  expect(document.body.textContent).toContain('not valid');
});

test('⚠ "check your connection" appears ONLY when the server did not answer', async () => {
  // A coded refusal came back over the connection, so blaming the connection
  // would be the one sentence that cannot be true.
  vi.mocked(readInvitation).mockRejectedValue(new NtProblemError({ code: 'NT-AUTH-004', status: 401, title: 'x' } as never));
  renderAt(`/invite?token=${TOKEN}`);
  await act(async () => {});
  expect(document.body.textContent).not.toContain('Check your connection');

  vi.clearAllMocks();
  vi.mocked(readInvitation).mockRejectedValue(new TypeError('Failed to fetch'));
  renderAt(`/invite?token=${TOKEN}`);
  await act(async () => {});
  expect(document.body.textContent).toContain('Check your connection');
});

test('the form is refused before the network until both names and twelve characters are there', async () => {
  vi.mocked(readInvitation).mockResolvedValue(PREVIEW);
  renderAt(`/invite?token=${TOKEN}`);
  await act(async () => {});

  const submit = screen.getByRole('button', { name: /create my account/i });
  await click(submit);
  expect(acceptInvite).not.toHaveBeenCalled();

  await type(screen.getByLabelText(/first name/i) as HTMLInputElement, 'Sam');
  await type(screen.getByLabelText(/last name/i) as HTMLInputElement, 'Patel');
  await type(screen.getByLabelText(/choose a password/i) as HTMLInputElement, 'too-short');
  await click(submit);
  expect(acceptInvite).not.toHaveBeenCalled();
  // It says how many more, rather than refusing silently.
  expect(document.body.textContent).toContain('more characters');

  vi.mocked(acceptInvite).mockResolvedValue({ email: PREVIEW.email });
  await type(screen.getByLabelText(/choose a password/i) as HTMLInputElement, 'a-long-enough-passphrase');
  await click(submit);
  expect(acceptInvite).toHaveBeenCalledWith({
    token: TOKEN,
    password: 'a-long-enough-passphrase',
    firstName: 'Sam',
    lastName: 'Patel',
  });
});

test('an invitation that stopped being spendable while the form was open replaces the form, not decorates it', async () => {
  vi.mocked(readInvitation).mockResolvedValue(PREVIEW);
  vi.mocked(acceptInvite).mockRejectedValue(new NtProblemError({ code: 'NT-AUTH-004', status: 401, title: 'x' } as never));
  renderAt(`/invite?token=${TOKEN}`);
  await act(async () => {});

  await type(screen.getByLabelText(/first name/i) as HTMLInputElement, 'Sam');
  await type(screen.getByLabelText(/last name/i) as HTMLInputElement, 'Patel');
  await type(screen.getByLabelText(/choose a password/i) as HTMLInputElement, 'a-long-enough-passphrase');
  await click(screen.getByRole('button', { name: /create my account/i }));

  // There is nothing left to do on that form, so it goes — and the one action
  // that helps somebody whose address already has an account is offered.
  expect(screen.queryByRole('button', { name: /create my account/i })).toBeNull();
  expect(document.body.textContent).toContain('not valid');
  expect(document.body.textContent).toContain('Go to sign in');
});

test('the token never reaches the DOM — not in a link, not in a hidden field', async () => {
  vi.mocked(readInvitation).mockResolvedValue(PREVIEW);
  renderAt(`/invite?token=${TOKEN}`);
  await act(async () => {});
  expect(document.body.innerHTML).not.toContain(TOKEN);
});
