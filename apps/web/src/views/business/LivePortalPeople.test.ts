import { createIntl } from 'react-intl';
import { expect, test } from 'vitest';

import type { PortalPersonRow } from '../../api/portalPeople';
import { DEFAULT_LOCALE } from '../../i18n';
import { gateFor } from './LivePortalPeople';

/**
 * The People save gate, as a pure decision.
 *
 * ⚠ **The ORDER is the thing being pinned, and it is why this is a unit test
 * rather than a render one.** A rendering test can only observe whichever
 * message came out first, which is exactly the property that would silently
 * change. The gate refuses name → email → a valid email → a duplicate email →
 * the last-owner rule, and the SERVER applies the same order — so a screen and a
 * server that disagreed about which of two problems to report would contradict
 * each other on every slow connection, with the client seeing one answer while
 * typing and a different one after pressing Save.
 *
 * Nothing here is the enforcement. Every one of these refusals is also the
 * server's, and its answer is what gets rendered if this is ever wrong; these
 * exist so the common mistakes cost no round trip.
 */

const intl = createIntl({ locale: DEFAULT_LOCALE, defaultLocale: DEFAULT_LOCALE });

function person(over: Partial<PortalPersonRow> = {}): PortalPersonRow {
  return {
    id: 'con_1',
    name: 'Tom Whyte',
    email: 'tom@americanburger.test',
    jobTitle: 'Head Chef',
    access: 'BUSINESS_STANDARD',
    canSendDocuments: true,
    canSeeTotals: false,
    isYou: false,
    isActive: true,
    addedAt: '2026-08-01T09:00:00.000Z',
    ...over,
  };
}

const OWNER = person({ id: 'con_boss', name: 'Ade Bello', email: 'ade@americanburger.test', access: 'BUSINESS_ADMIN' });

const gate = (
  draft: { name: string; email: string; access: 'BUSINESS_ADMIN' | 'USER_ADMIN' | 'BUSINESS_STANDARD' },
  editing: PortalPersonRow | null = null,
  people: readonly PortalPersonRow[] = [OWNER, person()],
  owners: readonly PortalPersonRow[] = [OWNER],
) => gateFor(intl, draft, editing, people, owners);

const NEW = { name: 'Mary Anne Clarke', email: 'mary@americanburger.test', access: 'BUSINESS_STANDARD' as const };

test('a complete invitation passes', () => {
  expect(gate(NEW)).toBeNull();
});

test('the name is refused FIRST, even when the address is also wrong', () => {
  // The first thing wrong, not the last. A person filling in a form is told
  // about the top of the form.
  const refusal = gate({ name: '   ', email: 'not-an-address', access: 'BUSINESS_STANDARD' });
  expect(refusal).toBe('Enter their name.');
});

test('a missing address is refused before a malformed one', () => {
  expect(gate({ ...NEW, email: '  ' })).toBe('Enter their email address.');
});

test('a malformed address is refused before the duplicate check', () => {
  // The duplicate check needs the workspace's rows; this one does not, so it
  // runs first and an invalid address never reaches it.
  expect(gate({ ...NEW, email: 'mary@' })).toBe('That does not look like an email address.');
  expect(gate({ ...NEW, email: 'mary at example' })).toBe('That does not look like an email address.');
});

test('a duplicate address is refused, case- and whitespace-insensitively', () => {
  // ⚠ One email is one person, because the address IS the sign-in channel: two
  // people sharing one would be sent each other's six-digit codes. It is also
  // the ingest sender-map key (D45).
  expect(gate({ ...NEW, email: '  TOM@AmericanBurger.TEST ' })).toBe(
    'Someone on this business already uses that email address.',
  );
});

test('a REVOKED person still holds their address', () => {
  // Reviving somebody is a different act from inviting a second person under
  // their address, and two rows on one address would make "who sent this"
  // ambiguous for the ingest router.
  const people = [OWNER, person({ isActive: false })];
  expect(gate({ ...NEW, email: 'tom@americanburger.test' }, null, people)).toBe(
    'Someone on this business already uses that email address.',
  );
});

test('an EDIT does not check the address at all — it cannot change one', () => {
  // The address is the sign-in channel and the sender-map key at once, so the
  // contract has no path to change it. A duplicate check against the person's
  // own unchanged address would refuse every edit they ever made.
  expect(gate({ name: 'Tom Whyte', email: 'tom@americanburger.test', access: 'BUSINESS_STANDARD' }, person())).toBeNull();
});

test('the last owner cannot be demoted, and the refusal names the fix', () => {
  const refusal = gate({ name: 'Ade Bello', email: OWNER.email ?? '', access: 'BUSINESS_STANDARD' }, OWNER);
  expect(refusal).toBe('This is your only owner — make someone else an owner first.');
});

test('demoting the last owner to USER_ADMIN is still a demotion', () => {
  // A `USER_ADMIN` may manage people but is not an owner, so the workspace
  // would be left with nobody who can make one — which is the state the rule
  // exists to prevent.
  expect(gate({ name: 'Ade Bello', email: '', access: 'USER_ADMIN' }, OWNER)).toBe(
    'This is your only owner — make someone else an owner first.',
  );
});

test('the rule RELEASES once a second owner exists', () => {
  // A protection with no way out is an outage. The named fix has to work.
  const second = person({ id: 'con_hr', access: 'BUSINESS_ADMIN' });
  expect(gate({ name: 'Ade Bello', email: '', access: 'BUSINESS_STANDARD' }, OWNER, [OWNER, second], [OWNER, second])).toBeNull();
});

test('an owner keeping their role is not a demotion', () => {
  expect(gate({ name: 'Ade Bello', email: '', access: 'BUSINESS_ADMIN' }, OWNER)).toBeNull();
});

test('a NON-owner being changed is never caught by the last-owner rule', () => {
  expect(gate({ name: 'Tom Whyte', email: '', access: 'USER_ADMIN' }, person())).toBeNull();
});

test('the name is refused before the last-owner rule', () => {
  // The order holds all the way down: a blank name on the last owner reports
  // the blank name, which is the thing the person can act on immediately.
  expect(gate({ name: '', email: '', access: 'BUSINESS_STANDARD' }, OWNER)).toBe('Enter their name.');
});
