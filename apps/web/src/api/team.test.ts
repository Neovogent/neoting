import { afterEach, expect, test, vi } from 'vitest';
import {
  invitePracticeMember,
  listPracticeMembers,
  removePracticeMember,
  resendPracticeInvitation,
  revokePracticeInvitation,
  updatePracticeMember,
} from '@neoting/contracts/client';

import {
  INVITABLE_ROLES,
  inviteColleague,
  inviteExpired,
  mayInviteColleague,
  memberLabel,
  removeColleagueAccess,
  resendInvitation,
  revokeInvitation,
  updateColleague,
} from './team';

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
  updatePracticeMember: vi.fn(),
  removePracticeMember: vi.fn(),
  revokePracticeInvitation: vi.fn(),
  resendPracticeInvitation: vi.fn(),
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

/**
 * **Review item 57 — the four management calls.**
 *
 * Same rule as the invite tests above: what is under test is the REQUEST this
 * module composes and the parse it puts the answer through, because those are
 * the two places a screen silently sends or believes the wrong thing. Every
 * REFUSAL — the owner, yourself, `PRACTICE_ADMIN` — is the server's and is
 * proven against a real database in
 * `apps/api/.../practice-invite.integration.test.ts`; a mock asserting them
 * here would only be this module agreeing with itself.
 */

const MEMBER = {
  userId: 'usr_sam',
  email: 'sam@ledgerline.test',
  firstName: 'Sam',
  lastName: 'Patel',
  role: 'PRACTICE_STANDARD',
  isOwner: false,
  businessIds: ['biz_1'],
  createdAt: '2026-08-01T09:00:00.000Z',
};

const updateBody = () => vi.mocked(updatePracticeMember).mock.calls[0]?.[1] as unknown as Record<string, unknown>;

test('⚠ item 57 — an EMPTY client list is SENT, not dropped: it means every client', async () => {
  // The one place the edit path and the invite path deliberately differ. On an
  // invite an empty list is omitted (the server refuses one for CLIENT_ADMIN);
  // on an edit, omitting the key means "leave their scoping alone" and `[]`
  // means "widen them to the whole practice" — and clearing the picker is the
  // second one. Dropping it here would silently do nothing.
  vi.mocked(updatePracticeMember).mockResolvedValue(MEMBER as never);
  await updateColleague('usr_sam', { role: 'PRACTICE_STANDARD', businessIds: [] });

  expect(updateBody()).toEqual({ role: 'PRACTICE_STANDARD', businessIds: [] });
});

test('⚠ item 57 — an omitted client list stays omitted, so a role change is not a widening', async () => {
  vi.mocked(updatePracticeMember).mockResolvedValue(MEMBER as never);
  await updateColleague('usr_sam', { role: 'CLIENT_ADMIN' });

  expect(updateBody()).toEqual({ role: 'CLIENT_ADMIN' });
  expect(Object.keys(updateBody())).not.toContain('businessIds');
});

test('the update body is parsed by the contract before it travels', async () => {
  // A value this screen should not have offered is refused here rather than
  // becoming a server-side 400 the user reads as a bug — the invite path's rule.
  await expect(updateColleague('usr_sam', { role: 'NOT_A_ROLE' as never })).rejects.toThrow();
  expect(updatePracticeMember).not.toHaveBeenCalled();
});

test('the three void-ish calls pass the id through and nothing else', async () => {
  vi.mocked(removePracticeMember).mockResolvedValue(undefined as never);
  vi.mocked(revokePracticeInvitation).mockResolvedValue(undefined as never);

  await removeColleagueAccess('usr_sam');
  await revokeInvitation('inv_1');

  expect(vi.mocked(removePracticeMember).mock.calls[0]?.[0]).toBe('usr_sam');
  expect(vi.mocked(revokePracticeInvitation).mock.calls[0]?.[0]).toBe('inv_1');
});

test('a re-send that answers with a shape this app does not recognise is refused, not rendered', async () => {
  // The screen is about to say "a new link is on its way". Reporting an
  // unverified body as a sent invitation is the failure the invite path pins
  // for the same reason.
  vi.mocked(resendPracticeInvitation).mockResolvedValue({ nonsense: true } as never);
  await expect(resendInvitation('inv_1')).rejects.toThrow(/shape this app does not recognise/);
});

test('a re-send answers the invitation, with its new expiry', async () => {
  const fresh = { ...INVITE, expiresAt: '2026-09-20T09:00:00.000Z' };
  vi.mocked(resendPracticeInvitation).mockResolvedValue(fresh as never);
  await expect(resendInvitation('inv_1')).resolves.toMatchObject({ id: 'inv_1', expiresAt: fresh.expiresAt });
});

test('⚠ item 57 — inviteExpired is what tells a dead link from a live one', () => {
  // Expired invitations are LISTED now, because an expired one the screen
  // cannot show is one nobody can re-send. `expiresAt` is the only thing that
  // distinguishes them — no field was added to `Invite`.
  const at = Date.parse('2026-09-09T09:00:00.000Z');
  expect(inviteExpired({ expiresAt: '2026-09-09T09:00:01.000Z' }, at)).toBe(false);
  expect(inviteExpired({ expiresAt: '2026-09-09T08:59:59.000Z' }, at)).toBe(true);
  // The instant itself is expired: a link that runs out "at 09:00" does not
  // still work at 09:00, and the server's own `expiresAt <= now` says the same.
  expect(inviteExpired({ expiresAt: '2026-09-09T09:00:00.000Z' }, at)).toBe(true);
});
