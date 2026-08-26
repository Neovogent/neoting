import { createHash } from 'node:crypto';

import IORedis, { type Redis } from 'ioredis';

/**
 * Rate limiting for `GET /d/{code}` — per CODE and per IP, both.
 *
 * **This is not a nicety on this route, it is half of what makes the token
 * safe.** The contract says so in its own words: *"Rate limiting is not an
 * optional extra on this route. Per code and per IP. A short code without one
 * is a short code with unlimited guesses."* `capability-code.ts` supplies 40
 * bits; this file supplies the ceiling those 40 bits are measured against.
 *
 * The two limits stop two different things and neither substitutes for the
 * other:
 *
 * - **Per code.** A code that has leaked — forwarded in an email thread, left
 *   in a shared ledger file, pasted into a support ticket — is a working link
 *   to one client's financial document. The per-code ceiling bounds how much
 *   that link can be used before somebody revokes it, and it is what makes the
 *   `access_count` column on the revoke screen a number worth reading.
 * - **Per IP.** The anti-guessing control. A per-code ceiling does nothing
 *   whatever against an attacker walking the code space, because every guess is
 *   a *different* code and none of them has a counter yet.
 *
 * ## Fixed windows, not a sliding log
 *
 * A counter per key per hour, expiring after two — the same shape and the same
 * trade as `notifications/email-rate-limit.ts`. It admits the classic boundary
 * burst of up to 2× a ceiling across an hour edge, knowingly: the alternative
 * stores a timestamp per request, which on this route is a durable log of every
 * capability code anyone has ever opened, and that is worse as privacy than the
 * precision is worth.
 *
 * ## The keys are hashed, and here it is genuinely for secrecy
 *
 * The email limiter hashes its keys so the key space stops being an address
 * book. On this route the reason is stronger: an unhashed key family would be
 * `nt:dlink:code:A7K2M9PQ:…` — a live, enumerable list of **working links to
 * clients' financial documents**, sitting in a store whose whole purpose is to
 * be cheap to read, readable by any operator with a console (Governance §11.6).
 * The hash is one-way; a caller who already holds the code can still compute
 * its key.
 *
 * ## ⚠ The per-IP ceiling depends on something that is not set yet
 *
 * The IP arrives from Express's `req.ip`, which is the **socket** address
 * unless `app.set('trust proxy', …)` has been configured. Behind the ALB and
 * CloudFront that means every request appears to come from a handful of proxy
 * addresses, so the per-IP ceiling degrades into one global ceiling on this
 * route. That fails in the safe direction — too strict, never too loose — and
 * `PER_IP_HOURLY` is sized so a real practice does not hit it even in that
 * degraded mode. But it is **not** the control it is meant to be until
 * `main.ts` trusts the proxy, and `main.ts` is outside stage A8's owned paths.
 * Recorded here and in the module's CLAUDE.md rather than left to be
 * discovered.
 */

/** One hour, aligned to UTC — storage is UTC (Governance §12). */
const WINDOW_SECONDS = 3_600;

/** Two windows, so a counter written at 59:59 is still readable for the whole of the next one. */
const KEY_TTL_SECONDS = WINDOW_SECONDS * 2;

/**
 * Resolutions of ONE code per hour.
 *
 * Sized for the legitimate shape of this route: an accountant opens a document,
 * closes it, opens it again to check a figure, and a colleague opens the same
 * one. Sixty an hour is far above that and far below anything that makes a
 * leaked link useful for bulk collection.
 */
export const PER_CODE_HOURLY = 60;

/**
 * Requests from one caller per hour, hits and misses together.
 *
 * Deliberately generous, for the trust-proxy reason in the header: today this
 * is closer to a whole-route ceiling than a per-caller one, and a practice
 * working through a month's export must not trip it. It is still a hard bound
 * on guessing — at 300 attempts an hour, finding any one of ten thousand live
 * codes in a 1.1 × 10¹² space takes on the order of forty thousand years.
 */
export const PER_IP_HOURLY = 300;

export interface LinkRateLimitVerdict {
  readonly allowed: boolean;
  /** Seconds until the binding window rolls. 0 when allowed. What `Retry-After` says. */
  readonly retryAfterSeconds: number;
  /** Which ceiling refused, for the log. **Never surfaced to a caller** — see below. */
  readonly limitedBy: 'code' | 'ip' | null;
}

export interface LinkRateLimitRequest {
  /** The normalised code, whether or not it exists. A miss consumes budget too. */
  readonly code: string;
  /**
   * The caller's address, when Express could determine one.
   *
   * Absent is treated as "no per-IP ceiling applies", not as "refuse". A
   * request with no resolvable address is a local socket or a test, and
   * refusing it would break `pnpm dev` while stopping nobody.
   */
  readonly ip?: string | undefined;
}

export interface CapabilityLinkRateLimiter {
  /**
   * Consume one slot against every applicable ceiling and report the verdict.
   *
   * Check-and-consume in one call, deliberately: a separate `check` then
   * `consume` is a race that lets two concurrent requests both observe
   * "allowed" at the ceiling. A refused request still consumes — that is what
   * makes the limit hold under a flood rather than merely report one.
   */
  consume(request: LinkRateLimitRequest): Promise<LinkRateLimitVerdict>;
}

/** The window ordinal an instant falls in. Integer division on whole seconds — no floats. */
export function windowOf(now: Date): number {
  return Math.floor(Math.floor(now.getTime() / 1000) / WINDOW_SECONDS);
}

function secondsUntilNextWindow(now: Date): number {
  const seconds = Math.floor(now.getTime() / 1000);
  return WINDOW_SECONDS - (seconds % WINDOW_SECONDS);
}

/** `nt:dlink:<scope>:<sha256(identity)>:<window>` — the §9.7 key shape, one family per scope. */
export function linkRateLimitKey(scope: 'code' | 'ip', identity: string, now: Date): string {
  const digest = createHash('sha256').update(identity).digest('hex');
  return `nt:dlink:${scope}:${digest}:${windowOf(now)}`;
}

const ALLOWED: LinkRateLimitVerdict = Object.freeze({ allowed: true, retryAfterSeconds: 0, limitedBy: null });

function refused(by: 'code' | 'ip', now: Date): LinkRateLimitVerdict {
  return { allowed: false, retryAfterSeconds: secondsUntilNextWindow(now), limitedBy: by };
}

/** Two atomic operations — `INCR` returns the post-increment value, so check-and-consume is one round trip with no read-modify-write race. */
interface CounterStore {
  increment(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
}

/** Shared by both implementations, so the ceilings are applied in exactly one place. */
async function consumeAgainst(
  store: CounterStore,
  request: LinkRateLimitRequest,
  now: Date,
): Promise<LinkRateLimitVerdict> {
  // The IP ceiling is consumed FIRST and ALWAYS, before anything knows whether
  // the code exists. That ordering is the anti-guessing control: an attacker
  // walking the code space must burn their budget on misses, which is the only
  // kind of request they ever make.
  let ipRefused = false;
  if (request.ip !== undefined && request.ip !== '') {
    const ipKey = linkRateLimitKey('ip', request.ip, now);
    const ipCount = await store.increment(ipKey);
    await store.expire(ipKey, KEY_TTL_SECONDS);
    ipRefused = ipCount > PER_IP_HOURLY;
  }

  // Consumed even when the IP ceiling has already refused: otherwise the
  // cheapest way to stay under one ceiling is to keep hitting the other.
  const codeKey = linkRateLimitKey('code', request.code, now);
  const codeCount = await store.increment(codeKey);
  await store.expire(codeKey, KEY_TTL_SECONDS);

  if (ipRefused) return refused('ip', now);
  if (codeCount > PER_CODE_HOURLY) return refused('code', now);
  return ALLOWED;
}

/**
 * The real limiter. Redis is the only store that can hold a limit ACROSS
 * processes, which is the only kind of limit the API has: it runs more than one
 * ECS task, so an in-process ceiling of 300 is really 300 per task and the
 * numbers above become fiction.
 */
export class RedisCapabilityLinkRateLimiter implements CapabilityLinkRateLimiter {
  readonly #store: CounterStore;

  constructor(
    redis: Pick<Redis, 'incr' | 'expire'>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#store = {
      increment: (key) => redis.incr(key),
      expire: async (key, seconds) => {
        await redis.expire(key, seconds);
      },
    };
  }

  static fromUrl(url: string): RedisCapabilityLinkRateLimiter {
    return new RedisCapabilityLinkRateLimiter(new IORedis(url));
  }

  consume(request: LinkRateLimitRequest): Promise<LinkRateLimitVerdict> {
    return consumeAgainst(this.#store, request, this.now());
  }
}

/**
 * The in-process limiter, for `pnpm dev`, for tests, and for any single-process
 * deployment. Same arithmetic, same ceilings, no Redis — so limit behaviour is
 * unit-testable without a container, and a laptop still enforces a ceiling
 * rather than silently having none.
 */
export class InMemoryCapabilityLinkRateLimiter implements CapabilityLinkRateLimiter {
  readonly #counters = new Map<string, number>();
  readonly #store: CounterStore;

  constructor(private readonly now: () => Date = () => new Date()) {
    this.#store = {
      increment: (key) => {
        const next = (this.#counters.get(key) ?? 0) + 1;
        this.#counters.set(key, next);
        return Promise.resolve(next);
      },
      // No TTL machinery: keys carry their window ordinal, so a stale one can
      // never be read again. It is swept instead, below, to bound the map.
      expire: () => Promise.resolve(),
    };
  }

  async consume(request: LinkRateLimitRequest): Promise<LinkRateLimitVerdict> {
    const now = this.now();
    this.#sweep(now);
    return consumeAgainst(this.#store, request, now);
  }

  /**
   * Drop counters older than the current window. Without this the map grows for
   * the life of the process — a leak that only shows up in a long-lived
   * container, which is precisely where nobody is watching for it.
   */
  #sweep(now: Date): void {
    const current = windowOf(now);
    for (const key of this.#counters.keys()) {
      const window = Number.parseInt(key.slice(key.lastIndexOf(':') + 1), 10);
      if (Number.isFinite(window) && window < current) this.#counters.delete(key);
    }
  }
}

/**
 * Pick the store — by configuration, never by import, the house pattern.
 *
 * `sharedCounters` rather than an env key read here: `config/env.ts` is the one
 * place that reads `process.env` (Governance §11.5) and it is outside this
 * stage's owned paths, so the composition root decides and this module takes
 * the answer. See `app.module.ts` for what it decides from, and the module's
 * CLAUDE.md for the dedicated `CAPABILITY_LINK_RATE_LIMIT` key that should
 * replace it.
 */
export function selectCapabilityLinkRateLimiter(
  sharedCounters: boolean,
  redisUrl: string,
  makeRedis: (url: string) => CapabilityLinkRateLimiter = (url) => RedisCapabilityLinkRateLimiter.fromUrl(url),
): CapabilityLinkRateLimiter {
  return sharedCounters ? makeRedis(redisUrl) : new InMemoryCapabilityLinkRateLimiter();
}
