import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { InviteColleagueForm } from './TeamView';
import { AppIntlProvider } from '../i18n/AppIntlProvider';

/**
 * **Review item 38 — an invitation email must never leave on a mis-click.**
 *
 * > *"If I type the email first and click the client … the mail get sent auto"*
 *
 * The cause was the oldest trap in HTML: a `<button>` inside a `<form>` defaults
 * to `type="submit"`, so the role and client pills — `Chip`, declared two
 * hundred lines from the form it renders inside — ran `onSubmit` the moment
 * they were clicked. The reporter hit it in the order a person naturally works:
 * type the address, then pick the client. Half a dialog, and the invitation is
 * already in somebody's inbox.
 *
 * ⚠ **These tests pin the BEHAVIOUR, not the attribute.** Asserting
 * `type="button"` on today's markup would pass forever and catch nothing: the
 * next pill somebody adds is a fresh `<button>` with the same default. What is
 * asserted instead is that the wire stays silent until the one control that is
 * meant to send it is pressed — which is true of any correct implementation and
 * false of every incorrect one.
 *
 * ## The audit the item also asked for, and its result
 *
 * *"audit **every** form-hosted dialog in the app for the same — the intake
 * form's pill steps, chase composer checkboxes-as-buttons, onboarding steps"*.
 * Done, mechanically: `grep -rl '<form' apps/web/src` returns exactly five
 * files, and this dialog was the only defect among them.
 *
 * | file | verdict |
 * |---|---|
 * | `views/TeamView.tsx` | **the bug.** Fixed here |
 * | `views/business/LiveBusinessPortal.tsx` | clean — every button states its type |
 * | `views/invite/InviteView.tsx` | clean — one submit, no other button inside |
 * | `views/LoginView.tsx` | clean — same shape |
 * | `views/signup/SignupView.tsx` | clean — five forms, each one submit, the loose buttons are outside |
 *
 * The three surfaces the item named by guess — `ClientIntakeForm`, the chase
 * composer, `BusinessOnboardingView` — **host no `<form>` at all.** Their steps
 * are `<button>`s in `<div>`s, so there is no implicit submit to fire and no
 * Enter-key path either. Nothing to fix there; the finding is recorded so the
 * next reader does not re-run the search.
 */

vi.mock('../api/team', async () => {
  const actual = await vi.importActual<typeof import('../api/team')>('../api/team');
  return { ...actual, inviteColleague: vi.fn() };
});

const { inviteColleague } = await import('../api/team');

const CLIENTS = [
  { id: 'biz_zeplow', name: 'Zeplow Inc.' },
  { id: 'biz_burger', name: 'American Burger Ltd' },
];

function renderForm() {
  const onInvited = vi.fn();
  render(
    <AppIntlProvider>
      <InviteColleagueForm clients={CLIENTS} onClose={vi.fn()} onInvited={onInvited} />
    </AppIntlProvider>,
  );
  return { onInvited };
}

/** The reporter's exact sequence: address first, then a client pill. */
test('⚠ item 38 — clicking a client pill after typing the address sends nothing', () => {
  renderForm();

  fireEvent.change(screen.getByPlaceholderText('sam@practice.co.uk'), { target: { value: 'sam@ledgerline.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zeplow Inc.' }));

  expect(inviteColleague).not.toHaveBeenCalled();
  // Still on screen: the dialog "get disappeared" in the report because the
  // submit ran and called `onInvited`, which closes it.
  expect(screen.getByRole('button', { name: /send invitation/i })).toBeTruthy();
});

test('⚠ item 38 — clicking a role pill sends nothing either', () => {
  renderForm();

  fireEvent.change(screen.getByPlaceholderText('sam@practice.co.uk'), { target: { value: 'sam@ledgerline.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Client admin' }));

  expect(inviteColleague).not.toHaveBeenCalled();
});

test('⚠ item 38 — no pill in the dialog submits, whichever order they are pressed', () => {
  renderForm();

  fireEvent.change(screen.getByPlaceholderText('sam@practice.co.uk'), { target: { value: 'sam@ledgerline.test' } });
  // Every button the dialog offers except the two in the footer. If any of them
  // is submit-capable, this loop finds it — including one added tomorrow.
  for (const button of screen.getAllByRole('button')) {
    if (/send invitation|cancel/i.test(button.textContent ?? '')) continue;
    fireEvent.click(button);
  }

  expect(inviteColleague).not.toHaveBeenCalled();
});

test('the explicit Send invitation button is the one thing that sends', async () => {
  vi.mocked(inviteColleague).mockResolvedValue({
    id: 'inv_1',
    businessId: null,
    practiceId: 'prac_1',
    email: 'sam@ledgerline.test',
    role: 'PRACTICE_STANDARD',
    expiresAt: '2026-09-13T09:00:00.000Z',
    acceptedAt: null,
    createdAt: '2026-09-06T09:00:00.000Z',
  });
  const { onInvited } = renderForm();

  fireEvent.change(screen.getByPlaceholderText('sam@practice.co.uk'), { target: { value: 'sam@ledgerline.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zeplow Inc.' }));
  fireEvent.click(screen.getByRole('button', { name: /send invitation/i }));

  await vi.waitFor(() => expect(inviteColleague).toHaveBeenCalledTimes(1));
  // And it carries what the pills collected — the fix must not cost the dialog
  // its state, which a naive `preventDefault` on the pill would have.
  expect(vi.mocked(inviteColleague).mock.calls[0]?.[0]).toMatchObject({
    email: 'sam@ledgerline.test',
    role: 'PRACTICE_STANDARD',
    businessIds: ['biz_zeplow'],
  });
  await vi.waitFor(() => expect(onInvited).toHaveBeenCalled());
});
