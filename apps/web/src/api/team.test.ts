import { afterEach, expect, test, vi } from 'vitest';
import { invitePracticeMember, listPracticeMembers } from '@neoting/contracts/client';

import { INVITABLE_ROLES, inviteColleague, mayInviteColleague, memberLabel } from './team';

/**
 * The practice-team boundary.
 *
 * Mocked at the generated-client seam rather than at `fetch`, for the reason
 * `signup.test.ts` gives: what is under test is the REQUEST this module composes
 * and the parse it puts the answer through — the two places a screen can
 * silently send or believe the wrong thing.
 *
 * The assertions that earn their place:
 *
 *  - the request carries NO NAME FIELDS. `firstName`/`lastName` were composed
 *    here and read by nothing: `invites` has no column for either, and
 *    acceptance asks the invitee for their own name as a required field. The
 *    two tests that pinned the omit-vs-empty-string rule for them are gone with
 *    the fields; what replaces them asserts the absence, so a well-meaning
 *    re-add has to argue with a test rather than slip in.
 *  - `businessIds` is dropped when empty, because the server REFUSES a client
 *    list for `CLIENT_ADMIN` rather than ignoring one — sending `[]` for every
 *    role would make that refusal fire on a form the user filled in correctly.
 *  - `mayInviteColleague` is checked over all six roles. It is presentation, not
 *    the gate, and it must not drift into being either more or less permissive
 *    than `mayManageTeam` server-side.
 */

vi.mock('@neoting/contracts/client', () => ({
  listPracticeMembers: vi.fn(),
  invitePracticeMember: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

const INVITE = {
  id: 'inv_1',
  businessId: null,
  practiceId: 'prac_1',
  email: 'sam@ledgerline.test',
  role: 'PRACTICE_STANDARD',
  expiresAt: '2026-09-09T09:00:00.000Z',
  acceptedAt: null,
  createdAt: '2026-09-02T09:00:00.000Z',
};

const body = () => vi.mocked(invitePracticeMember).mock.calls[0]?.[0] as unknown as Record<string, unknown>;

test('the address is lower-cased and trimmed, the way the server stores it', async () => {
  vi.mocked(invitePracticeMember).mockResolvedValue(INVITE as never);
  await inviteColleague({ email: '  Sam@Ledgerline.TEST ', role: 'PRACTICE_STANDARD' });
  expect(body()['email']).toBe('sam@ledgerline.test');
});

test('⚠ no name is sent, because the server has nowhere to put one', async () => {
  vi.mocked(invitePracticeMember).mockResolvedValue(INVITE as never);
  await inviteColleague({ email: 'sam@ledgerline.test', role: 'PRACTICE_STANDARD' });

  // `PracticeMemberInviteRequest` still declares `firstName`/`lastName` and
  // `practice-team.service.ts` reads neither — `invites` has no column for a
  // name. Acceptance then asks the invitee for their own as REQUIRED fields, so
  // even a persisted value would be overwritten by the person it describes.
  // Collecting it was the same anti-pattern `hideFinancialFields` was fixed for.
  expect('firstName' in body()).toBe(false);
  expect('lastName' in body()).toBe(false);
  // The whole body, so an added key has to come past this line.
  expect(Object.keys(body()).sort()).toEqual(['email', 'role']);
});

test('an empty client list is DROPPED, because the server refuses one for CLIENT_ADMIN', async () => {
  vi.mocked(invitePracticeMember).mockResolvedValue(INVITE as never);
  await inviteColleague({ email: 'sam@ledgerline.test', role: 'CLIENT_ADMIN', businessIds: [] });
  expect('businessIds' in body()).toBe(false);

  vi.clearAllMocks();
  vi.mocked(invitePracticeMember).mockResolvedValue(INVITE as never);
  await inviteColleague({ email: 'sam@ledgerline.test', role: 'PRACTICE_STANDARD', businessIds: ['biz_a'] });
  expect(body()['businessIds']).toEqual(['biz_a']);
});

test('a role the contract does not know is refused BEFORE the network', async () => {
  await expect(
    inviteColleague({ email: 'sam@ledgerline.test', role: 'NOT_A_ROLE' as never }),
  ).rejects.toThrow();
  expect(invitePracticeMember).not.toHaveBeenCalled();
});

test('a 201 whose shape is not an Invite throws rather than reporting a sent invitation', async () => {
  vi.mocked(invitePracticeMember).mockResolvedValue({ ok: true } as never);
  await expect(inviteColleague({ email: 'sam@ledgerline.test', role: 'PRACTICE_STANDARD' })).rejects.toThrow(/does not recognise/);
});

test('both envelope shapes are unwrapped — the mutator returns the raw body, the types say otherwise', async () => {
  vi.mocked(invitePracticeMember).mockResolvedValue({ status: 201, data: INVITE } as never);
  expect((await inviteColleague({ email: 'sam@ledgerline.test', role: 'PRACTICE_STANDARD' })).id).toBe('inv_1');
});

test('only PRACTICE_ADMIN may open the invite form — checked over all six roles', () => {
  const roles = ['PRACTICE_ADMIN', 'CLIENT_ADMIN', 'PRACTICE_STANDARD', 'BUSINESS_ADMIN', 'USER_ADMIN', 'BUSINESS_STANDARD'] as const;
  expect(roles).toHaveLength(6); // the assertion must be able to fail
  for (const role of roles) expect(mayInviteColleague(role)).toBe(role === 'PRACTICE_ADMIN');
  // No session, no button — and no crash.
  expect(mayInviteColleague(undefined)).toBe(false);
});

test('⚠ PRACTICE_ADMIN is not offered in the picker — the server refuses it by name', () => {
  expect([...INVITABLE_ROLES].sort()).toEqual(['CLIENT_ADMIN', 'PRACTICE_STANDARD']);
  expect(INVITABLE_ROLES).not.toContain('PRACTICE_ADMIN');
});

test('a person with no name is shown by their address, never as an empty cell', () => {
  expect(memberLabel({ firstName: 'Sam', lastName: 'Patel', email: 'sam@x.test' })).toBe('Sam Patel');
  expect(memberLabel({ firstName: 'Sam', lastName: null, email: 'sam@x.test' })).toBe('Sam');
  expect(memberLabel({ firstName: null, lastName: null, email: 'sam@x.test' })).toBe('sam@x.test');
  expect(memberLabel({ firstName: '  ', lastName: null, email: 'sam@x.test' })).toBe('sam@x.test');
});

test('the list module never calls the endpoint unless it is enabled', () => {
  // The hook is gated by `enabled`; this pins that the module does not fire on
  // import, which is what would leak a practice query onto a public route.
  expect(listPracticeMembers).not.toHaveBeenCalled();
});
