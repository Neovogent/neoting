import { createHash } from 'node:crypto';

import IORedis, { type Redis } from 'ioredis';

import { type EmailAddress, rateLimitIdentity } from './email-address.js';
import type { EmailKind } from './email-sender.js';

/**
 * Rate limiting for outbound email — per RECIPIENT and per CALLER IP, both,
 * which is S2's rule and not a nicety.
 *
 * The two limits stop two different attacks, and either one alone leaves the
 * other wide open:
 *
 * - **Per address.** Anyone who can reach the sign-in endpoint can type a
 *   stranger's address into it. Without a per-address ceiling that is a
 *   mailbombing service we host, we pay for, and whose bounces and complaints
 *   land on OUR sending reputation — 5% bounce or 0.1% complaint and SES
 *   suspends the account (`observability.tf`), at which point no client can
 *   sign in and no invite arrives.
 * - **Per IP.** A per-address limit alone is defeated by one script walking a
 *   list of a thousand addresses, one message each. Nothing about that trips a
 *   per-address counter, and the reputation damage is identical.
 *
 * ## Fixed windows, not a sliding log
 *
 * A counter per key per hour, expiring after two. It admits the classic
 * boundary burst — up to 2× a ceiling across an hour edge — and that is
 * accepted knowingly: the alternative stores a timestamp per send, i.e. a
 * durable list of every address we have ever contacted, which is worse both as
 * privacy and as operations, to buy precision this does not need. The ceilings
 * are already an order of magnitude below where reputation moves.
 *
 * ## The keys are hashed, and it is not for secrecy
 *
 * `nt:email:addr:<sha256>` rather than the address itself. Redis holds these
 * keys for two hours, `KEYS`/`SCAN` enumerate them, and any operator with a
 * console has them — an unhashed key family is a live list of every client
 * email address in the system, sitting in a store whose whole purpose is to be
 * cheap to read (Governance §11.6). The hash is not a secret: it is one-way
 * enough that the list stops being an address book, and a caller who already
 * holds the address can still compute its key. The same applies to IPs.
 */

/** The window. One hour, aligned to UTC — storage is UTC (Governance §12). */
const WINDOW_SECONDS = 3_600;

/**
 * Two windows, so a counter written at 59:59 is still readable for the whole of
 * the next one. The same reasoning and the same shape as the AI budget's TTL
 * (`chat-framework/budget.ts`).
 */
const KEY_TTL_SECONDS = WINDOW_SECONDS * 2;

/**
 * Messages per address per hour, per kind.
 *
 * A sign-in code is the tightest because it is a credential and because five
 * attempts is already more than any honest client needs — a sixth means the
 * first five went somewhere the client cannot read, and sending a seventh does
 * not fix that. The invite ceiling is low for the same reason from the other
 * side: an accountant re-inviting a client six times in an hour has a problem
 * that another email will not solve.
 *
 * The document request is the one a real practice could legitimately push
 * against, so it is the most generous — and it is still per ADDRESS, so a
 * hundred clients chased at once consume one slot each.
 */
const PER_ADDRESS_HOURLY: Readonly<Record<EmailKind, number>> = Object.freeze({
  'sign-in-code': 5,
  'client-invite': 5,
  'document-request': 10,
  // Signup is the one flow an unauthenticated stranger can drive at an address
  // they do not own, so both ceilings are tight. Three verification mails is
  // more than anyone needs — a fourth means the first three went somewhere the
  // person cannot read, and a fifth does not fix that.
  'email-verification': 3,
  // Same class and same reasoning as email-verification: a stranger can point
  // this at any address, and three unread reset mails are not fixed by a fourth.
  'password-reset': 3,
  // Tighter still. This one is sent *because* someone else typed your address:
  // it exists to make the uninformative 202 honest, and an attacker repeating
  // the signup must not turn that courtesy into a mailbombing service.
  'duplicate-signup': 2,
});

/**
 * Messages per caller IP per hour, across ALL kinds.
 *
 * One ceiling rather than per-kind: an IP burning through a mix of invites and
 * sign-in codes is the abuse signal, and splitting the budget by kind would
 * simply tell an attacker to alternate.
 *
 * 60 is sized for the legitimate worst case — a practice office behind one NAT
 * address onboarding a batch of clients in a sitting — and is far below any
 * volume that moves a reputation metric.
 */
const PER_IP_HOURLY = 60;

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Seconds until the binding window rolls. 0 when allowed. */
  readonly retryAfterSeconds: number;
  /** Which ceiling refused, for the log. Never surfaced to a caller — see `notifications.service.ts`. */
  readonly limitedBy: 'address' | 'ip' | null;
}

export interface RateLimitRequest {
  readonly kind: EmailKind;
  readonly address: EmailAddress;
  /**
   * The IP the request arrived from, when there is one.
   *
   * Absent for system-initiated sends — a chase batch runs on a worker with no
   * request behind it, and inventing an IP for it would consume a real ceiling
   * on behalf of a caller that does not exist. Those sends are still bounded by
   * the per-address limit, which is the one that matters for a machine sender.
   */
  readonly ip?: string | undefined;
}

export interface EmailRateLimiter {
  /**
   * Consume one slot against every applicable ceiling and report the verdict.
   *
   * Check-and-consume in one call, deliberately: a separate `check` then
   * `consume` is a race that lets two concurrent requests both observe
   * "allowed" at the ceiling. A refused send still consumes — that is what
   * makes the limit hold under a flood rather than merely reporting one.
   */
  consume(request: RateLimitRequest): Promise<RateLimitVerdict>;
}

/** The window ordinal an instant falls in. Integer division on whole seconds — no floats. */
export function windowOf(now: Date): number {
  return Math.floor(Math.floor(now.getTime() / 1000) / WINDOW_SECONDS);
}

/** Seconds remaining in the window `now` falls in. What a `Retry-After` would say. */
function secondsUntilNextWindow(now: Date): number {
  const seconds = Math.floor(now.getTime() / 1000);
  return WINDOW_SECONDS - (seconds % WINDOW_SECONDS);
}

/**
 * `nt:email:<scope>:<sha256(identity)>:<window>` — the §9.7 key shape, one
 * family per scope.
 *
 * The ADDRESS scope carries the kind (`addr:sign-in-code`) and the IP scope
 * does not, and that asymmetry is the design:
 *
 * - Per-kind for the address, because the ceilings differ and the failures are
 *   unrelated. An accountant re-sending an invite five times must not be able
 *   to lock that client out of signing in — which is exactly what a shared
 *   counter would do, at the worst possible moment.
 * - Cross-kind for the IP, because splitting an attacker's budget by kind just
 *   tells them to alternate.
 */
export function rateLimitKey(scope: string, identity: string, now: Date): string {
  const digest = createHash('sha256').update(identity).digest('hex');
  return `nt:email:${scope}:${digest}:${windowOf(now)}`;
}

const ALLOWED: RateLimitVerdict = Object.freeze({ allowed: true, retryAfterSeconds: 0, limitedBy: null });

function refused(by: 'address' | 'ip', now: Date): RateLimitVerdict {
  return { allowed: false, retryAfterSeconds: secondsUntilNextWindow(now), limitedBy: by };
}

/**
 * The counters an implementation needs. Two operations, both atomic in Redis —
 * `INCR` returns the post-increment value, which is what makes check-and-consume
 * a single round trip with no read-modify-write race.
 */
interface CounterStore {
  increment(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
}

/** Shared by both implementations, so the ceilings are applied in exactly one place. */
async function consumeAgainst(store: CounterStore, request: RateLimitRequest, now: Date): Promise<RateLimitVerdict> {
  const addressKey = rateLimitKey(`addr:${request.kind}`, rateLimitIdentity(request.address), now);
  const addressCount = await store.increment(addressKey);
  await store.expire(addressKey, KEY_TTL_SECONDS);

  // The IP ceiling is consumed even when the address ceiling has already
  // refused. A caller hammering one address must still burn their IP budget, or
  // the cheapest way to stay under the IP limit is to keep hitting a blocked
  // address.
  let ipRefused = false;
  if (request.ip !== undefined && request.ip !== '') {
    const ipKey = rateLimitKey('ip', request.ip, now);
    const ipCount = await store.increment(ipKey);
    await store.expire(ipKey, KEY_TTL_SECONDS);
    ipRefused = ipCount > PER_IP_HOURLY;
  }

  if (addressCount > PER_ADDRESS_HOURLY[request.kind]) return refused('address', now);
  if (ipRefused) return refused('ip', now);
  return ALLOWED;
}

/**
 * The real limiter. Redis is the only store that can hold a limit ACROSS
 * processes, which is the only kind of limit the API has: it runs more than one
 * ECS task, so an in-process ceiling of five is really five per task and the
 * number written in this file is a fiction. `config/env.ts` refuses to boot a
 * production sender backed by the in-memory one for exactly that reason.
 */
export class RedisEmailRateLimiter implements EmailRateLimiter {
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

  static fromUrl(url: string): RedisEmailRateLimiter {
    return new RedisEmailRateLimiter(new IORedis(url));
  }

  consume(request: RateLimitRequest): Promise<RateLimitVerdict> {
    return consumeAgainst(this.#store, request, this.now());
  }
}

/**
 * The in-process limiter, for `pnpm dev`, for tests, and for any single-process
 * deployment. Same arithmetic, same ceilings, no Redis — so limit behaviour is
 * unit-testable without a container, and a laptop still enforces a ceiling
 * rather than silently having none.
 */
export class InMemoryEmailRateLimiter implements EmailRateLimiter {
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

  async consume(request: RateLimitRequest): Promise<RateLimitVerdict> {
    const now = this.now();
    this.#sweep(now);
    return consumeAgainst(this.#store, request, now);
  }

  /**
   * Drop counters older than the current window. Without this the map grows for
   * the life of the process, one entry per address per hour — a leak that only
   * shows up in a long-lived container, which is precisely where nobody is
   * watching for it.
   */
  #sweep(now: Date): void {
    const current = windowOf(now);
    for (const key of this.#counters.keys()) {
      const window = Number.parseInt(key.slice(key.lastIndexOf(':') + 1), 10);
      if (Number.isFinite(window) && window < current) this.#counters.delete(key);
    }
  }
}
