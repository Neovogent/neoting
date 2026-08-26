import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  InMemoryCapabilityLinkRateLimiter,
  PER_CODE_HOURLY,
  PER_IP_HOURLY,
  linkRateLimitKey,
  selectCapabilityLinkRateLimiter,
  windowOf,
} from './link-rate-limit.js';

/**
 * The ceiling the 40 bits are measured against. Every test here is about a
 * refusal, because a rate limiter that only proves it lets traffic through has
 * proved nothing.
 */

function at(iso: string): () => Date {
  return () => new Date(iso);
}

describe('per-CODE ceiling — bounds a link that has leaked', () => {
  test(`the ${PER_CODE_HOURLY + 1}th request for one code in an hour is refused`, async () => {
    const limiter = new InMemoryCapabilityLinkRateLimiter(at('2026-08-26T10:00:00Z'));
    for (let i = 0; i < PER_CODE_HOURLY; i += 1) {
      expect((await limiter.consume({ code: 'A7K2M9PQ' })).allowed).toBe(true);
    }
    const verdict = await limiter.consume({ code: 'A7K2M9PQ' });
    expect(verdict.allowed).toBe(false);
    expect(verdict.limitedBy).toBe('code');
    expect(verdict.retryAfterSeconds).toBe(3600);
  });

  test('one code’s ceiling does not touch another code', async () => {
    const limiter = new InMemoryCapabilityLinkRateLimiter(at('2026-08-26T10:00:00Z'));
    for (let i = 0; i <= PER_CODE_HOURLY; i += 1) await limiter.consume({ code: 'A7K2M9PQ' });
    expect((await limiter.consume({ code: 'B8L3N0QR' })).allowed).toBe(true);
  });

  test('a refused request still CONSUMES — the limit holds under a flood rather than merely reporting one', async () => {
    const limiter = new InMemoryCapabilityLinkRateLimiter(at('2026-08-26T10:00:00Z'));
    for (let i = 0; i < PER_CODE_HOURLY + 20; i += 1) await limiter.consume({ code: 'A7K2M9PQ' });
    // Still refused. A limiter that stopped counting once it started refusing
    // would let the very next request through after any pause.
    expect((await limiter.consume({ code: 'A7K2M9PQ' })).allowed).toBe(false);
  });
});

describe('per-IP ceiling — the anti-guessing control', () => {
  test(`the ${PER_IP_HOURLY + 1}th request from one address in an hour is refused, across DIFFERENT codes`, async () => {
    const limiter = new InMemoryCapabilityLinkRateLimiter(at('2026-08-26T10:00:00Z'));
    // Every guess is a different code, which is exactly what a brute force
    // looks like — and exactly what a per-code ceiling alone cannot see.
    for (let i = 0; i < PER_IP_HOURLY; i += 1) {
      expect((await limiter.consume({ code: `GUESS${String(i).padStart(3, '0')}`, ip: '203.0.113.9' })).allowed).toBe(true);
    }
    const verdict = await limiter.consume({ code: 'GUESSXXX', ip: '203.0.113.9' });
    expect(verdict.allowed).toBe(false);
    expect(verdict.limitedBy).toBe('ip');
  });

  test('the IP is consumed BEFORE anything knows whether the code exists — a miss is not free', async () => {
    const limiter = new InMemoryCapabilityLinkRateLimiter(at('2026-08-26T10:00:00Z'));
    // Nothing in `consume` takes an "exists" flag, so this is structural. What
    // the test pins is the consequence: garbage codes exhaust the IP budget.
    for (let i = 0; i < PER_IP_HOURLY; i += 1) await limiter.consume({ code: `!!!${i}`, ip: '198.51.100.4' });
    expect((await limiter.consume({ code: 'A7K2M9PQ', ip: '198.51.100.4' })).allowed).toBe(false);
  });

  test('an exhausted IP still burns its per-code budget, so hitting a blocked code is not the cheap way round', async () => {
    const limiter = new InMemoryCapabilityLinkRateLimiter(at('2026-08-26T10:00:00Z'));
    for (let i = 0; i <= PER_IP_HOURLY; i += 1) await limiter.consume({ code: 'A7K2M9PQ', ip: '198.51.100.4' });
    // The IP refused every one of those, and the code counter still counted
    // them: a different address now finds this code already at its ceiling.
    expect((await limiter.consume({ code: 'A7K2M9PQ', ip: '203.0.113.1' })).allowed).toBe(false);
  });

  test('the IP ceiling binds before the code ceiling when both are exceeded', async () => {
    const limiter = new InMemoryCapabilityLinkRateLimiter(at('2026-08-26T10:00:00Z'));
    for (let i = 0; i < PER_IP_HOURLY + 5; i += 1) await limiter.consume({ code: 'A7K2M9PQ', ip: '198.51.100.4' });
    expect((await limiter.consume({ code: 'A7K2M9PQ', ip: '198.51.100.4' })).limitedBy).toBe('ip');
  });

  test('a request with no resolvable address is bounded by the code ceiling only', async () => {
    const limiter = new InMemoryCapabilityLinkRateLimiter(at('2026-08-26T10:00:00Z'));
    for (let i = 0; i < PER_IP_HOURLY + 10; i += 1) {
      await limiter.consume({ code: `LOCAL${String(i).padStart(3, '0')}` });
    }
    // Not refused: there is no address to attribute this to, and refusing it
    // would break `pnpm dev` while stopping nobody.
    expect((await limiter.consume({ code: 'A7K2M9PQ' })).allowed).toBe(true);
    expect((await limiter.consume({ code: 'A7K2M9PQ', ip: '' })).allowed).toBe(true);
  });
});

describe('the window', () => {
  test('a new hour resets the ceiling', async () => {
    let clock = new Date('2026-08-26T10:59:59Z');
    const limiter = new InMemoryCapabilityLinkRateLimiter(() => clock);
    for (let i = 0; i <= PER_CODE_HOURLY; i += 1) await limiter.consume({ code: 'A7K2M9PQ' });
    expect((await limiter.consume({ code: 'A7K2M9PQ' })).allowed).toBe(false);

    clock = new Date('2026-08-26T11:00:00Z');
    expect((await limiter.consume({ code: 'A7K2M9PQ' })).allowed).toBe(true);
  });

  test('retryAfterSeconds is the seconds left in the window, not a fixed number', async () => {
    const limiter = new InMemoryCapabilityLinkRateLimiter(at('2026-08-26T10:59:30Z'));
    for (let i = 0; i <= PER_CODE_HOURLY; i += 1) await limiter.consume({ code: 'A7K2M9PQ' });
    expect((await limiter.consume({ code: 'A7K2M9PQ' })).retryAfterSeconds).toBe(30);
  });

  test('stale counters are swept, so the map does not grow for the life of the process', async () => {
    let clock = new Date('2026-08-26T10:00:00Z');
    const limiter = new InMemoryCapabilityLinkRateLimiter(() => clock);
    for (let i = 0; i < 50; i += 1) await limiter.consume({ code: `CODE${String(i).padStart(4, '0')}` });

    clock = new Date('2026-08-26T12:00:00Z');
    // The old window's counters are gone, so an old code starts from zero.
    for (let i = 0; i < PER_CODE_HOURLY; i += 1) {
      expect((await limiter.consume({ code: 'CODE0000' })).allowed).toBe(true);
    }
  });

  test('windowOf is integer division on whole seconds', () => {
    expect(windowOf(new Date('2026-08-26T10:00:00Z'))).toBe(windowOf(new Date('2026-08-26T10:59:59Z')));
    expect(windowOf(new Date('2026-08-26T11:00:00Z'))).toBe(windowOf(new Date('2026-08-26T10:00:00Z')) + 1);
  });
});

describe('⚠ the keys never contain a live capability code', () => {
  test('the identity is hashed, and the raw code appears nowhere in the key', () => {
    const key = linkRateLimitKey('code', 'A7K2M9PQ', new Date('2026-08-26T10:00:00Z'));
    expect(key).not.toContain('A7K2M9PQ');
    // Redis holds these for two hours and SCAN enumerates them. An unhashed
    // family would be a live list of working links to clients' documents.
    expect(key).toContain(createHash('sha256').update('A7K2M9PQ').digest('hex'));
    expect(key.startsWith('nt:dlink:code:')).toBe(true);
  });

  test('an IP never appears in a key either', () => {
    expect(linkRateLimitKey('ip', '203.0.113.9', new Date())).not.toContain('203.0.113.9');
  });

  test('the two scopes have separate key families', () => {
    const now = new Date('2026-08-26T10:00:00Z');
    expect(linkRateLimitKey('code', 'X', now)).not.toBe(linkRateLimitKey('ip', 'X', now));
  });
});

describe('selection is by configuration, never by import', () => {
  test('shared counters ask for Redis; otherwise the in-process store', () => {
    const asked: string[] = [];
    const fake = new InMemoryCapabilityLinkRateLimiter();
    const shared = selectCapabilityLinkRateLimiter(true, 'redis://localhost:6379', (url) => {
      asked.push(url);
      return fake;
    });
    expect(shared).toBe(fake);
    expect(asked).toEqual(['redis://localhost:6379']);

    const local = selectCapabilityLinkRateLimiter(false, 'redis://localhost:6379', () => {
      asked.push('should-not-happen');
      return fake;
    });
    expect(local).toBeInstanceOf(InMemoryCapabilityLinkRateLimiter);
    // No Redis connection opened for the in-process branch.
    expect(asked).toEqual(['redis://localhost:6379']);
  });
});
