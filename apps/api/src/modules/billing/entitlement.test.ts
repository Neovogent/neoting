import { HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import type { SubscriptionStatus } from '@neoting/contracts/model';

import type { AppException } from '../../common/problem/problem.js';
import { assertMayIngest, mayIngest, toBusinessSubscription } from './entitlement.js';

/**
 * All nine cases, not the two that are convenient. This table IS the rule —
 * `docs/runbooks/error-codes.md` fixes it as "not ACTIVE or TRIALING", and a
 * test that only checked ACTIVE and CANCELED would let PAST_DUE quietly become
 * entitled in a later edit.
 */
const CASES: ReadonlyArray<readonly [SubscriptionStatus | null, boolean]> = [
  ['ACTIVE', true],
  ['TRIALING', true],
  // Stripe is still retrying the card. The grace belongs to Stripe's dunning,
  // which has already emailed the client — not to us, silently.
  ['PAST_DUE', false],
  ['INCOMPLETE', false],
  ['INCOMPLETE_EXPIRED', false],
  ['CANCELED', false],
  ['UNPAID', false],
  ['PAUSED', false],
  // Never been through checkout. In ID the client subscribes at the end of
  // their own onboarding, so this is an unfinished signup, not a free tier.
  [null, false],
];

test.each(CASES)('mayIngest(%s) === %s', (status, expected) => {
  expect(mayIngest(status)).toBe(expected);
});

test('undefined is treated as no subscription, not as "unknown so allow"', () => {
  expect(mayIngest(undefined)).toBe(false);
});

test('assertMayIngest is silent for an entitled business', () => {
  expect(() => assertMayIngest({ subscriptionStatus: 'ACTIVE' })).not.toThrow();
});

test('assertMayIngest refuses with NT-BIL-001 at 402, not 403 and not 404', () => {
  let thrown: AppException | undefined;
  try {
    assertMayIngest({ subscriptionStatus: 'CANCELED' });
  } catch (error) {
    thrown = error as AppException;
  }
  expect(thrown?.code).toBe('NT-BIL-001');
  // 402 says what is actually wrong. 403 sends an accountant to their
  // permissions; 404 tells someone their own client is gone.
  expect(thrown?.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
});

test('the refusal names no amount and no card state — Stripe owns both', () => {
  try {
    assertMayIngest({ subscriptionStatus: null });
  } catch (error) {
    const detail = (error as AppException).publicDetail ?? '';
    expect(detail).not.toMatch(/8\.50|card|decline|VAT|£/i);
    // It does say what still works, because that is the promise D32 makes.
    expect(detail).toMatch(/exportable/i);
  }
});

test('the projection is null until the client has been through checkout', () => {
  expect(toBusinessSubscription({ subscriptionStatus: null })).toBeNull();
  expect(toBusinessSubscription({ subscriptionStatus: null, plan: 'price_1' })).toBeNull();
});

test('the projection carries status, plan and the renewal date — and no price', () => {
  const projected = toBusinessSubscription({
    subscriptionStatus: 'ACTIVE',
    plan: 'price_neo_accounting',
    subscriptionCurrentPeriodEnd: new Date('2026-09-26T00:00:00.000Z'),
  });
  expect(projected).toEqual({
    status: 'ACTIVE',
    plan: 'price_neo_accounting',
    currentPeriodEnd: '2026-09-26T00:00:00.000Z',
  });
  // The amount, the VAT and the gross total are Stripe's to show. A second
  // copy here would be a second thing to keep in step with a tax rate.
  expect(Object.keys(projected ?? {})).not.toContain('amountPence');
});

test('an absent plan or period end projects as null rather than being dropped', () => {
  expect(toBusinessSubscription({ subscriptionStatus: 'PAST_DUE' })).toEqual({
    status: 'PAST_DUE',
    plan: null,
    currentPeriodEnd: null,
  });
});
