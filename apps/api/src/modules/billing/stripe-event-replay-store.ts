import type { Clock } from './clock.js';

/**
 * Idempotency on the Stripe event id. `reserve` returns `true` the first time
 * an id is seen (and reserves it), `false` on a repeat — so Stripe's genuine
 * retries are no-ops rather than double-applied.
 *
 * Behind an interface, like the WhatsApp lane's, so the in-memory Map is a
 * fixture swappable for a Redis `SET NX EX` without touching the handler
 * (issue #9: no Redis-backed replay store yet).
 *
 * ⚠ **Per-process, so it is not the only defence and must not be.** Two API
 * tasks behind the ALB each keep their own Map, and Stripe's retry can land on
 * the other one. The handler is therefore written to be idempotent on its own
 * terms as well: applying the same subscription state twice is a no-op write,
 * and the out-of-order guard discards anything older than what is stored. This
 * store removes duplicate WORK; correctness does not depend on it.
 */
export interface StripeEventReplayStore {
  reserve(eventId: string, ttlMs: number): Promise<boolean>;
}

/** Fixture only — eviction is lazy, swept on the next `reserve`. See the caveat above. */
export class InMemoryStripeEventReplayStore implements StripeEventReplayStore {
  private readonly seen = new Map<string, number>(); // event id -> expiry (ms epoch)

  constructor(private readonly clock: Clock) {}

  async reserve(eventId: string, ttlMs: number): Promise<boolean> {
    const now = this.clock.now();
    for (const [key, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(key);
    }
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, now + ttlMs);
    return true;
  }
}
