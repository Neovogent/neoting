import { expect, test } from 'vitest';

import { parseEmailAddress } from './email-address.js';
import { InMemoryEmailRateLimiter, rateLimitKey, RedisEmailRateLimiter } from './email-rate-limit.js';

const ada = parseEmailAddress('ada@example.com');
const grace = parseEmailAddress('grace@example.com');

/** A clock the test moves, so window behaviour is asserted rather than waited for. */
function clock(start = new Date('2026-08-26T10:00:00Z')) {
  let now = start;
  return { read: () => now, advanceSeconds: (s: number) => (now = new Date(now.getTime() + s * 1000)) };
}

test('the sign-in ceiling is five per address per hour, and the sixth is refused', async () => {
  const time = clock();
  const limiter = new InMemoryEmailRateLimiter(time.read);

  for (let i = 0; i < 5; i += 1) {
    expect((await limiter.consume({ kind: 'sign-in-code', address: ada })).allowed).toBe(true);
  }

  const sixth = await limiter.consume({ kind: 'sign-in-code', address: ada });
  expect(sixth.allowed).toBe(false);
  expect(sixth.limitedBy).toBe('address');
  // The window started on the hour, so a full hour remains.
  expect(sixth.retryAfterSeconds).toBe(3600);
});

test('the ceiling is per address — one recipient being blocked does not block another', async () => {
  const limiter = new InMemoryEmailRateLimiter(clock().read);
  for (let i = 0; i < 6; i += 1) await limiter.consume({ kind: 'sign-in-code', address: ada });

  expect((await limiter.consume({ kind: 'sign-in-code', address: grace })).allowed).toBe(true);
});

test('case is folded, so retrying with different capitalisation does not reset the count', async () => {
  const limiter = new InMemoryEmailRateLimiter(clock().read);
  for (let i = 0; i < 5; i += 1) await limiter.consume({ kind: 'sign-in-code', address: ada });

  const evasion = await limiter.consume({ kind: 'sign-in-code', address: parseEmailAddress('ADA@EXAMPLE.COM') });
  expect(evasion.allowed).toBe(false);
});

test('the window rolls, and the counter starts again', async () => {
  const time = clock();
  const limiter = new InMemoryEmailRateLimiter(time.read);
  for (let i = 0; i < 6; i += 1) await limiter.consume({ kind: 'sign-in-code', address: ada });

  time.advanceSeconds(3600);
  expect((await limiter.consume({ kind: 'sign-in-code', address: ada })).allowed).toBe(true);
});

test('retryAfter is the time left in THIS window, not a whole one', async () => {
  const time = clock(new Date('2026-08-26T10:59:00Z'));
  const limiter = new InMemoryEmailRateLimiter(time.read);
  for (let i = 0; i < 5; i += 1) await limiter.consume({ kind: 'sign-in-code', address: ada });

  expect((await limiter.consume({ kind: 'sign-in-code', address: ada })).retryAfterSeconds).toBe(60);
});

test('the IP ceiling catches the attack a per-address ceiling cannot see', async () => {
  // One script, sixty different recipients, one message each. Nothing about
  // that trips a per-address counter — and the reputation damage is identical.
  const limiter = new InMemoryEmailRateLimiter(clock().read);
  for (let i = 0; i < 60; i += 1) {
    const verdict = await limiter.consume({
      kind: 'sign-in-code',
      address: parseEmailAddress(`victim${i}@example.com`),
      ip: '198.51.100.7',
    });
    expect(verdict.allowed).toBe(true);
  }

  const sixtyFirst = await limiter.consume({
    kind: 'sign-in-code',
    address: parseEmailAddress('victim60@example.com'),
    ip: '198.51.100.7',
  });
  expect(sixtyFirst.allowed).toBe(false);
  expect(sixtyFirst.limitedBy).toBe('ip');
});

test('a different IP is unaffected by another IP exhausting its budget', async () => {
  const limiter = new InMemoryEmailRateLimiter(clock().read);
  for (let i = 0; i < 61; i += 1) {
    await limiter.consume({ kind: 'sign-in-code', address: parseEmailAddress(`v${i}@example.com`), ip: '198.51.100.7' });
  }

  const other = await limiter.consume({ kind: 'sign-in-code', address: grace, ip: '203.0.113.9' });
  expect(other.allowed).toBe(true);
});

test('a refused send still consumes the IP budget', async () => {
  // Otherwise the cheapest way to stay under the IP ceiling is to keep hammering
  // an address that is already blocked.
  const limiter = new InMemoryEmailRateLimiter(clock().read);
  for (let i = 0; i < 50; i += 1) await limiter.consume({ kind: 'sign-in-code', address: ada, ip: '198.51.100.7' });

  // 50 attempts on one address: 5 allowed, 45 refused by the address ceiling —
  // all 50 counted against the IP. 10 more from a fresh address fits; the 11th
  // does not.
  for (let i = 0; i < 10; i += 1) {
    expect(
      (await limiter.consume({ kind: 'sign-in-code', address: parseEmailAddress(`v${i}@example.com`), ip: '198.51.100.7' }))
        .allowed,
    ).toBe(true);
  }
  const over = await limiter.consume({ kind: 'sign-in-code', address: grace, ip: '198.51.100.7' });
  expect(over.allowed).toBe(false);
  expect(over.limitedBy).toBe('ip');
});

test('a system-initiated send with no IP is bounded by the address ceiling alone', async () => {
  // A chase batch runs on a worker with no request behind it. A hundred clients
  // chased at once must not exhaust a shared IP budget that does not exist.
  const limiter = new InMemoryEmailRateLimiter(clock().read);
  for (let i = 0; i < 100; i += 1) {
    const verdict = await limiter.consume({ kind: 'document-request', address: parseEmailAddress(`client${i}@example.com`) });
    expect(verdict.allowed).toBe(true);
  }
});

test('ceilings are per kind — an invite and a sign-in code do not share a budget', async () => {
  const limiter = new InMemoryEmailRateLimiter(clock().read);
  for (let i = 0; i < 5; i += 1) await limiter.consume({ kind: 'sign-in-code', address: ada });

  expect((await limiter.consume({ kind: 'sign-in-code', address: ada })).allowed).toBe(false);
  expect((await limiter.consume({ kind: 'client-invite', address: ada })).allowed).toBe(true);
});

test('the key holds no plaintext address, and changes with the window', () => {
  const at10 = rateLimitKey('addr:sign-in-code', 'ada@example.com', new Date('2026-08-26T10:00:00Z'));
  const at11 = rateLimitKey('addr:sign-in-code', 'ada@example.com', new Date('2026-08-26T11:00:00Z'));

  expect(at10).not.toContain('ada');
  expect(at10).not.toContain('example.com');
  expect(at10).toMatch(/^nt:email:addr:sign-in-code:[0-9a-f]{64}:\d+$/);
  expect(at10).not.toBe(at11);
  // Same address, same window, same key — a caller holding the address can
  // still compute it. The hash is not a secret.
  expect(rateLimitKey('addr:sign-in-code', 'ada@example.com', new Date('2026-08-26T10:30:00Z'))).toBe(at10);
});

test('the address and IP key families never collide', () => {
  const now = new Date('2026-08-26T10:00:00Z');
  expect(rateLimitKey('addr:sign-in-code', '198.51.100.7', now)).not.toBe(rateLimitKey('ip', '198.51.100.7', now));
  // And the address families never collide across kinds — that is what keeps an
  // accountant's re-sent invite from locking a client out of signing in.
  expect(rateLimitKey('addr:sign-in-code', 'ada@example.com', now)).not.toBe(
    rateLimitKey('addr:client-invite', 'ada@example.com', now),
  );
});

test('the in-memory limiter drops stale windows rather than growing for the life of the process', async () => {
  // The counter map is a true `#private`, so the sweep is proven by its
  // consequence: every one of last hour's exhausted addresses is admitted
  // again, which can only be true if their entries are gone.
  const time = clock();
  const limiter = new InMemoryEmailRateLimiter(time.read);
  for (let i = 0; i < 50; i += 1) {
    const address = parseEmailAddress(`c${i}@example.com`);
    for (let n = 0; n < 11; n += 1) await limiter.consume({ kind: 'document-request', address });
  }

  time.advanceSeconds(3600);
  for (let i = 0; i < 50; i += 1) {
    const address = parseEmailAddress(`c${i}@example.com`);
    expect((await limiter.consume({ kind: 'document-request', address })).allowed).toBe(true);
  }
});

test('the Redis limiter applies the same ceilings through INCR', async () => {
  // A fake Redis, so the arithmetic is proven without a container. INCR
  // returning the post-increment value is what makes check-and-consume one
  // round trip with no read-modify-write race.
  const counters = new Map<string, number>();
  const expiries: { key: string; seconds: number }[] = [];
  const fake = {
    incr: (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return Promise.resolve(next);
    },
    expire: (key: string, seconds: number) => {
      expiries.push({ key, seconds });
      return Promise.resolve(1 as const);
    },
  };
  const limiter = new RedisEmailRateLimiter(fake, clock().read);

  for (let i = 0; i < 5; i += 1) {
    expect((await limiter.consume({ kind: 'sign-in-code', address: ada })).allowed).toBe(true);
  }
  expect((await limiter.consume({ kind: 'sign-in-code', address: ada })).allowed).toBe(false);

  // Two windows of TTL, so a counter written at 59:59 is readable for the whole
  // of the next one.
  expect(expiries.every((e) => e.seconds === 7200)).toBe(true);
});
