import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';
import type { Response } from 'express';

import type { AppException } from '../../common/problem/problem.js';
import type { EmailVerificationService } from './email-verification.service.js';
import { RateLimitedException, SIGN_IN_MAX_FAILURES } from './sign-in-throttle.js';
import { SignupChainController } from './signup-chain.controller.js';
import type { TotpEnrolmentService } from './totp-enrolment.service.js';

const KEY = randomUUID();
const EMAIL = 'priya@ledgerline.test';
const PASSWORD = 'a-long-enough-passphrase';

const OFFER = {
  enrolmentToken: 'ticket.sig',
  uri: 'otpauth://totp/Neo%20Accounting:priya@ledgerline.test?secret=ABC',
  secret: 'ABCDEFGHIJKLMNOP',
  recoveryCodes: ['abcd-efgh-jkmn-pqrs', 'tuvw-xyz2-3456-789a'] as const,
};

interface Calls {
  verify: string[];
  begin: unknown[];
  confirm: unknown[];
}

function harness(throwing?: Error): { controller: SignupChainController; calls: Calls; headers: Record<string, string> } {
  const calls: Calls = { verify: [], begin: [], confirm: [] };
  const raise = (): never => {
    throw throwing;
  };

  const verification = {
    verify: async (token: string) => {
      calls.verify.push(token);
      if (throwing) raise();
      return { email: EMAIL, alreadyVerified: false };
    },
  } as unknown as EmailVerificationService;

  const enrolment = {
    begin: async (input: unknown) => {
      calls.begin.push(input);
      if (throwing) raise();
      return OFFER;
    },
    confirm: async (input: unknown) => {
      calls.confirm.push(input);
      if (throwing) raise();
    },
  } as unknown as TotpEnrolmentService;

  return { controller: new SignupChainController(verification, enrolment), calls, headers: {} };
}

/** Just enough of express's Response for `@Res({ passthrough: true })`. */
function res(headers: Record<string, string>): Response {
  return { setHeader: (name: string, value: string) => (headers[name] = value) } as unknown as Response;
}

async function grab(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a throw');
}

test('each route parses with the generated schema and calls ONE service method', async () => {
  const { controller, calls, headers } = harness();

  expect(await controller.verifyEmailAddress({ token: 'tok.sig' }, KEY, res(headers))).toEqual({
    email: EMAIL,
    alreadyVerified: false,
  });
  expect(calls.verify).toEqual(['tok.sig']);

  const offer = await controller.beginTotpEnrolment({ email: EMAIL, password: PASSWORD }, res(headers));
  expect(offer).toEqual({ ...OFFER, recoveryCodes: [...OFFER.recoveryCodes] });
  expect(calls.begin).toEqual([{ email: EMAIL, password: PASSWORD }]);

  const confirmation = { email: EMAIL, password: PASSWORD, enrolmentToken: 'ticket.sig', totp: '123456' };
  await controller.confirmTotpEnrolment(confirmation, KEY, res(headers));
  expect(calls.confirm).toEqual([confirmation]);
});

test('the recovery codes are COPIED out of the offer, not aliased into the response', async () => {
  const { controller, headers } = harness();
  const offer = await controller.beginTotpEnrolment({ email: EMAIL, password: PASSWORD }, res(headers));

  offer.recoveryCodes.push('mutated');
  expect(OFFER.recoveryCodes).toHaveLength(2);
});

test('the contract-required Idempotency-Key is enforced on the two mutations — missing or not a UUID is a 400', async () => {
  const { controller, calls, headers } = harness();

  for (const key of [undefined, 'not-a-uuid']) {
    const verification = await grab(() => controller.verifyEmailAddress({ token: 'tok.sig' }, key, res(headers)));
    expect(verification.code).toBe('NT-VAL-001');
    expect(verification.getStatus()).toBe(400);

    const confirmation = await grab(() =>
      controller.confirmTotpEnrolment(
        { email: EMAIL, password: PASSWORD, enrolmentToken: 't', totp: '123456' },
        key,
        res(headers),
      ),
    );
    expect(confirmation.getStatus()).toBe(400);
  }
  // A 400 at the boundary means the service was never reached — the point of
  // the header being `required: true` rather than advisory.
  expect(calls.verify).toEqual([]);
  expect(calls.confirm).toEqual([]);
});

test('beginTotpEnrolment takes NO Idempotency-Key, because it writes nothing', async () => {
  // `x-nt-side-effect: none`. The contract checker only demands the header on
  // an operation that mutates, and this one deliberately does not — see
  // `totp-enrolment.service.ts` for why the candidate lives in the ticket.
  const { controller, calls, headers } = harness();
  await controller.beginTotpEnrolment({ email: EMAIL, password: PASSWORD }, res(headers));
  expect(calls.begin).toHaveLength(1);
});

test('the body is parsed STRICTLY: a stray field, a bad address and a five-digit code are all named 400s', async () => {
  const { controller, calls, headers } = harness();

  const stray = await grab(() =>
    controller.beginTotpEnrolment({ email: EMAIL, password: PASSWORD, totp: '123456' }, res(headers)),
  );
  expect(stray.code).toBe('NT-VAL-001');

  const badAddress = await grab(() => controller.beginTotpEnrolment({ email: 'not-an-address', password: PASSWORD }, res(headers)));
  expect(badAddress.code).toBe('NT-VAL-001');

  const shortCode = await grab(() =>
    controller.confirmTotpEnrolment({ email: EMAIL, password: PASSWORD, enrolmentToken: 't', totp: '12345' }, KEY, res(headers)),
  );
  expect(shortCode.code).toBe('NT-VAL-001');

  const emptyToken = await grab(() => controller.verifyEmailAddress({ token: '' }, KEY, res(headers)));
  expect(emptyToken.code).toBe('NT-VAL-001');

  expect(calls.begin).toEqual([]);
  expect(calls.confirm).toEqual([]);
  expect(calls.verify).toEqual([]);
});

test('a 429 carries Retry-After and the three RateLimit headers on ALL THREE routes', async () => {
  // The contract declares them on every `429` and the global ProblemFilter
  // renders only the body, so a route that forgets them answers "too many
  // attempts" with no way for the person to know how long to wait.
  const routes = [
    (c: SignupChainController, r: Response) => c.verifyEmailAddress({ token: 'tok.sig' }, KEY, r),
    (c: SignupChainController, r: Response) => c.beginTotpEnrolment({ email: EMAIL, password: PASSWORD }, r),
    (c: SignupChainController, r: Response) =>
      c.confirmTotpEnrolment({ email: EMAIL, password: PASSWORD, enrolmentToken: 't', totp: '123456' }, KEY, r),
  ];

  for (const route of routes) {
    const { controller, headers } = harness(new RateLimitedException(742));
    const error = await grab(() => route(controller, res(headers)));

    expect(error.code).toBe('NT-RATE-001');
    expect(error.getStatus()).toBe(429);
    expect(headers).toEqual({
      'Retry-After': '742',
      'RateLimit-Limit': String(SIGN_IN_MAX_FAILURES),
      'RateLimit-Remaining': '0',
      'RateLimit-Reset': '742',
    });
  }
});

test('a non-rate-limit failure sets no headers and is rethrown untouched', async () => {
  const { controller, headers } = harness(new Error('database is on fire'));
  const error = await grab(() => controller.verifyEmailAddress({ token: 'tok.sig' }, KEY, res(headers)));

  expect(error.message).toBe('database is on fire');
  expect(headers).toEqual({});
});
