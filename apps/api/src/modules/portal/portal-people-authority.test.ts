import { expect, test } from 'vitest';

import {
  addressTaken,
  effectivePortalRole,
  isLastOwner,
  isPortalAccessRole,
  PORTAL_ACCESS_ROLES,
  portalActorFor,
  type PortalPersonRow,
  splitName,
  toPortalPerson,
} from './portal-people-authority.js';

/**
 * The pure half of "a business manages its own people" (D45, D49).
 *
 * Everything the service refuses is decided here, so these are the tests that
 * say what the rules ARE. The service's own tests prove it asks; the
 * integration suite proves Postgres agrees.
 */

const CREATED = new Date('2026-08-01T09:00:00.000Z');

function row(over: Partial<PortalPersonRow> = {}): PortalPersonRow {
  return {
    id: 'con_1',
    firstName: 'Tom',
    lastName: 'Whyte',
    email: 'tom@americanburger.test',
    role: 'Head Chef',
    portalRole: 'BUSINESS_STANDARD',
    isPrimary: false,
    canSendDocuments: true,
    canSeeTotals: false,
    deactivatedAt: null,
    createdAt: CREATED,
    ...over,
  };
}

// ── The derivation that makes the feature work with no backfill ─────────────

test('a row written before the column existed derives its authority from isPrimary', () => {
  // This is the whole safety argument of the migration: `portal_role` is
  // nullable, nothing was backfilled, and every business that already exists
  // still gets exactly one owner — the primary contact intake wrote.
  expect(effectivePortalRole({ portalRole: null, isPrimary: true })).toBe('BUSINESS_ADMIN');
  expect(effectivePortalRole({ portalRole: null, isPrimary: false })).toBe('BUSINESS_STANDARD');
});

test('an explicit portalRole WINS over isPrimary, including when they disagree', () => {
  // Promoting somebody must not be undone by who happens to receive the chases,
  // and demoting the primary contact must actually demote them.
  expect(effectivePortalRole({ portalRole: 'USER_ADMIN', isPrimary: false })).toBe('USER_ADMIN');
  expect(effectivePortalRole({ portalRole: 'BUSINESS_STANDARD', isPrimary: true })).toBe('BUSINESS_STANDARD');
});

test('only the three business-level roles are portal access roles', () => {
  // The firm's roles are a different partition of the same enum. A client's own
  // person is never practice staff, so granting one here would be a client
  // handing themselves an accountant's role.
  expect([...PORTAL_ACCESS_ROLES]).toEqual(['BUSINESS_ADMIN', 'USER_ADMIN', 'BUSINESS_STANDARD']);
  expect(isPortalAccessRole('PRACTICE_ADMIN')).toBe(false);
  expect(isPortalAccessRole('PRACTICE_STANDARD')).toBe(false);
  expect(isPortalAccessRole('CLIENT_ADMIN')).toBe(false);
  for (const role of PORTAL_ACCESS_ROLES) expect(isPortalAccessRole(role)).toBe(true);
});

// ── The actor, and the null that fails closed ──────────────────────────────

test('a null contact yields an actor no branch of assertCan admits', () => {
  // A chase session sets `contact_id` NULL on purpose. It must not become
  // somebody who can manage people, and `role: null` is refused everywhere.
  const actor = portalActorFor(null);
  expect(actor.role).toBeNull();
  expect(actor.isOwner).toBe(false);
});

test('the actor carries the CONTACT id and mirrors isOwner off BUSINESS_ADMIN', () => {
  expect(portalActorFor(row({ id: 'con_boss', portalRole: 'BUSINESS_ADMIN' }))).toEqual({
    actorId: 'con_boss',
    role: 'BUSINESS_ADMIN',
    isOwner: true,
  });
  expect(portalActorFor(row({ portalRole: 'USER_ADMIN' })).isOwner).toBe(false);
});

// ── Last-owner protection ──────────────────────────────────────────────────

test('the only owner is the last owner; one of two owners is not', () => {
  const solo = [row({ id: 'con_boss', portalRole: 'BUSINESS_ADMIN' }), row({ id: 'con_1' })];
  expect(isLastOwner(solo, 'con_boss')).toBe(true);
  expect(isLastOwner(solo, 'con_1')).toBe(false);

  const pair = [
    row({ id: 'con_boss', portalRole: 'BUSINESS_ADMIN' }),
    row({ id: 'con_hr', portalRole: 'BUSINESS_ADMIN' }),
  ];
  expect(isLastOwner(pair, 'con_boss')).toBe(false);
});

test('a DEACTIVATED owner does not count, so the last live owner is still protected', () => {
  // Counting them would let the last real owner be demoted behind a revoked
  // one, leaving a business nobody can ever administer again.
  const people = [
    row({ id: 'con_boss', portalRole: 'BUSINESS_ADMIN' }),
    row({ id: 'con_gone', portalRole: 'BUSINESS_ADMIN', deactivatedAt: new Date('2026-08-20T00:00:00.000Z') }),
  ];
  expect(isLastOwner(people, 'con_boss')).toBe(true);
});

test('a USER_ADMIN is not an owner, so promoting one does not release the last owner', () => {
  const people = [row({ id: 'con_boss', portalRole: 'BUSINESS_ADMIN' }), row({ id: 'con_hr', portalRole: 'USER_ADMIN' })];
  expect(isLastOwner(people, 'con_boss')).toBe(true);
});

// ── One email is one person ────────────────────────────────────────────────

test('the address check is case- and whitespace-insensitive', () => {
  const people = [row({ id: 'con_1', email: 'tom@americanburger.test' })];
  expect(addressTaken(people, '  TOM@AmericanBurger.TEST ')).toBe(true);
  expect(addressTaken(people, 'someone.else@americanburger.test')).toBe(false);
});

test('a DEACTIVATED person still holds their address', () => {
  // Reviving somebody is a different act from inviting a second person under
  // their address. Letting the second through would put one identity on two
  // rows and make "who sent this" ambiguous for the ingest router (D45).
  const people = [row({ id: 'con_gone', deactivatedAt: new Date('2026-08-20T00:00:00.000Z') })];
  expect(addressTaken(people, 'tom@americanburger.test')).toBe(true);
});

test('a person does not collide with THEMSELVES', () => {
  const people = [row({ id: 'con_1' })];
  expect(addressTaken(people, 'tom@americanburger.test', 'con_1')).toBe(false);
});

test('a row with no email is never a match, including for an empty string', () => {
  // SoT §3.3's phone-only contacts are real, and `''` must not silently
  // collide with one of them.
  const people = [row({ id: 'con_phone', email: null })];
  expect(addressTaken(people, '')).toBe(false);
});

// ── The projection ─────────────────────────────────────────────────────────

test('the projection keeps jobTitle and access apart', () => {
  // The two were easy to confuse while writing this, and the projection is
  // where the confusion would have shipped: `jobTitle` is the free text, and
  // `access` is the enum the last-owner rule keys on.
  const person = toPortalPerson(row({ role: 'Foreman', portalRole: 'USER_ADMIN' }), 'con_1');
  expect(person.jobTitle).toBe('Foreman');
  expect(person.access).toBe('USER_ADMIN');
  expect(person.name).toBe('Tom Whyte');
  expect(person.isYou).toBe(true);
  expect(person.isActive).toBe(true);
  expect(person.addedAt).toBe(CREATED.toISOString());
});

test('isYou is false for everybody else, and for a session with no person at all', () => {
  expect(toPortalPerson(row({ id: 'con_1' }), 'con_other').isYou).toBe(false);
  expect(toPortalPerson(row({ id: 'con_1' }), null).isYou).toBe(false);
});

test('a nameless row reports null rather than an empty string', () => {
  expect(toPortalPerson(row({ firstName: null, lastName: null }), null).name).toBeNull();
  expect(toPortalPerson(row({ firstName: 'Tom', lastName: null }), null).name).toBe('Tom');
});

test('a deactivated row is projected as inactive, not omitted', () => {
  // Removal is revocation. The row survives so the documents they already sent
  // keep their provenance, and the screen shows what happened.
  expect(toPortalPerson(row({ deactivatedAt: new Date() }), null).isActive).toBe(false);
});

// ── One name field, two columns ────────────────────────────────────────────

test('the name splits on the LAST space, keeping multi-part forenames intact', () => {
  expect(splitName('Tom Whyte')).toEqual({ firstName: 'Tom', lastName: 'Whyte' });
  expect(splitName('Mary Anne Clarke')).toEqual({ firstName: 'Mary Anne', lastName: 'Clarke' });
});

test('a single word is a FORENAME with no surname', () => {
  // That is what the screens render first, so the other way round would show a
  // blank where the person's name should be.
  expect(splitName('Cher')).toEqual({ firstName: 'Cher', lastName: null });
});

test('surrounding and repeated whitespace is normalised away', () => {
  expect(splitName('  Tom   Whyte  ')).toEqual({ firstName: 'Tom', lastName: 'Whyte' });
});
