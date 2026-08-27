import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NtProblemError } from '@neoting/contracts';

import { SignupView } from './SignupView';
import { beginEnrolment, confirmEnrolment, signUpPractice, verifyEmail } from '../../api/signup';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';

/**
 * The four screens M9 built, in the states that matter.
 *
 * Offline by construction, the `LoginView.test.tsx` way: the wire is
 * `vi.mock`ed at the module seam, so what is under test is the screens' own
 * logic. Three of these are not "does it render" tests at all —
 *
 *  - the check-your-email screen is a COPY test, in the shape
 *    `ExportView.test.tsx` uses for D42. `POST /practices` answers the same
 *    empty `202` whether or not an account was created, so a screen that says
 *    "account created" or "already registered" turns the deliberate silence
 *    into an enumeration oracle. It is prose, no type can hold it, and this
 *    assertion is the only mechanical guard it has.
 *  - the verify screen must SCRUB the token from the address. It is a
 *    credential arriving in a URL, and one left in `location.search` is in the
 *    history and in the next `Referer`.
 *  - the enrolment must survive `NT-AUTH-008` by starting over rather than
 *    dead-ending, because A14's whole two-step exists so that failure is
 *    recoverable — nothing was written, and there is no reset flow in this
 *    release to rescue someone it strands.
 */

vi.mock('../../api/signup', async (importOriginal) => {
  // The constants are real — `TERMS_VERSION` in particular, which is the whole
  // point of one assertion below. Only the four calls are stubbed.
  const actual = await importOriginal<typeof import('../../api/signup')>();
  return {
    ...actual,
    signUpPractice: vi.fn(),
    verifyEmail: vi.fn(),
    beginEnrolment: vi.fn(),
    confirmEnrolment: vi.fn(),
  };
});

const OFFER = {
  enrolmentToken: 'ticket.abc.def',
  uri: 'otpauth://totp/Neo%20Accounting:priya@northgate.test?secret=JBSWY3DPEHPK3PXP&issuer=Neo%20Accounting',
  secret: 'JBSWY3DPEHPK3PXP',
  recoveryCodes: [
    'abcd-efgh-jkmn-pqrs', 'tuvw-xyz2-3456-789a', 'bcde-fghj-kmnp-qrst', 'uvwx-yz23-4567-89ab',
    'cdef-ghjk-mnpq-rstu', 'vwxy-z234-5678-9abc', 'defg-hjkm-npqr-stuv', 'wxyz-2345-6789-abcd',
    'efgh-jkmn-pqrs-tuvw', 'xyz2-3456-789a-bcde',
  ],
};

beforeEach(() => window.history.replaceState({}, '', '/signup'));
afterEach(() => vi.clearAllMocks());

function renderAt(href: string) {
  window.history.replaceState({}, '', href);
  return render(
    <AppIntlProvider>
      <SignupView />
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

/* ── ① the form ──────────────────────────────────────────────────────────── */

async function fillTheForm(container: HTMLElement, password = 'a-long-enough-passphrase') {
  await type(container.querySelector<HTMLInputElement>('#signup-practice')!, 'Northgate Accounts Ltd');
  await type(container.querySelector<HTMLInputElement>('#signup-first')!, 'Priya');
  await type(container.querySelector<HTMLInputElement>('#signup-last')!, 'Raman');
  await type(container.querySelector<HTMLInputElement>('#signup-email')!, '  Priya@Northgate.TEST  ');
  await type(container.querySelector<HTMLInputElement>('#signup-password')!, password);
}

test('the gate is real: the form does not submit until every field, the length rule and the terms are satisfied', async () => {
  const { container } = renderAt('/signup');
  const button = screen.getByRole('button', { name: 'Create account' });

  expect(button).toBeDisabled();
  await fillTheForm(container, 'short');
  expect(button).toBeDisabled();

  // Twelve characters is the contract's minimum, and the screen says how many
  // more are needed rather than only refusing.
  expect(screen.getByText('7 more characters')).toBeInTheDocument();

  await type(container.querySelector<HTMLInputElement>('#signup-password')!, 'a-long-enough-passphrase');
  expect(button).toBeDisabled(); // the terms are still unticked

  await click(container.querySelector('#signup-terms')!);
  expect(button).toBeEnabled();

  // Nothing was sent while the gate was shut.
  expect(vi.mocked(signUpPractice)).not.toHaveBeenCalled();
});

test('submit sends the details once', async () => {
  vi.mocked(signUpPractice).mockResolvedValueOnce(undefined);
  const { container } = renderAt('/signup');
  await fillTheForm(container);
  await click(container.querySelector('#signup-terms')!);
  await click(screen.getByRole('button', { name: 'Create account' }));

  expect(vi.mocked(signUpPractice)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(signUpPractice).mock.calls[0]?.[0]).toMatchObject({
    practiceName: 'Northgate Accounts Ltd',
    firstName: 'Priya',
    lastName: 'Raman',
    // The surrounding spaces the test typed are gone before React ever sees
    // them: `<input type="email">` runs the HTML value-sanitisation algorithm,
    // which strips leading and trailing whitespace. The CASE survives, and
    // normalising it is the api layer's job — pinned in `api/signup.test.ts`,
    // where the request that actually travels can be read.
    email: 'Priya@Northgate.TEST',
  });
});

test('a short password refused by the SERVER names the length rule, not a generic failure', async () => {
  vi.mocked(signUpPractice).mockRejectedValueOnce(
    new NtProblemError({
      status: 400,
      code: 'NT-VAL-001',
      title: 'Validation failed',
      errors: [{ field: 'password', message: 'Must be at least 12 characters.' }],
    }),
  );
  const { container } = renderAt('/signup');
  await fillTheForm(container);
  await click(container.querySelector('#signup-terms')!);
  await click(screen.getByRole('button', { name: 'Create account' }));

  expect(screen.getByRole('alert').textContent).toContain('too short');
  expect(screen.getByRole('alert').textContent).toContain('NT-VAL-001');
});

/* ── ② the screen that must not say what happened ────────────────────────── */

test('the check-your-email screen makes no claim about whether an account exists', async () => {
  vi.mocked(signUpPractice).mockResolvedValueOnce(undefined);
  const { container } = renderAt('/signup');
  await fillTheForm(container);
  await click(container.querySelector('#signup-terms')!);
  await click(screen.getByRole('button', { name: 'Create account' }));

  const text = document.body.textContent ?? '';
  expect(text).toContain('Check your email');

  // ⚠ THE ASSERTION THIS TEST EXISTS FOR. Every one of these would answer
  // "is this address registered here" for whoever typed it — the question the
  // uniform 202 refuses. If a copy edit reintroduces one, this fails.
  for (const forbidden of [
    /account created/i,
    /account has been created/i,
    /already registered/i,
    /already have an account with/i,
    /we found your/i,
    /welcome to your new/i,
  ]) {
    expect(text).not.toMatch(forbidden);
  }

  // What it DOES say is conditional, and names the address the visitor typed.
  expect(text).toMatch(/If .* can be used to open an account/i);
});

/* ── ③ the verification link ─────────────────────────────────────────────── */

test('the token is spent once and scrubbed from the address', async () => {
  vi.mocked(verifyEmail).mockResolvedValueOnce({ email: 'priya@northgate.test', alreadyVerified: false });
  await act(async () => {
    renderAt('/signup/verify?token=a-signed-verification-token');
  });

  expect(vi.mocked(verifyEmail)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(verifyEmail).mock.calls[0]?.[0]).toBe('a-signed-verification-token');

  // ⚠ The credential is out of the address bar. A token left in
  // `location.search` travels in the next `Referer` and sits in the history.
  expect(window.location.search).not.toContain('a-signed-verification-token');
  expect(window.location.search).not.toContain('token');

  expect(document.body.textContent).toContain('Email address confirmed');
  expect(document.body.textContent).toContain('priya@northgate.test');
});

test('an already-verified address says so rather than implying something just happened', async () => {
  vi.mocked(verifyEmail).mockResolvedValueOnce({ email: 'priya@northgate.test', alreadyVerified: true });
  await act(async () => {
    renderAt('/signup/verify?token=t');
  });
  expect(document.body.textContent).toContain('was already confirmed');
});

test('expired and not-valid are told apart, because only one of them can be fixed by asking again', async () => {
  vi.mocked(verifyEmail).mockRejectedValueOnce(
    new NtProblemError({ status: 401, code: 'NT-AUTH-005', title: 'Verification link expired' }),
  );
  await act(async () => {
    renderAt('/signup/verify?token=t');
  });
  expect(document.body.textContent).toContain('has expired');
  expect(document.body.textContent).toContain('NT-AUTH-005');
});

test('every other verification failure is one verdict, and says nothing about the account', async () => {
  vi.mocked(verifyEmail).mockRejectedValueOnce(
    new NtProblemError({ status: 401, code: 'NT-AUTH-004', title: 'Verification link not valid' }),
  );
  await act(async () => {
    renderAt('/signup/verify?token=t');
  });
  const text = document.body.textContent ?? '';
  expect(text).toContain('not valid');
  expect(text).not.toMatch(/no such account/i);
  expect(text).not.toMatch(/does not exist/i);
});

test('an address with no token asks for the link instead of posting an empty one', async () => {
  await act(async () => {
    renderAt('/signup/verify');
  });
  expect(vi.mocked(verifyEmail)).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('link is incomplete');
});

/* ── ④ the authenticator ─────────────────────────────────────────────────── */

async function reachTheCodesScreen(password = 'a-long-enough-passphrase') {
  vi.mocked(beginEnrolment).mockResolvedValueOnce({ ...OFFER, recoveryCodes: [...OFFER.recoveryCodes] });
  const { container } = renderAt('/signup/enrol');
  await type(container.querySelector<HTMLInputElement>('#enrol-email')!, 'priya@northgate.test');
  await type(container.querySelector<HTMLInputElement>('#enrol-password')!, password);
  await click(screen.getByRole('button', { name: 'Continue' }));
  return container;
}

test('the QR, the manual key and all ten recovery codes are shown, and the way on is shut until they are saved', async () => {
  const container = await reachTheCodesScreen();

  // The QR is drawn, and it is drawn rather than described: an <img role> with
  // its own accessible name, because to a screen reader it is a picture of a
  // secret and the manual key beside it is the accessible route.
  expect(screen.getByRole('img', { name: /setup code for your authenticator/i })).toBeInTheDocument();
  expect(container.querySelector('svg path')?.getAttribute('d')).toBeTruthy();

  // The manual-entry seed, and all ten codes — shown once, never retrievable.
  expect(document.body.textContent).toContain(OFFER.secret);
  for (const code of OFFER.recoveryCodes) expect(document.body.textContent).toContain(code);
  expect(document.body.textContent).toMatch(/only time they are shown/i);

  const button = screen.getByRole('button', { name: 'Continue' });
  expect(button).toBeDisabled();
  await click(screen.getByRole('checkbox'));
  expect(button).toBeEnabled();
});

test('confirmation needs six digits and sends the token from the offer, unmodified', async () => {
  const container = await reachTheCodesScreen();
  await click(screen.getByRole('checkbox'));
  await click(screen.getByRole('button', { name: 'Continue' }));

  const totp = container.querySelector<HTMLInputElement>('#enrol-totp')!;
  const finish = screen.getByRole('button', { name: 'Finish setup' });
  expect(finish).toBeDisabled();

  // Non-digits never reach the field, and five is not six.
  await type(totp, '12a34b');
  expect(totp.value).toBe('1234');
  expect(finish).toBeDisabled();

  vi.mocked(confirmEnrolment).mockResolvedValueOnce(undefined);
  await type(totp, '123456');
  await click(finish);

  expect(vi.mocked(confirmEnrolment)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(confirmEnrolment).mock.calls[0]?.[0]).toEqual({
    email: 'priya@northgate.test',
    password: 'a-long-enough-passphrase',
    enrolmentToken: OFFER.enrolmentToken,
    totp: '123456',
  });
});

test('a wrong code is recoverable in place — the field clears and the offer survives', async () => {
  const container = await reachTheCodesScreen();
  await click(screen.getByRole('checkbox'));
  await click(screen.getByRole('button', { name: 'Continue' }));

  vi.mocked(confirmEnrolment).mockRejectedValueOnce(
    new NtProblemError({ status: 401, code: 'NT-AUTH-003', title: 'Credentials did not match' }),
  );
  await type(container.querySelector<HTMLInputElement>('#enrol-totp')!, '000000');
  await click(screen.getByRole('button', { name: 'Finish setup' }));

  expect(screen.getByRole('alert').textContent).toMatch(/every 30 seconds/i);
  expect(container.querySelector<HTMLInputElement>('#enrol-totp')!.value).toBe('');
  // Still on the confirm step with the same candidate — a mistyped code does
  // not cost the enrolment.
  expect(screen.getByRole('button', { name: 'Finish setup' })).toBeInTheDocument();
});

test('NT-AUTH-008 starts the enrolment over instead of dead-ending, and says the old codes are gone', async () => {
  const container = await reachTheCodesScreen();
  await click(screen.getByRole('checkbox'));
  await click(screen.getByRole('button', { name: 'Continue' }));

  vi.mocked(confirmEnrolment).mockRejectedValueOnce(
    new NtProblemError({ status: 401, code: 'NT-AUTH-008', title: 'Enrolment session not valid' }),
  );
  await type(container.querySelector<HTMLInputElement>('#enrol-totp')!, '123456');
  await click(screen.getByRole('button', { name: 'Finish setup' }));

  // Back at the first step of enrolment — nothing was written, so starting
  // again costs nothing, which is what the two-step is for.
  expect(container.querySelector('#enrol-password')).toBeInTheDocument();
  // And the superseded codes are off the screen rather than left looking valid.
  expect(document.body.textContent).not.toContain(OFFER.recoveryCodes[0]);
});

test('an account that already has an authenticator is told so, and not to retry', async () => {
  vi.mocked(beginEnrolment).mockRejectedValueOnce(
    new NtProblemError({ status: 409, code: 'NT-AUTH-007', title: 'Already enrolled' }),
  );
  const { container } = renderAt('/signup/enrol');
  await type(container.querySelector<HTMLInputElement>('#enrol-email')!, 'priya@northgate.test');
  await type(container.querySelector<HTMLInputElement>('#enrol-password')!, 'a-long-enough-passphrase');
  await click(screen.getByRole('button', { name: 'Continue' }));

  const alert = screen.getByRole('alert').textContent ?? '';
  expect(alert).toMatch(/already has an authenticator/i);
  expect(alert).toMatch(/recovery codes/i);
  expect(alert).toContain('NT-AUTH-007');
});

test('an unverified address is sent back to the email rather than blamed for its password', async () => {
  vi.mocked(beginEnrolment).mockRejectedValueOnce(
    new NtProblemError({ status: 409, code: 'NT-AUTH-006', title: 'Email address not verified' }),
  );
  const { container } = renderAt('/signup/enrol');
  await type(container.querySelector<HTMLInputElement>('#enrol-email')!, 'priya@northgate.test');
  await type(container.querySelector<HTMLInputElement>('#enrol-password')!, 'a-long-enough-passphrase');
  await click(screen.getByRole('button', { name: 'Continue' }));

  expect(screen.getByRole('alert').textContent).toMatch(/confirm your email address first/i);
});

test('an unreachable server says so rather than blaming the credentials', async () => {
  vi.mocked(beginEnrolment).mockRejectedValueOnce(new Error('network down'));
  const { container } = renderAt('/signup/enrol');
  await type(container.querySelector<HTMLInputElement>('#enrol-email')!, 'priya@northgate.test');
  await type(container.querySelector<HTMLInputElement>('#enrol-password')!, 'a-long-enough-passphrase');
  await click(screen.getByRole('button', { name: 'Continue' }));

  const alert = screen.getByRole('alert').textContent ?? '';
  expect(alert).toMatch(/could not reach the server/i);
  expect(alert).not.toMatch(/did not match/i);
});

/* ── no secret ever reaches the address bar ──────────────────────────────── */

test('nothing secret is in the address at any point of the enrolment', async () => {
  const container = await reachTheCodesScreen();
  await click(screen.getByRole('checkbox'));
  await click(screen.getByRole('button', { name: 'Continue' }));
  vi.mocked(confirmEnrolment).mockResolvedValueOnce(undefined);
  await type(container.querySelector<HTMLInputElement>('#enrol-totp')!, '123456');
  await click(screen.getByRole('button', { name: 'Finish setup' }));

  const href = window.location.pathname + window.location.search;
  expect(href).toBe('/signup/done');
  for (const secret of [OFFER.secret, OFFER.enrolmentToken, ...OFFER.recoveryCodes, '123456']) {
    expect(href).not.toContain(secret);
  }
  expect(document.body.textContent).toContain('You are all set');
});
