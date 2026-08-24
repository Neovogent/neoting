import { describe, expect, test } from 'vitest';

import { CircuitBreaker } from './circuit-breaker.js';

describe('the circuit breaker (Governance §9.3)', () => {
  test('opens after three consecutive failures, not before', () => {
    const breaker = new CircuitBreaker(() => 0);

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.allows()).toBe(true);

    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    expect(breaker.allows()).toBe(false);
  });

  test('a success in between resets the count — CONSECUTIVE means consecutive', () => {
    const breaker = new CircuitBreaker(() => 0);

    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.allows()).toBe(true);
  });

  test('half-opens after 60 s and lets a probe through', () => {
    let now = 0;
    const breaker = new CircuitBreaker(() => now);

    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.allows()).toBe(false);

    now = 59_999;
    expect(breaker.allows()).toBe(false);

    now = 60_000;
    expect(breaker.state()).toBe('half-open');
    expect(breaker.allows()).toBe(true);
  });

  test('a failed probe re-opens immediately — it does not need three more', () => {
    let now = 0;
    const breaker = new CircuitBreaker(() => now);

    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    now = 60_000;
    expect(breaker.allows()).toBe(true);

    // The probe fails. Requiring three fresh failures here would send three
    // times the traffic at a provider that just told us it is still down.
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    expect(breaker.allows()).toBe(false);
  });

  test('a successful probe closes it', () => {
    let now = 0;
    const breaker = new CircuitBreaker(() => now);

    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    now = 60_000;
    breaker.recordSuccess();

    expect(breaker.state()).toBe('closed');
    expect(breaker.allows()).toBe(true);
  });
});
