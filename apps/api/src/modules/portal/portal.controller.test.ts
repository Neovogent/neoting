import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import type { DocumentUpload, PortalContext } from '@neoting/contracts/model';

import type { AppException } from '../../common/problem/problem.js';
import type { PortalContextService } from './portal-context.service.js';
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
  getContext: PortalSessionFacts[];
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
    getContext: [],
    createUpload: [],
  };

  const sessions = {
    createSession: async (input: unknown) => {
      calls.createSession.push(input);
      return over.session === undefined ? { token: 'portal.bearer', expiresAt: EXPIRES } : over.session();
    },
  } as unknown as PortalSessionService;

  const resolver = {
    resolve: async (header: string | undefined) => {
      calls.resolve.push(header);
      return over.resolve === undefined ? FACTS : over.resolve();
    },
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

  return { controller: new PortalController(sessions, resolver, context, uploads, onboarding), calls };
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

test('the five contracted routes are the WHOLE surface — nothing else is reachable on the portal', () => {
  // `openapi.yaml` declares exactly `createPortalSession`, `getPortalContext`,
  // `createPortalUpload`, `createPortalSignInCode` and
  // `createPortalOnboardingSession` under the `portal` tag. The portal is the
  // smallest surface in the product and the only one a stranger holding a
  // forwarded link can reach, so a SIXTH handler appearing here is a contract
  // change (G7), not a convenience — this pins it.
  //
  // It read `three` until the S7 walkthrough: the last two were published by
  // S0's ID LAW batch and implemented by nobody, so an invited client's sign-in
  // 404'd. Growing this list was the contract being MET, not widened — and it
  // is the one direction that may be taken without an issue first.
  const handlers = Object.getOwnPropertyNames(PortalController.prototype).filter((name) => name !== 'constructor');
  expect(handlers.sort()).toEqual([
    'createOnboardingSession',
    'createSession',
    'createSignInCode',
    'createUpload',
    'getContext',
  ]);
});
