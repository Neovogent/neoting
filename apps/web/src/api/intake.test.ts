import { afterEach, expect, test, vi } from 'vitest';
import { NtProblemError } from '@neoting/contracts';
import { createBusinessBody } from '@neoting/contracts/zod';

import { buildIntakeRequest, submitClientIntake, type IntakeDraft } from './intake';

/**
 * The intake boundary (launch M7).
 *
 * The rules worth pinning: an unanswered optional is an OMITTED KEY (the
 * questionnaire is the AI's only coding context, and a defaulted `false` is an
 * answer nobody gave), a mobile without a country code is refused before the
 * network rather than guessed at, and a 201 that has drifted from the contract
 * is never reported as a created client.
 */

const FULL_DRAFT: IntakeDraft = {
  name: '  Sparkle Cleaning Ltd  ',
  tradingName: 'Sparkle',
  companyNumber: '12345678',
  industry: 'Commercial cleaning',
  vatRegistered: true,
  vatNumber: 'GB123456789',
  firstName: ' Priya ',
  lastName: ' Shah ',
  email: 'priya@sparkle.example',
  mobile: '+44 7700 900123',
  businessActivity: ' Commercial cleaning for offices and schools ',
  typicalSuppliers: 'Nisbets,  Costco , ',
  typicalCosts: 'Cleaning materials, Wages',
  hasEmployees: 'yes',
  usesSubcontractors: 'no',
  notes: 'Two vans on lease.',
};

const EMPTY_OPTIONALS: IntakeDraft = {
  ...FULL_DRAFT,
  tradingName: '',
  companyNumber: '   ',
  industry: '',
  vatRegistered: false,
  vatNumber: 'GB123456789',
  mobile: '',
  typicalSuppliers: ' , ',
  typicalCosts: '',
  hasEmployees: 'unknown',
  usesSubcontractors: 'unknown',
  notes: '',
};

test('a full draft becomes the contract request, trimmed and E.164-compacted', () => {
  const built = buildIntakeRequest(FULL_DRAFT);
  if (!built.ok) throw new Error('expected the full draft to build');

  expect(built.request).toEqual({
    name: 'Sparkle Cleaning Ltd',
    tradingName: 'Sparkle',
    companyNumber: '12345678',
    industry: 'Commercial cleaning',
    vatRegistered: true,
    vatNumber: 'GB123456789',
    primaryContact: {
      firstName: 'Priya',
      lastName: 'Shah',
      email: 'priya@sparkle.example',
      mobileE164: '+447700900123',
    },
    contextQuestionnaire: {
      businessActivity: 'Commercial cleaning for offices and schools',
      typicalSuppliers: ['Nisbets', 'Costco'],
      typicalCosts: ['Cleaning materials', 'Wages'],
      hasEmployees: true,
      usesSubcontractors: false,
      notes: 'Two vans on lease.',
    },
  });
  // The request must satisfy the contract's own strict schema verbatim.
  expect(createBusinessBody.safeParse(built.request).success).toBe(true);
});

test('an unanswered optional is an omitted key — never null, empty or defaulted', () => {
  const built = buildIntakeRequest(EMPTY_OPTIONALS);
  if (!built.ok) throw new Error('expected the draft to build');

  expect(built.request).not.toHaveProperty('tradingName');
  expect(built.request).not.toHaveProperty('companyNumber');
  expect(built.request).not.toHaveProperty('industry');
  expect(built.request.primaryContact).not.toHaveProperty('mobileE164');
  expect(built.request.contextQuestionnaire).not.toHaveProperty('typicalSuppliers');
  expect(built.request.contextQuestionnaire).not.toHaveProperty('typicalCosts');
  expect(built.request.contextQuestionnaire).not.toHaveProperty('hasEmployees');
  expect(built.request.contextQuestionnaire).not.toHaveProperty('usesSubcontractors');
  expect(built.request.contextQuestionnaire).not.toHaveProperty('notes');
  // A VAT number entered while VAT-registered was off does not travel.
  expect(built.request).not.toHaveProperty('vatNumber');
  expect(createBusinessBody.safeParse(built.request).success).toBe(true);
});

test('a mobile without its country code is refused before the network, not guessed', () => {
  const built = buildIntakeRequest({ ...FULL_DRAFT, mobile: '07700 900123' });
  expect(built).toEqual({ ok: false, refusal: { reason: 'mobileNotE164' } });
});

test('a request the contract would refuse is refused here, with the field named', () => {
  const built = buildIntakeRequest({ ...FULL_DRAFT, businessActivity: 'ok' });
  if (built.ok) throw new Error('expected a refusal');
  expect(built.refusal.reason).toBe('contract');
  if (built.refusal.reason !== 'contract') throw new Error('expected the contract refusal');
  expect(built.refusal.detail).toContain('contextQuestionnaire.businessActivity');
});

// ---- the wire ------------------------------------------------------------

interface Recorded {
  url: string;
  init: RequestInit;
}

function stubFetch(reply: { body: unknown; status?: number }): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal('fetch', (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 201,
        headers: { 'content-type': reply.status && reply.status >= 400 ? 'application/problem+json' : 'application/json' },
      }),
    );
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const CREATED = {
  id: 'biz_sparkle',
  name: 'Sparkle Cleaning Ltd',
  isActive: true,
  createdAt: '2026-08-27T09:00:00.000Z',
};

function builtRequest() {
  const built = buildIntakeRequest(FULL_DRAFT);
  if (!built.ok) throw new Error('expected the full draft to build');
  return built.request;
}

test('the create goes to /v1/businesses with the cookie and an Idempotency-Key', async () => {
  const calls = stubFetch({ body: CREATED });

  const created = await submitClientIntake(builtRequest());

  expect(created.id).toBe('biz_sparkle');
  const [call] = calls;
  if (!call) throw new Error('nothing was sent');
  expect(call.url.endsWith('/v1/businesses')).toBe(true);
  expect(call.init.method).toBe('POST');
  expect(call.init.credentials).toBe('include');
  expect(new Headers(call.init.headers).get('Idempotency-Key')).toBeTruthy();
  expect(JSON.parse(String(call.init.body))).toEqual(builtRequest());
});

test('a 201 that drifted from the contract throws with the field named — never a created client', async () => {
  stubFetch({ body: { ...CREATED, id: 42 } });

  await expect(submitClientIntake(builtRequest())).rejects.toThrow(/off-contract.*id/);
});

test('a problem+json refusal propagates with its NT- code intact', async () => {
  stubFetch({
    status: 400,
    body: { type: 'about:blank', title: 'Bad request', status: 400, code: 'NT-VAL-001', detail: 'name is required' },
  });

  const failure = await submitClientIntake(builtRequest()).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(NtProblemError);
  expect((failure as NtProblemError).code).toBe('NT-VAL-001');
});
