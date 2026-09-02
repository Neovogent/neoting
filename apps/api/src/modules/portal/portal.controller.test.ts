import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import type { DocumentUpload, PortalContext } from '@neoting/contracts/model';

import type { AppException } from '../../common/problem/problem.js';
import type { PortalContextService } from './portal-context.service.js';
import type { PortalDocumentsService } from './portal-documents.service.js';
import { type PortalSessionFacts, PortalSessionContextResolver, portalSessionRequired } from './portal-session-context.js';
import type { PortalSessionService } from './portal-session.service.js';
import type { PortalUploadIntent, PortalUploadService } from './portal-upload.port.js';
import type { PortalOnboardingService } from './portal-onboarding.service.js';
import { PortalController } from './portal.controller.js';

const KEY = randomUUID();
const EXPIRES = new Date('2026-08-19T12:00:00.000Z');

const FACTS: PortalSessionFacts = {
  otpSessionId: 'otp_1',
  businessId: 'biz_burger',
  practiceId: 'prac_1',
  systemUserId: 'usr_system_1',
  actorId: 'usr_system_1',
  contactId: null,
  chaseId: 'chase_1',
  grantedItemIds: [],
  expiresAt: EXPIRES,
};

const CONTEXT: PortalContext = {
  businessName: 'American Burger',
  items: [
    {
      transactionId: 'txn_currys',
      merchantName: 'Currys',
      descriptionRaw: 'CURRYS 1234 LONDON',
      amountPence: -129_900,
      bookedAt: '2026-08-09T12:00:00.000Z',
      received: false,
    },
  ],
  expiresAt: EXPIRES.toISOString(),
};

const UPLOAD: DocumentUpload = {
  uploadId: 'claims.sig',
  upload: { method: 'PUT', url: 'https://fixture.local/put', headers: {} },
  expiresAt: EXPIRES.toISOString(),
  maxBytes: 26_214_400,
};

interface Calls {
  createSession: unknown[];
  requestSignInCode: unknown[];
  createOnboardingSession: unknown[];
  resolve: (string | undefined)[];
  /**
   * WHICH resolver method each route reached, in order.
   *
   * Not bookkeeping: the choice is a security decision on two of these routes.
   * `getDocuments` must resolve as an OWN-PORTAL session (`resolveOnboarding`),
   * because a chase link is forwardable and its holder may not read the
   * client's whole document history — and nothing else in the handler would
   * catch that regression, since every method returns the same facts.
   */
  resolvedVia: string[];
  getContext: PortalSessionFacts[];
  listDocuments: { facts: PortalSessionFacts; query: { cursor?: string | undefined; limit: number } }[];
  createUpload: { facts: PortalSessionFacts; request: PortalUploadIntent; key: string | undefined }[];
}

function harness(
  over: {
    session?: () => Promise<{ token: string; expiresAt: Date }>;
    resolve?: () => Promise<PortalSessionFacts>;
    onboarding?: () => Promise<{ token: string; expiresAt: Date } | null>;
    context?: () => Promise<PortalContext>;
  } = {},
): { controller: PortalController; calls: Calls } {
  const calls: Calls = {
    createSession: [],
    requestSignInCode: [],
    createOnboardingSession: [],
    resolve: [],
    resolvedVia: [],
    getContext: [],
    listDocuments: [],
    createUpload: [],
  };

  const sessions = {
    createSession: async (input: unknown) => {
      calls.createSession.push(input);
      return over.session === undefined ? { token: 'portal.bearer', expiresAt: EXPIRES } : over.session();
    },
  } as unknown as PortalSessionService;

  // The context read and the upload resolve through the WIDENED methods — each
  // accepts a chase session or a client's own portal session. `getDocuments`
  // deliberately does not, so every method is stubbed SEPARATELY and records
  // which one was reached: they all return the same facts, so a route silently
  // switching to a wider door would otherwise pass every assertion.
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

  const context = {
    getContext: async (facts: PortalSessionFacts) => {
      calls.getContext.push(facts);
      return over.context === undefined ? CONTEXT : over.context();
    },
  } as unknown as PortalContextService;

  // The real implementation (`PrismaPortalUploadService`) has an object store, a
  // Prisma client and a signing secret behind it. The controller's whole job is
  // to hand it the resolved session, the parsed intent and the key — which is
  // why it depends on the PORT and this can record exactly that.
  const uploads: PortalUploadService = {
    createPortalUpload: async (facts, request, key) => {
      calls.createUpload.push({ facts, request, key });
      return UPLOAD;
    },
  };

  // The onboarding service the two invited-client routes call. Recorded rather
  // than exercised here — `portal-onboarding.service.test.ts` owns its rules.
  const onboarding = {
    requestSignInCode: async (input: unknown) => {
      calls.requestSignInCode.push(input);
    },
    createOnboardingSession: async (input: unknown) => {
      calls.createOnboardingSession.push(input);
      return over.onboarding === undefined ? { token: 'portal.bearer', expiresAt: EXPIRES } : over.onboarding();
    },
  } as unknown as PortalOnboardingService;

  // `GET /portal/documents`. Records the facts and the parsed query, which is
  // the whole of what the controller owes it — the tenancy lives in the service
  // (`portal-documents.service.ts`) and is proven against real RLS in
  // `portal-client-surface.integration.test.ts`.
  const documents = {
    listDocuments: async (facts: PortalSessionFacts, query: { cursor?: string | undefined; limit: number }) => {
      calls.listDocuments.push({ facts, query });
      return { data: [], pageInfo: { nextCursor: null, hasMore: false } };
    },
  } as unknown as PortalDocumentsService;

  return { controller: new PortalController(sessions, resolver, context, uploads, onboarding, documents), calls };
}

async function grab(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a throw');
}

test('POST /portal/sessions hands the link and the OTP to the service and returns the bearer with an ISO expiry', async () => {
  const { controller, calls } = harness();
  const body = { linkToken: 'tok.sig', otp: '000000' };

  expect(await controller.createSession(body, KEY)).toEqual({ token: 'portal.bearer', expiresAt: EXPIRES.toISOString() });
  expect(calls.createSession).toEqual([body]);
});

test('the contract-required Idempotency-Key is enforced on both mutations — missing or not a UUID is a 400, not a silent write', async () => {
  const { controller } = harness();

  for (const key of [undefined, 'not-a-uuid']) {
    const session = await grab(() => controller.createSession({ linkToken: 'tok.sig', otp: '000000' }, key));
    expect(session.code).toBe('NT-VAL-001');
    expect(session.getStatus()).toBe(400);

    const upload = await grab(() => controller.createUpload({ filename: 'a.jpg', mimeType: 'image/jpeg', byteSize: 1 }, 'Bearer t', key));
    expect(upload.getStatus()).toBe(400);
  }
});

test('the body is parsed with the GENERATED schema: a six-digit OTP is the contract\'s rule, and a stray field is named', async () => {
  const { controller, calls } = harness();

  const shortOtp = await grab(() => controller.createSession({ linkToken: 'tok.sig', otp: '123' }, KEY));
  expect(shortOtp.code).toBe('NT-VAL-001');
  expect(shortOtp.fieldErrors?.map((e) => e.field)).toEqual(['otp']);

  const stray = await grab(() => controller.createSession({ linkToken: 'tok.sig', otp: '000000', chaseId: 'chase_1' }, KEY));
  // Named, not reported as `(body)` — and the VALUE is never echoed back.
  expect(stray.fieldErrors?.map((e) => e.field)).toEqual(['chaseId']);
  expect(JSON.stringify(stray.fieldErrors)).not.toContain('chase_1');

  expect(calls.createSession).toEqual([]); // nothing reached the service
});

test('a verification failure passes through UNCHANGED — one 401 NT-OTP-001 for every reason, decided by the service', async () => {
  const { controller } = harness({
    session: () => Promise.reject(new (class extends Error {})('unused')),
  });
  // The controller must not translate, wrap or re-title what the service threw:
  // the uniform NT-OTP-001 is the whole anti-oracle property, and a controller
  // that mapped errors is where a distinguishable one would reappear.
  const thrown = await grab(() => controller.createSession({ linkToken: 'tok.sig', otp: '000000' }, KEY));
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown.message).toBe('unused');
});

test('GET /portal/context reads the raw Authorization header and passes the resolved facts straight through', async () => {
  const { controller, calls } = harness();
  expect(await controller.getContext('Bearer portal.bearer')).toEqual(CONTEXT);
  expect(calls.resolve).toEqual(['Bearer portal.bearer']);
  expect(calls.getContext).toEqual([FACTS]);
});

test('GET /portal/context with no bearer is 401 NT-OTP-002 and never reaches the read', async () => {
  const { controller, calls } = harness({ resolve: () => Promise.reject(portalSessionRequired('missing or invalid portal session')) });
  const error = await grab(() => controller.getContext(undefined));
  expect(error.code).toBe('NT-OTP-002');
  expect(error.getStatus()).toBe(401);
  expect(calls.getContext).toEqual([]);
});

test('POST /portal/uploads delegates the session, the parsed intent and the key to the upload service', async () => {
  const { controller, calls } = harness();
  const body = { filename: 'currys.jpg', mimeType: 'image/jpeg', byteSize: 204_800, transactionId: 'txn_currys' };

  expect(await controller.createUpload(body, 'Bearer portal.bearer', KEY)).toEqual(UPLOAD);
  expect(calls.createUpload).toEqual([{ facts: FACTS, request: body, key: KEY }]);
});

test('POST /portal/uploads authenticates BEFORE it validates — a bad bearer with a bad body is 401, not a 400 that leaks the shape', async () => {
  const { controller, calls } = harness({ resolve: () => Promise.reject(portalSessionRequired('missing or invalid portal session')) });
  const error = await grab(() => controller.createUpload({ nonsense: true }, undefined, 'also-not-a-uuid'));
  expect(error.code).toBe('NT-OTP-002');
  expect(calls.createUpload).toEqual([]);
});

test('the six contracted routes are the WHOLE surface — nothing else is reachable on the portal', () => {
  // `openapi.yaml` declares exactly `createPortalSession`, `getPortalContext`,
  // `listPortalDocuments`, `createPortalUpload`, `createPortalSignInCode` and
  // `createPortalOnboardingSession` under the `portal` tag. The portal is the
  // smallest surface in the product and the only one a stranger holding a
  // forwarded link can reach, so a SEVENTH handler appearing here is a contract
  // decision, not a convenience — this pins it.
  //
  // It read `three` until the S7 walkthrough (the invited-client pair was
  // published by S0's ID LAW batch and implemented by nobody, so a sign-in
  // 404'd) and `five` until 2 Sep 2026, when `GET /portal/documents` landed —
  // D49's home and upload tabs read it, and the only server-side fact about a
  // client's own documents before it was the integer `documentsSent`.
  const handlers = Object.getOwnPropertyNames(PortalController.prototype).filter((name) => name !== 'constructor');
  expect(handlers.sort()).toEqual([
    'createOnboardingSession',
    'createSession',
    'createSignInCode',
    'createUpload',
    'getContext',
    'getDocuments',
  ]);
});

test('GET /portal/documents resolves as an OWN-PORTAL session, so a forwarded chase link cannot read the whole file', async () => {
  // ⚠ The security decision on this route, and the only place it is visible.
  // A chase link is deliberately forwardable to whoever holds the paperwork
  // (SoT Stage 8.3); their authority is the chased items and the right to
  // upload against them. `resolveOnboarding` is what refuses them the client's
  // entire document history — every supplier, every amount, every date — and it
  // is the same line `getPortalContext` draws by handing a chase session
  // `summary: null` and `businessId: null`.
  const { controller, calls } = harness();
  await controller.getDocuments('Bearer portal.token', {});
  expect(calls.resolvedVia).toEqual(['onboarding']);
  expect(calls.resolve).toEqual(['Bearer portal.token']);
  expect(calls.listDocuments).toHaveLength(1);
  expect(calls.listDocuments[0]?.facts).toBe(FACTS);
});

test('GET /portal/documents coerces the query string — `?limit=25` is a page size, not a 400', async () => {
  // Express delivers every query value as a string while the generated schema
  // types `limit` as a number. Without `coerceQuery` the exact shape the portal
  // sends is a 400 on its first call.
  const { controller, calls } = harness();
  await controller.getDocuments('Bearer portal.token', { limit: '25', cursor: 'abc' });
  expect(calls.listDocuments[0]?.query).toEqual({ limit: 25, cursor: 'abc' });
});

test('GET /portal/documents defaults the page size rather than serving an unbounded list', async () => {
  const { controller, calls } = harness();
  await controller.getDocuments('Bearer portal.token', {});
  expect(calls.listDocuments[0]?.query.limit).toBe(50);
});

test('GET /portal/documents authenticates BEFORE it validates — a bad bearer with a bad query is 401, not a 400 that leaks the shape', async () => {
  const { controller, calls } = harness({ resolve: () => Promise.reject(portalSessionRequired('missing or invalid portal session')) });
  const error = await grab(() => controller.getDocuments(undefined, { limit: 'not-a-number' }));
  expect(error.code).toBe('NT-OTP-002');
  expect(calls.listDocuments).toEqual([]);
});

test('GET /portal/documents refuses a query parameter the contract does not declare', async () => {
  // ⚠ `businessId` above all. The operation declares no such parameter for the
  // reason `PortalUploadRequest` has no `businessId` field: a client does not
  // get to name whose paperwork they are reading. The generated schema is
  // `.strict()`, so an unknown key is a 400 rather than a silently ignored one.
  const { controller, calls } = harness();
  const error = await grab(() => controller.getDocuments('Bearer portal.token', { businessId: 'biz_someone_else' }));
  expect(error.getStatus()).toBe(400);
  expect(calls.listDocuments).toEqual([]);
});
