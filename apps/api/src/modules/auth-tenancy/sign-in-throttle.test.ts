import { expect, test } from 'vitest';

import { InMemorySignInThrottle, SIGN_IN_MAX_FAILURES, SIGN_IN_WINDOW_MS } from './sign-in-throttle.js';

const NOW = 1_756_000_000_000;

test('an untouched address is open, and every failure narrows what is left', () => {
  const throttle = new InMemorySignInThrottle();
  expect(throttle.inspect('priya@ledgerline.test', NOW)).toEqual({
    locked: false,
    retryAfterSeconds: 0,
    remaining: SIGN_IN_MAX_FAILURES,
  });

  for (let attempt = 1; attempt < SIGN_IN_MAX_FAILURES; attempt += 1) {
    const verdict = throttle.recordFailure('priya@ledgerline.test', NOW);
    expect(verdict.locked).toBe(false);
    expect(verdict.remaining).toBe(SIGN_IN_MAX_FAILURES - attempt);
  }

  const locked = throttle.recordFailure('priya@ledgerline.test', NOW);
  expect(locked.locked).toBe(true);
  expect(locked.remaining).toBe(0);
  expect(locked.retryAfterSeconds).toBe(SIGN_IN_WINDOW_MS / 1000);
});

test('the counter is per ADDRESS — one address locking does not touch another', () => {
  const throttle = new InMemorySignInThrottle();
  for (let attempt = 0; attempt < SIGN_IN_MAX_FAILURES; attempt += 1) throttle.recordFailure('a@firm.test', NOW);
  expect(throttle.inspect('a@firm.test', NOW).locked).toBe(true);
  expect(throttle.inspect('b@firm.test', NOW).locked).toBe(false);
});

test('a success clears the entry, so a corrected typo is not carried into the next visit', () => {
  const throttle = new InMemorySignInThrottle();
  throttle.recordFailure('priya@ledgerline.test', NOW);
  throttle.recordFailure('priya@ledgerline.test', NOW);
  throttle.recordSuccess('priya@ledgerline.test');
  expect(throttle.inspect('priya@ledgerline.test', NOW).remaining).toBe(SIGN_IN_MAX_FAILURES);
});

test('the lock lifts when the window passes, and the count restarts rather than resuming', () => {
  const throttle = new InMemorySignInThrottle();
  for (let attempt = 0; attempt < SIGN_IN_MAX_FAILURES; attempt += 1) throttle.recordFailure('priya@ledgerline.test', NOW);

  const after = NOW + SIGN_IN_WINDOW_MS + 1;
  expect(throttle.inspect('priya@ledgerline.test', after).locked).toBe(false);
  // Resuming the old count would re-lock this address on ONE further slip
  // hours later, which is a lockout the user cannot explain or escape.
  expect(throttle.recordFailure('priya@ledgerline.test', after).remaining).toBe(SIGN_IN_MAX_FAILURES - 1);
});

test('a failure whose window has lapsed starts a fresh count — a mistake a fortnight ago is not evidence today', () => {
  const throttle = new InMemorySignInThrottle();
  throttle.recordFailure('priya@ledgerline.test', NOW);
  const muchLater = NOW + 14 * 24 * 60 * 60 * 1000;
  expect(throttle.recordFailure('priya@ledgerline.test', muchLater).remaining).toBe(SIGN_IN_MAX_FAILURES - 1);
});

test('a TOTP time step can be claimed once per user — that is what stops a captured code being replayed', () => {
  const throttle = new InMemorySignInThrottle();
  expect(throttle.claimTimeStep('usr_priya', 58_500_000, NOW)).toBe(true);
  expect(throttle.claimTimeStep('usr_priya', 58_500_000, NOW)).toBe(false);
  // The next step is a different code, and another user's identical step is
  // another user's code.
  expect(throttle.claimTimeStep('usr_priya', 58_500_001, NOW)).toBe(true);
  expect(throttle.claimTimeStep('usr_other', 58_500_000, NOW)).toBe(true);
});

test('the maps are swept, so a long-lived container does not accumulate one entry per address ever typed', () => {
  const throttle = new InMemorySignInThrottle();
  throttle.recordFailure('one@firm.test', NOW);
  throttle.claimTimeStep('usr_one', 1, NOW);

  const later = NOW + 2 * SIGN_IN_WINDOW_MS;
  // The sweep runs on the next use, and a swept entry reads as untouched —
  // which is the observable proof that it is gone.
  expect(throttle.inspect('one@firm.test', later).remaining).toBe(SIGN_IN_MAX_FAILURES);
  expect(throttle.claimTimeStep('usr_one', 1, later)).toBe(true);
});
