import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { LivePortalPeople } from './LivePortalPeople';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import type { PortalPeopleList, PortalPersonRow } from '../../api/portalPeople';

/**
 * **The People ROW's affordances** — review items 41 and 42.
 *
 * A render suite beside the pure `LivePortalPeople.test.ts`, which pins the
 * save gate's ORDER and says in its own header why that has to be a unit test.
 * These two items are the opposite shape: what is on the row and what a click
 * on it opens is only observable through the DOM.
 *
 * **Item 42** — *"Give edit option for the owner of the business or the client
 * so that they can edit access of the member of their organization so that if
 * there was any mistake the owner can edit them"*. Every row carried a trash
 * icon and nothing else, so the only recovery from a wrong access level was
 * delete-and-re-add — which, for somebody who has already sent documents, is
 * not a correction. The server half was already there (`PATCH
 * /portal/people/{personId}`, `updatePerson`, and `PortalPersonEditor`'s edit
 * case with its locked email and its demote gate); the list simply never called
 * `setEditing(person)`. So what is pinned is the reachability — the button, and
 * that it opens the editor PRE-FILLED, because an edit form that opens blank
 * would silently blank the fields it was opened to fix.
 *
 * **Item 41** — the access level's description under the select, and that it
 * follows the selection. A static line describing three levels describes none.
 *
 * ⚠ The field queries are ANCHORED REGEXES rather than exact strings, and that
 * is a fact about `Field`: it renders the label and its note inside one
 * `<label>`, so a field's accessible name is "{label}{note}" — correct for a
 * screen reader (the description is announced with the control), and it means
 * an exact-string query matches only the fields that carry no note.
 */

vi.mock('../../api/portalPeople', async () => {
  const actual = await vi.importActual<typeof import('../../api/portalPeople')>('../../api/portalPeople');
  return { ...actual, fetchPortalPeople: vi.fn(), updatePerson: vi.fn(), removePerson: vi.fn(), invitePerson: vi.fn() };
});

const { fetchPortalPeople } = await import('../../api/portalPeople');

const OWNER: PortalPersonRow = {
  id: 'con_owner',
  name: 'Mubashir Khan',
  email: 'mubashir@zeplow.test',
  jobTitle: 'Owner',
  access: 'BUSINESS_ADMIN',
  canSendDocuments: true,
  canSeeTotals: true,
  isYou: true,
  isActive: true,
  addedAt: '2026-08-01T09:00:00.000Z',
};

const STAFF: PortalPersonRow = {
  ...OWNER,
  id: 'con_staff',
  name: 'Neovogent UK LTD',
  email: 'staff@zeplow.test',
  jobTitle: 'Staff',
  access: 'BUSINESS_STANDARD',
  canSeeTotals: false,
  isYou: false,
};

const list = (over: Partial<PortalPeopleList> = {}): PortalPeopleList => ({
  people: [OWNER, STAFF],
  canManagePeople: true,
  truncated: false,
  ...over,
});

afterEach(() => vi.clearAllMocks());

async function renderPanel(over: Partial<PortalPeopleList> = {}) {
  vi.mocked(fetchPortalPeople).mockResolvedValue(list(over));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AppIntlProvider>
        <LivePortalPeople sessionToken="portal-bearer" />
      </AppIntlProvider>
    </QueryClientProvider>,
  );
  // The list is a query; wait for a row rather than flushing microtasks.
  await screen.findByText('Neovogent UK LTD');
}

test('⚠ item 42 — every active row offers an edit affordance, not only a trash icon', async () => {
  await renderPanel();
  expect(screen.getAllByRole('button', { name: /change what they can do/i })).toHaveLength(2);
});

test('⚠ item 42 — the pencil opens the editor PRE-FILLED with that person', async () => {
  await renderPanel();

  // The staff row, not the owner's — the editor must open on the person whose
  // pencil was pressed, which is the one thing a shared "new" form gets wrong.
  fireEvent.click(screen.getAllByRole('button', { name: /change what they can do/i })[1]!);

  expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Neovogent UK LTD');
  expect((screen.getByLabelText(/^Job title/) as HTMLInputElement).value).toBe('Staff');
  expect((screen.getByLabelText(/^What they can do here/) as HTMLSelectElement).value).toBe('BUSINESS_STANDARD');

  // The address is the sign-in channel and the ingest sender-map key at once,
  // so the contract has no path to change it and the form says so rather than
  // offering a field that would be discarded.
  const email = screen.getByLabelText(/^Email address/) as HTMLInputElement;
  expect(email.value).toBe('staff@zeplow.test');
  expect(email.readOnly).toBe(true);
  expect(screen.getByText(/an email address cannot be changed/i)).toBeTruthy();
});

test('⚠ item 41 — the access level describes itself, and the description follows the choice', async () => {
  await renderPanel();
  fireEvent.click(screen.getAllByRole('button', { name: /change what they can do/i })[1]!);

  // The bare noun the reviewer objected to is still the option word — it is the
  // contract's enum and the last-owner rule keys on it — and it now arrives
  // with a sentence saying what it means.
  expect(screen.getByText(/Member — day-to-day use only/)).toBeTruthy();

  fireEvent.change(screen.getByLabelText(/^What they can do here/), { target: { value: 'USER_ADMIN' } });
  expect(screen.getByText(/User administrator — can add, change and remove people/)).toBeTruthy();
  expect(screen.queryByText(/Member — day-to-day use only/)).toBeNull();
});

test('a plain member gets no edit affordance either — the server would refuse the write', async () => {
  // Honest degradation is unchanged by item 42: the list stays readable and the
  // sentence names who can change it. What must NOT appear is a pencil that
  // opens a form whose save is a guaranteed 403.
  await renderPanel({ canManagePeople: false });
  expect(screen.queryByRole('button', { name: /change what they can do/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /^remove$/i })).toBeNull();
  expect(screen.getByText(/only an owner or a user administrator/i)).toBeTruthy();
});
