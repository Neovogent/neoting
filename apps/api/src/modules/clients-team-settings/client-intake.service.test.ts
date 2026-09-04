import { expect, test } from 'vitest';

import { createBusinessBody } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import { ScopeContextSchema } from '../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import type { AppException } from '../../common/problem/problem.js';
import type { NotificationsService, SendClientInviteInput, SendOutcome } from '../notifications/index.js';
import { ClientIntakeService } from './client-intake.service.js';
import { hashSetupToken } from './setup-link.js';

const PRACTICE = 'prac_1';
const CTX = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: PRACTICE });
const NOW = Date.parse('2026-08-26T09:00:00.000Z');

/** Built through the CONTRACT's own schema, so no test can assert on a body the endpoint would reject. */
function request(over: Record<string, unknown> = {}) {
  return createBusinessBody.parse({
    name: 'Sparkle Cleaning Ltd',
    tradingName: 'Sparkle',
    vatRegistered: true,
    vatNumber: 'GB123456789',
    primaryContact: { firstName: 'Ana', lastName: 'Rossi', email: 'Ana@Sparkle.test' },
    contextQuestionnaire: {
      businessActivity: 'Commercial cleaning for offices and schools',
      typicalSuppliers: ['Nisbets'],
      typicalCosts: ['Cleaning materials', 'Motor expenses'],
      hasEmployees: true,
    },
    ...over,
  });
}

const SENT: SendOutcome = { sent: true, kind: 'client-invite', providerMessageId: 'msg_1' };

/**
 * A fake Prisma that records every write, and a fake transport that records
 * every send. The assertions are on what reaches the database and the email —
 * not on Prisma or SES working.
 */
function harness(options: { outcome?: SendOutcome; practiceName?: string | null; sms?: 'records' | 'throws' } = {}) {
  const writes: { model: string; data: Record<string, unknown> }[] = [];
  const emails: SendClientInviteInput[] = [];
  let sequence = 0;

  const record = (model: string) => async ({ data }: { data: Record<string, unknown> }) => {
    writes.push({ model, data });
    sequence += 1;
    return {
      id: `${model}_${sequence}`,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
      // Enough of a `businesses` row for the projection; the defaults the
      // column definitions supply are spelled out because the fake has none.
      practiceId: PRACTICE,
      tradingName: null,
      companyNumber: null,
      industry: null,
      vatRegistered: false,
      vatNumber: null,
      countryCode: 'GB',
      baseCurrency: 'GBP',
      contextQuestionnaire: null,
      subscriptionStatus: null,
      plan: null,
      subscriptionCurrentPeriodEnd: null,
      isActive: true,
      name: 'unset',
      ...data,
    };
  };

  const tx = {
    $executeRaw: async () => 0,
    practice: {
      findUnique: async () =>
        options.practiceName === null ? null : { name: options.practiceName ?? 'Mercer & Co' },
    },
    business: { create: record('business'), findUnique: async () => null },
    contact: { create: record('contact') },
    integration: { create: record('integration') },
    invite: { create: record('invite') },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;

  const notifications = {
    sendClientInvite: async (input: SendClientInviteInput): Promise<SendOutcome> => {
      emails.push(input);
      return options.outcome ?? SENT;
    },
  } as unknown as NotificationsService;

  const texts: { toE164: string; body: string }[] = [];
  const smsWire =
    options.sms === undefined
      ? undefined
      : {
          sendText: async (toE164: string, body: string) => {
            if (options.sms === 'throws') throw new Error('DESTINATION_PHONE_NUMBER_OPTED_OUT');
            texts.push({ toE164, body });
            return { messageId: 'aws-msg-1' };
          },
        };

  const service = new ClientIntakeService(prisma, notifications, new InMemoryIdempotencyStore(), {
    appOrigin: 'https://app.example.test',
  }, () => NOW, smsWire);

  const of = (model: string) => writes.filter((write) => write.model === model).map((write) => write.data);
  return { service, writes, emails, texts, of };
}

async function refusal(promise: Promise<unknown>): Promise<AppException> {
  return promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: AppException) => error,
  );
}

test('a new client gets EXACTLY ONE integration, and it is an active VT row', async () => {
  const { service, of } = harness();

  await service.createClient(CTX, request(), 'key-1');

  // More than one would give the client two export destinations and A5 refuses
  // that outright. `@@unique([businessId, kind])` stops a duplicate VT; nothing
  // but this count stops a VT *and* a MANUAL, so the count is the assertion.
  const integrations = of('integration');
  expect(integrations).toHaveLength(1);
  expect(integrations[0]).toEqual({ businessId: 'business_1', kind: 'VT', isActive: true });
});

test('the integration row asserts no connection: no orgRef, no tokenRef, no health (D47)', async () => {
  const { service, of } = harness();

  await service.createClient(CTX, request(), 'key-1');

  // Those three columns are what an OAuth ledger connection fills in. A value in
  // any of them would be a claim that something was authorised, and nothing was.
  expect(Object.keys(of('integration')[0] ?? {}).sort()).toEqual(['businessId', 'isActive', 'kind']);
});

test('D47, structurally: the contract has no field for a bank or ledger connection', async () => {
  // The generated body schema is `.strict()`, so this is not a style check — an
  // intake form that grew a connection step could not be sent to this endpoint.
  expect(createBusinessBody.safeParse({ ...request(), bankConnectionId: 'tl_123' }).success).toBe(false);
  expect(createBusinessBody.safeParse({ ...request(), accountingSoftware: 'xero' }).success).toBe(false);
  // And no way to name someone else's practice, either.
  expect(createBusinessBody.safeParse({ ...request(), practiceId: 'prac_2' }).success).toBe(false);
});

test('the business-type profile lands on the business row — the whole point of intake', async () => {
  const { service, of } = harness();

  await service.createClient(CTX, request(), 'key-1');

  expect(of('business')[0]?.['contextQuestionnaire']).toEqual({
    businessActivity: 'Commercial cleaning for offices and schools',
    typicalSuppliers: ['Nisbets'],
    typicalCosts: ['Cleaning materials', 'Motor expenses'],
    hasEmployees: true,
  });
  // The practice comes from the caller's context, never from the body.
  expect(of('business')[0]?.['practiceId']).toBe(PRACTICE);
});

test('the primary contact is stored lower-cased, which is what makes their email routable (D45)', async () => {
  const { service, of } = harness();

  await service.createClient(CTX, request(), 'key-1');

  const contacts = of('contact');
  expect(contacts).toHaveLength(1);
  // `ingestion-routing`'s sender map lower-cases before it looks up, so a
  // contact stored as `Ana@Sparkle.test` would never match mail from
  // `ana@sparkle.test` and every document she sent would land Unrouted.
  expect(contacts[0]?.['email']).toBe('ana@sparkle.test');
  expect(contacts[0]?.['isPrimary']).toBe(true);
});

test('the setup token reaches the client and only its hash reaches the database', async () => {
  const { service, of, emails } = harness();

  await service.createClient(CTX, request(), 'key-1');

  const link = emails[0]?.inviteLink ?? '';
  const token = new URL(link).searchParams.get('setupToken') ?? '';
  expect(token).not.toBe('');

  const invites = of('invite');
  expect(invites).toHaveLength(1);
  expect(invites[0]?.['tokenHash']).toBe(hashSetupToken(token));
  // The plaintext is in the email and nowhere else — a database read must not
  // yield a working link into a client's financial records.
  expect(JSON.stringify(invites[0])).not.toContain(token);
  expect(invites[0]?.['role']).toBe('BUSINESS_ADMIN');
  expect((invites[0]?.['expiresAt'] as Date).toISOString()).toBe('2026-09-02T09:00:00.000Z');
});

test('the invite email is sent from the practice, and names the client', async () => {
  const { service, emails } = harness();

  await service.createClient(CTX, request(), 'key-1');

  expect(emails).toHaveLength(1);
  expect(emails[0]?.practiceName).toBe('Mercer & Co');
  expect(emails[0]?.businessName).toBe('Sparkle Cleaning Ltd');
  // The address as typed — the transport parses it; the lower-casing is a
  // storage decision, not a delivery one.
  expect(emails[0]?.to).toBe('Ana@Sparkle.test');
});

test('a refused email does not undo a created client — the 201 stands and the invite is kept', async () => {
  const { service, of } = harness({
    outcome: { sent: false, kind: 'client-invite', reason: 'rate-limited', retryAfterSeconds: 60 },
  });

  const business = await service.createClient(CTX, request(), 'key-1');

  // Failing here would tell the accountant their client was not created when it
  // was, and their retry would create a second one.
  expect(business.name).toBe('Sparkle Cleaning Ltd');
  expect(of('invite')).toHaveLength(1);
});

test('a caller with no practice cannot add a client — 403, and nothing is written', async () => {
  const { service, writes } = harness();
  const businessOnly = ScopeContextSchema.parse({ actorId: 'usr_2', businessId: 'biz_9' });

  const error = await refusal(service.createClient(businessOnly, request(), 'key-1'));

  expect(error.getStatus()).toBe(403);
  expect(error.code).toBe('NT-PRM-001');
  expect(writes).toHaveLength(0);
});

test('a replayed Idempotency-Key returns the original response and writes nothing twice', async () => {
  const { service, writes } = harness();

  const first = await service.createClient(CTX, request(), 'key-1');
  const second = await service.createClient(CTX, request(), 'key-1');

  expect(second).toEqual(first);
  expect(writes).toHaveLength(4);
});

test('the same key with a different payload is 409, not a second client', async () => {
  const { service } = harness();
  await service.createClient(CTX, request(), 'key-1');

  const error = await refusal(service.createClient(CTX, request({ name: 'Someone Else Ltd' }), 'key-1'));

  expect(error.getStatus()).toBe(409);
  expect(error.code).toBe('NT-IDM-001');
});

test('the response is the contract shape, with no subscription until the client has paid', async () => {
  const { service } = harness();

  const business = await service.createClient(CTX, request(), 'key-1');

  expect(business.subscription).toBeNull();
  expect(business.contextQuestionnaire).toEqual({
    businessActivity: 'Commercial cleaning for offices and schools',
    typicalSuppliers: ['Nisbets'],
    typicalCosts: ['Cleaning materials', 'Motor expenses'],
    hasEmployees: true,
  });
  expect(business.createdAt).toBe('2026-08-26T09:00:00.000Z');
});

test('a client RLS cannot see has no profile to read — 404, never 403', async () => {
  const { service } = harness();

  const error = await refusal(service.getClientProfile(CTX, 'biz_elsewhere'));

  expect(error.getStatus()).toBe(404);
  // And the id is never echoed back: a 404 that quotes the id is a 404 that
  // confirms what was asked for.
  expect(JSON.stringify(error)).not.toContain('biz_elsewhere');
});

// ── the registration SMS (finding 3, 4 Sep 2026) ────────────────────────────

test('a mobile plus the real wire sends the setup link by TEXT too — in the practice’s name, no credential', async () => {
  const { service, texts } = harness({ sms: 'records' });

  await service.createClient(
    CTX,
    request({ primaryContact: { firstName: 'Ana', lastName: 'Rossi', email: 'ana@sparkle.test', mobileE164: '+447700900123' } }),
    'key-sms-1',
  );

  expect(texts).toHaveLength(1);
  expect(texts[0]?.toE164).toBe('+447700900123');
  expect(texts[0]?.body).toContain('Mercer & Co has invited you');
  expect(texts[0]?.body).toContain('https://app.example.test/app/setup?setupToken=');
  // The setup token IS the authorisation; the sign-in code travels separately.
  expect(texts[0]?.body).not.toMatch(/code|password/i);
});

test('no mobile, no SMS — and no wire, no SMS, however many mobiles', async () => {
  const withWire = harness({ sms: 'records' });
  await withWire.service.createClient(CTX, request(), 'key-sms-2');
  expect(withWire.texts).toHaveLength(0);

  const withoutWire = harness();
  await withoutWire.service.createClient(
    CTX,
    request({ primaryContact: { firstName: 'Ana', lastName: 'Rossi', email: 'ana@sparkle.test', mobileE164: '+447700900123' } }),
    'key-sms-3',
  );
  expect(withoutWire.texts).toHaveLength(0);
});

test('a refused SMS — a STOP’d number — never fails the intake: the client exists and the email went', async () => {
  const { service, emails, of } = harness({ sms: 'throws' });

  const business = await service.createClient(
    CTX,
    request({ primaryContact: { firstName: 'Ana', lastName: 'Rossi', email: 'ana@sparkle.test', mobileE164: '+447700900123' } }),
    'key-sms-4',
  );

  expect(business.id).toBeDefined();
  expect(emails).toHaveLength(1);
  expect(of('invite')).toHaveLength(1);
});
