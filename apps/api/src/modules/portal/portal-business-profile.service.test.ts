import { expect, test } from 'vitest';

import type { PrismaClient } from '../../common/db/prisma.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { canonicalHash } from '../approvals/index.js';
import { PortalBusinessProfileService } from './portal-business-profile.service.js';
import type { PortalSessionFacts } from './portal-session-context.js';

/**
 * `PUT /portal/business-profile` — who may restate the business's own record,
 * and what one request actually writes.
 *
 * Three questions, and only three:
 *
 * 1. **Is the gate the owner's, and does a refusal have NO effect?** The write
 *    runs under the practice SYSTEM context, which can see the whole practice,
 *    so `assertCan(actor, 'business.profile.manage')` inside the transaction is
 *    what stands between a `USER_ADMIN` and their employer's company number.
 *    Refused means nothing updated AND nothing audited — a half-effect would be
 *    worse than either answer.
 * 2. **Is an omitted field UNCHANGED and a null an explicit clearing?** The Zod
 *    boundary makes the distinction (optional vs nullable); the service must not
 *    flatten it. Asserted as exact `data` objects, because a spread that turns
 *    absence into `null` clears fields the client never mentioned.
 * 3. **Is the replay cache namespaced by SESSION?** Two sessions reusing one
 *    client-minted UUID must miss, never observe each other — the same key from
 *    the same session replays (no second write), and the same key with a
 *    DIFFERENT payload is the store's documented 409, never a silent re-run.
 *
 * The end-to-end tenancy proof against real RLS belongs to an integration
 * suite; this is the unit half, whose Prisma double simulates the practice
 * scoping (it reads `app.practice_id` out of `scopedDb`'s `set_config` call) so
 * "the acting contact is found IN THIS PRACTICE" is exercised rather than
 * stubbed to always answer.
 */

const FACTS: PortalSessionFacts = {
  otpSessionId: 'otp_1',
  businessId: 'biz_burger',
  practiceId: 'prac_1',
  systemUserId: 'usr_system_1',
  actorId: 'usr_system_1',
  contactId: 'con_owner',
  chaseId: null,
  grantedItemIds: [],
  expiresAt: new Date('2026-09-05T10:00:00.000Z'),
};

interface ContactSeed {
  readonly id: string;
  readonly businessId: string;
  readonly practiceId: string;
  readonly portalRole: string | null;
  readonly isPrimary: boolean;
}

const OWNER: ContactSeed = { id: 'con_owner', businessId: 'biz_burger', practiceId: 'prac_1', portalRole: 'BUSINESS_ADMIN', isPrimary: true };
const USER_ADMIN: ContactSeed = { id: 'con_useradmin', businessId: 'biz_burger', practiceId: 'prac_1', portalRole: 'USER_ADMIN', isPrimary: false };
const STANDARD: ContactSeed = { id: 'con_standard', businessId: 'biz_burger', practiceId: 'prac_1', portalRole: 'BUSINESS_STANDARD', isPrimary: false };

interface Calls {
  /** The `app.*` settings `scopedDb` wrote — the scope the write actually ran under. */
  scope: { actorId: string; practiceId: string }[];
  updates: { where?: unknown; data?: unknown }[];
  audits: Record<string, unknown>[];
}

function harness(contacts: ContactSeed[] = [OWNER, USER_ADMIN, STANDARD]) {
  const calls: Calls = { scope: [], updates: [], audits: [] };
  // What the transaction's `set_config` last established — the simulated RLS
  // context the contact lookup is answered under.
  let practiceInContext: string | null = null;

  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // Two raw statements reach the transaction client: scopedDb's set_config
      // and the audit writer's advisory lock. Only the first sets the context.
      if (strings.join('').includes('set_config')) {
        practiceInContext = String(values[1]);
        calls.scope.push({ actorId: String(values[0]), practiceId: String(values[1]) });
      }
      return 0;
    },
    contact: {
      findFirst: async (args: { where: { id: string; businessId: string; deactivatedAt: null } }) => {
        const found = contacts.find(
          (c) =>
            // The simulated practice scoping: a row outside the context's
            // practice is invisible, the way `contacts`' tenant policy answers.
            c.practiceId === practiceInContext &&
            c.id === args.where.id &&
            c.businessId === args.where.businessId,
        );
        if (found === undefined) return null;
        return {
          id: found.id,
          firstName: 'Sam',
          lastName: 'Holder',
          email: `${found.id}@example.test`,
          role: null,
          portalRole: found.portalRole,
          isPrimary: found.isPrimary,
          canSendDocuments: true,
          canSeeTotals: true,
          deactivatedAt: null,
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
        };
      },
    },
    business: {
      update: async (args: { where?: unknown; data?: unknown }) => {
        calls.updates.push(args);
        return {};
      },
    },
    auditEvent: {
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        calls.audits.push(args.data);
        return {};
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;

  const store = new InMemoryIdempotencyStore();
  return { calls, store, service: new PortalBusinessProfileService(prisma, store) };
}

test('the owner writes THEIR OWN business row, under the practice SYSTEM context', async () => {
  const { service, calls } = harness();
  await service.updateProfile(FACTS, { tradingName: 'Burger & Sons' });

  // The context is the practice's SYSTEM actor — which can see the whole
  // practice, and is exactly why the gate and the fixed `where` below matter.
  expect(calls.scope[0]).toEqual({ actorId: 'usr_system_1', practiceId: 'prac_1' });
  expect(calls.updates).toHaveLength(1);
  // The id is the SESSION's. `updateProfile` takes no businessId argument, so
  // there is nothing for a caller to supply and nothing to pass wrongly.
  expect(calls.updates[0]?.where).toEqual({ id: 'biz_burger' });
});

test('⚠ a USER_ADMIN is refused — profile authority is deliberately NARROWER than people management', async () => {
  // `business.people.manage` admits USER_ADMIN; this action does not. The
  // company number, the VAT registration and the legal structure are the
  // owner's facts to state.
  const { service, calls } = harness();
  await expect(
    service.updateProfile({ ...FACTS, contactId: 'con_useradmin' }, { companyNumber: '01234567' }),
  ).rejects.toMatchObject({ code: 'NT-PRM-001' });
  expect(calls.updates).toHaveLength(0);
  expect(calls.audits).toHaveLength(0);
});

test('a BUSINESS_STANDARD is refused, and the refusal has no effect', async () => {
  const { service, calls } = harness();
  await expect(
    service.updateProfile({ ...FACTS, contactId: 'con_standard' }, { tradingName: 'Nope' }),
  ).rejects.toMatchObject({ code: 'NT-PRM-001' });
  expect(calls.updates).toHaveLength(0);
  expect(calls.audits).toHaveLength(0);
});

test('⚠ a null contactId fails CLOSED — a session that is nobody manages nothing', async () => {
  // A chase session sets contact_id NULL on purpose (the link is forwardable).
  // `resolveOnboarding` refuses it earlier; this is the second, independent no.
  const { service, calls } = harness();
  await expect(service.updateProfile({ ...FACTS, contactId: null }, { tradingName: 'X' })).rejects.toMatchObject({
    code: 'NT-PRM-001',
  });
  expect(calls.updates).toHaveLength(0);
});

test('⚠ the acting contact is found IN THIS PRACTICE — a row the context cannot see resolves to nothing', async () => {
  // The same contact id, seeded under another practice. The double answers
  // `contact.findFirst` only under the practice `set_config` established, so
  // the miss here is the simulated RLS working, not a stub agreeing.
  const { service, calls } = harness([{ ...OWNER, practiceId: 'prac_other' }]);
  await expect(service.updateProfile(FACTS, { tradingName: 'X' })).rejects.toMatchObject({ code: 'NT-PRM-001' });
  expect(calls.updates).toHaveLength(0);
  expect(calls.audits).toHaveLength(0);
});

test('a body of no answers writes nothing and audits nothing — the skippable step, skipped', async () => {
  const { service, calls } = harness();
  await service.updateProfile(FACTS, {});
  expect(calls.updates).toHaveLength(0);
  expect(calls.audits).toHaveLength(0);
});

test('⚠ an omitted field is UNCHANGED — the update names ONLY what the request answered', async () => {
  // Exact object, deliberately: a spread that flattened absence into null
  // would clear six fields the client never mentioned, and a toMatchObject
  // would not see them.
  const { service, calls } = harness();
  await service.updateProfile(FACTS, { tradingName: 'Burger & Sons' });
  expect(calls.updates[0]?.data).toEqual({ tradingName: 'Burger & Sons' });
});

test('⚠ a null is an explicit CLEARING, distinct from absence', async () => {
  const { service, calls } = harness();
  await service.updateProfile(FACTS, { companyNumber: null });
  expect(calls.updates[0]?.data).toEqual({ companyNumber: null });
});

test('`vatRegistered: false` is an explicit answer, written as given', async () => {
  const { service, calls } = harness();
  await service.updateProfile(FACTS, { vatRegistered: false, vatNumber: null });
  expect(calls.updates[0]?.data).toEqual({ vatRegistered: false, vatNumber: null });
});

test('every change lands one audit row in the practice\'s own chain, with no proposal to point at', async () => {
  const { service, calls } = harness();
  await service.updateProfile(FACTS, { tradingName: 'Burger & Sons', website: 'https://burger.example' });

  expect(calls.audits).toHaveLength(1);
  const outcome = { updatedFields: ['tradingName', 'website'], actingContactId: 'con_owner' };
  expect(calls.audits[0]).toMatchObject({
    businessId: 'biz_burger',
    event: 'business.profile.updated',
    // A portal caller structurally cannot have a proposal; the audit row is
    // what replaces the human gate.
    proposalId: null,
    payloadHash: canonicalHash(outcome),
    outcome,
  });
});

test('a replayed Idempotency-Key does the work ONCE', async () => {
  const { service, calls } = harness();
  const key = '3f1c1de2-6f6f-4d0e-9c2b-0a4c9d8e7f61';
  await service.updateProfile(FACTS, { tradingName: 'Burger & Sons' }, key);
  await service.updateProfile(FACTS, { tradingName: 'Burger & Sons' }, key);

  expect(calls.updates).toHaveLength(1);
  expect(calls.audits).toHaveLength(1);
});

test('⚠ the same key with a DIFFERENT payload is the documented 409, never a silent re-run', async () => {
  const { service, calls } = harness();
  const key = '3f1c1de2-6f6f-4d0e-9c2b-0a4c9d8e7f61';
  await service.updateProfile(FACTS, { tradingName: 'Burger & Sons' }, key);
  await expect(service.updateProfile(FACTS, { tradingName: 'Someone Else Ltd' }, key)).rejects.toMatchObject({
    code: 'NT-IDM-001',
  });
  expect(calls.updates).toHaveLength(1);
});

test('⚠ the replay cache is namespaced by SESSION — one key reused across two sessions MISSES', async () => {
  // Two clients minting the same UUID must never observe each other; the
  // second session's write happens rather than replaying the first's.
  const { service, calls } = harness();
  const key = '3f1c1de2-6f6f-4d0e-9c2b-0a4c9d8e7f61';
  await service.updateProfile(FACTS, { tradingName: 'Burger & Sons' }, key);
  await service.updateProfile({ ...FACTS, otpSessionId: 'otp_2' }, { tradingName: 'Burger & Sons' }, key);

  expect(calls.updates).toHaveLength(2);
  expect(calls.audits).toHaveLength(2);
});
