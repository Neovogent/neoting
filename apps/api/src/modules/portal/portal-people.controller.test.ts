import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import type { PortalPeople, PortalPerson } from '@neoting/contracts/model';

import type { AppException } from '../../common/problem/problem.js';
import { PortalPeopleController } from './portal-people.controller.js';
import type { PortalPeopleService } from './portal-people.service.js';
import { type PortalSessionFacts, PortalSessionContextResolver, portalSessionRequired } from './portal-session-context.js';

/**
 * The four People routes as a CONTROLLER — which resolver each reaches, what it
 * parses, and in which order.
 *
 * The rules themselves are elsewhere on purpose: `portal-people-authority.ts`
 * decides them, `assert-can.ts` enforces the authority, and
 * `portal-people.integration.test.ts` proves the whole thing against real
 * Postgres. What can only be tested here is the wiring, and two of those choices
 * are security decisions rather than plumbing.
 */

const KEY = randomUUID();
const EXPIRES = new Date('2026-09-02T12:00:00.000Z');

const FACTS: PortalSessionFacts = {
  otpSessionId: 'otp_1',
  businessId: 'biz_burger',
  practiceId: 'prac_1',
  systemUserId: 'usr_system_1',
  actorId: 'usr_system_1',
  contactId: 'con_boss',
  chaseId: null,
  grantedItemIds: [],
  expiresAt: EXPIRES,
};

const PERSON: PortalPerson = {
  id: 'con_chef',
  name: 'Tom Whyte',
  email: 'tom@americanburger.test',
  jobTitle: 'Head Chef',
  access: 'BUSINESS_STANDARD',
  canSendDocuments: true,
  canSeeTotals: false,
  isYou: false,
  isActive: true,
  addedAt: '2026-09-01T09:00:00.000Z',
};

const PEOPLE: PortalPeople = { people: [PERSON], canManagePeople: true, truncated: false };

const VALID_INVITE = {
  name: 'Tom Whyte',
  email: 'tom@americanburger.test',
  jobTitle: 'Head Chef',
  access: 'BUSINESS_STANDARD',
  canSendDocuments: true,
  canSeeTotals: false,
};

interface Calls {
  resolve: (string | undefined)[];
  /**
   * WHICH resolver method each route reached, in order.
   *
   * ⚠ Not bookkeeping. Every resolver method returns identical facts, so a
   * route silently widening to `resolveForContext` — which accepts a CHASE
   * session — would pass every other assertion in this file while handing the
   * holder of a forwarded link the list of everyone who works at a business.
   */
  resolvedVia: string[];
  listPeople: PortalSessionFacts[];
  invitePerson: { facts: PortalSessionFacts; request: unknown; key: string | undefined }[];
  updatePerson: { facts: PortalSessionFacts; personId: string; request: unknown; key: string | undefined }[];
  removePerson: { facts: PortalSessionFacts; personId: string; key: string | undefined }[];
}

function harness(
  over: { resolve?: () => Promise<PortalSessionFacts> } = {},
): { controller: PortalPeopleController; calls: Calls } {
  const calls: Calls = {
    resolve: [],
    resolvedVia: [],
    listPeople: [],
    invitePerson: [],
    updatePerson: [],
    removePerson: [],
  };

  const record = (via: string) => async (header: string | undefined) => {
    calls.resolve.push(header);
    calls.resolvedVia.push(via);
    return over.resolve === undefined ? FACTS : over.resolve();
  };
  const resolver = {
    resolveForContext: record('context'),
    resolveForUpload: record('upload'),
    resolveOnboarding: record('onboarding'),
    resolveForDocumentOriginal: record('document-original'),
  } as unknown as PortalSessionContextResolver;

  const people = {
    listPeople: async (facts: PortalSessionFacts) => {
      calls.listPeople.push(facts);
      return PEOPLE;
    },
    invitePerson: async (facts: PortalSessionFacts, request: unknown, key: string | undefined) => {
      calls.invitePerson.push({ facts, request, key });
      return PERSON;
    },
    updatePerson: async (facts: PortalSessionFacts, personId: string, request: unknown, key: string | undefined) => {
      calls.updatePerson.push({ facts, personId, request, key });
      return PERSON;
    },
    removePerson: async (facts: PortalSessionFacts, personId: string, key: string | undefined) => {
      calls.removePerson.push({ facts, personId, key });
      return { ...PERSON, isActive: false };
    },
  } as unknown as PortalPeopleService;

  return { controller: new PortalPeopleController(resolver, people), calls };
}

const grab = async (run: () => Promise<unknown>): Promise<AppException> => {
  try {
    await run();
  } catch (e) {
    return e as AppException;
  }
  throw new Error('expected a throw');
};

// ---- the handler list --------------------------------------------------------

test('this controller has exactly FOUR handlers, and a fifth is a contract decision', () => {
  // The same pin `portal.controller.test.ts` puts on the other six. The portal
  // is the smallest surface in the product and the only one a stranger holding
  // a forwarded link can reach, so a route may not appear here by convenience.
  const handlers = Object.getOwnPropertyNames(PortalPeopleController.prototype).filter((n) => n !== 'constructor');
  expect(handlers.sort()).toEqual(['invitePerson', 'listPeople', 'removePerson', 'updatePerson']);
});

// ---- the resolver choice, which is a security decision -----------------------

test('EVERY people route resolves as an OWN-PORTAL session — a chase session reaches none of them', async () => {
  const { controller, calls } = harness();
  await controller.listPeople('Bearer t');
  await controller.invitePerson('Bearer t', KEY, VALID_INVITE);
  await controller.updatePerson('Bearer t', KEY, 'con_chef', { canSeeTotals: true });
  await controller.removePerson('Bearer t', KEY, 'con_chef');

  // Four routes, four `resolveOnboarding` calls, nothing wider. A chase link is
  // deliberately forwardable to whoever holds the paperwork; who works at the
  // business is not theirs to read, let alone change.
  expect(calls.resolvedVia).toEqual(['onboarding', 'onboarding', 'onboarding', 'onboarding']);
  expect(calls.resolve).toEqual(['Bearer t', 'Bearer t', 'Bearer t', 'Bearer t']);
});

// ---- authenticate, THEN validate --------------------------------------------

test('a bad bearer with a bad body is 401, never a 400 that leaks the shape', async () => {
  const { controller, calls } = harness({
    resolve: () => Promise.reject(portalSessionRequired('missing or invalid portal session')),
  });

  const refused = await grab(() => controller.invitePerson(undefined, 'not-a-uuid', { nonsense: true }));
  expect(refused.code).toBe('NT-OTP-002');
  expect(refused.getStatus()).toBe(401);
  // Nothing was parsed and nothing reached the service — a caller with no valid
  // session learns nothing about which of their fields we would have objected
  // to, including whether the address they typed is already known to us.
  expect(calls.invitePerson).toEqual([]);
});

test('the same order holds on the read, which has no body at all', async () => {
  const { controller, calls } = harness({
    resolve: () => Promise.reject(portalSessionRequired('missing or invalid portal session')),
  });
  expect((await grab(() => controller.listPeople(undefined))).code).toBe('NT-OTP-002');
  expect(calls.listPeople).toEqual([]);
});

// ---- Idempotency-Key ---------------------------------------------------------

test('all three mutations require a UUID Idempotency-Key, and the read requires none', async () => {
  const { controller, calls } = harness();

  await controller.listPeople('Bearer t');
  expect(calls.listPeople).toHaveLength(1);

  for (const call of [
    () => controller.invitePerson('Bearer t', undefined, VALID_INVITE),
    () => controller.updatePerson('Bearer t', undefined, 'con_chef', {}),
    () => controller.removePerson('Bearer t', undefined, 'con_chef'),
  ]) {
    const refused = await grab(call);
    expect(refused.code).toBe('NT-VAL-001');
    expect(refused.getStatus()).toBe(400);
  }

  for (const call of [
    () => controller.invitePerson('Bearer t', 'not-a-uuid', VALID_INVITE),
    () => controller.updatePerson('Bearer t', 'not-a-uuid', 'con_chef', {}),
    () => controller.removePerson('Bearer t', 'not-a-uuid', 'con_chef'),
  ]) {
    expect((await grab(call)).code).toBe('NT-VAL-001');
  }

  // None of the refused calls reached the service.
  expect(calls.invitePerson).toEqual([]);
  expect(calls.updatePerson).toEqual([]);
  expect(calls.removePerson).toEqual([]);
});

test('the key is passed THROUGH to the service, which is what makes a replay possible', async () => {
  const { controller, calls } = harness();
  await controller.invitePerson('Bearer t', KEY, VALID_INVITE);
  await controller.updatePerson('Bearer t', KEY, 'con_chef', {});
  await controller.removePerson('Bearer t', KEY, 'con_chef');
  expect(calls.invitePerson[0]?.key).toBe(KEY);
  expect(calls.updatePerson[0]?.key).toBe(KEY);
  expect(calls.removePerson[0]?.key).toBe(KEY);
});

// ---- the boundary parse ------------------------------------------------------

test('the invite body is parsed with the CONTRACT schema — a missing name is a 400', async () => {
  const { controller, calls } = harness();
  const refused = await grab(() => controller.invitePerson('Bearer t', KEY, { ...VALID_INVITE, name: '' }));
  expect(refused.code).toBe('NT-VAL-001');
  expect(calls.invitePerson).toEqual([]);
});

test('a malformed address is refused at the boundary, before the workspace is read', async () => {
  // The save gate's third rung. It is the contract's zod rather than the
  // service's because it needs no rows to answer — and answering it here means
  // an invalid address never reaches the duplicate check, which does.
  const { controller, calls } = harness();
  expect((await grab(() => controller.invitePerson('Bearer t', KEY, { ...VALID_INVITE, email: 'tom@' }))).code).toBe(
    'NT-VAL-001',
  );
  expect(calls.invitePerson).toEqual([]);
});

test('an unknown field is refused — the generated schema is strict', async () => {
  const { controller } = harness();
  const refused = await grab(() =>
    controller.invitePerson('Bearer t', KEY, { ...VALID_INVITE, isOwner: true }),
  );
  expect(refused.code).toBe('NT-VAL-001');
});

test('the update body takes no email, so sending one is refused rather than ignored', async () => {
  // The address is the sign-in channel and the sender-map key at once. Silently
  // dropping it would let a screen believe it had changed one.
  const { controller, calls } = harness();
  const refused = await grab(() => controller.updatePerson('Bearer t', KEY, 'con_chef', { email: 'new@x.test' }));
  expect(refused.code).toBe('NT-VAL-001');
  expect(calls.updatePerson).toEqual([]);
});

test('an empty update body is legitimate — a no-op that still answers current state', async () => {
  const { controller, calls } = harness();
  await expect(controller.updatePerson('Bearer t', KEY, 'con_chef', {})).resolves.toEqual(PERSON);
  expect(calls.updatePerson[0]?.request).toEqual({});
});

// ---- what is handed to the service ------------------------------------------

test('the personId comes from the PATH and the tenancy from the SESSION — never from a body', async () => {
  const { controller, calls } = harness();
  await controller.updatePerson('Bearer t', KEY, 'con_chef', { canSeeTotals: true });
  await controller.removePerson('Bearer t', KEY, 'con_gone');

  expect(calls.updatePerson[0]?.personId).toBe('con_chef');
  expect(calls.removePerson[0]?.personId).toBe('con_gone');
  // The facts are the resolved `otp_sessions` row, whole. No operation on this
  // surface takes a `businessId`, so there is nothing for a caller to supply.
  expect(calls.updatePerson[0]?.facts).toBe(FACTS);
  expect(calls.removePerson[0]?.facts).toBe(FACTS);
});

test('the read returns the server\'s own canManagePeople, unchanged', async () => {
  // The controller adds no opinion. `canManagePeople` is a fact for honest
  // degradation and is computed where the rows are.
  const { controller } = harness();
  await expect(controller.listPeople('Bearer t')).resolves.toEqual(PEOPLE);
});

test('removal answers the person, now inactive — not a bare 204', async () => {
  // The screen renders server truth instead of predicting it, which is what
  // makes "they stop being able to send documents immediately" checkable.
  const { controller } = harness();
  await expect(controller.removePerson('Bearer t', KEY, 'con_chef')).resolves.toMatchObject({ isActive: false });
});
