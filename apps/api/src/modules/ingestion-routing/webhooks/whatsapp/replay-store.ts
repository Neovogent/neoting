import type { Clock } from './clock.js';

/**
 * Replay / idempotency store keyed by the WhatsApp message id (`wamid`).
 * `reserve` returns `true` the first time an id is seen (and reserves it),
 * `false` on a repeat — so Meta's genuine retries are dropped as no-ops rather
 * than double-processed.
 *
 * Behind an interface so the in-memory Map is a fixture (mirrors the
 * sanitisation `VirusScanner` + fixture pattern), swappable for a Redis
 * `SET NX EX` later without touching the controller (issue #9: no Redis yet).
 */
export interface ReplayStore {
  reserve(nonce: string, ttlMs: number): Promise<boolean>;
}

/**
 * Fixture only. Eviction is lazy — expired ids are swept on the next
 * `reserve`, not on a timer — so in a low-traffic gap the Map holds expired
 * entries until the next call. Fine for tests and local dev; the production
 * store is Redis, whose native `EX` handles expiry. Do not deploy this at
 * scale (issue #9: no Redis yet).
 */
export class InMemoryReplayStore implements ReplayStore {
  private readonly seen = new Map<string, number>(); // nonce -> expiry (ms epoch)

  constructor(private readonly clock: Clock) {}

  async reserve(nonce: string, ttlMs: number): Promise<boolean> {
    const now = this.clock.now();
    for (const [key, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(key); // lazy sweep of expired ids
    }
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now + ttlMs);
    return true;
  }
}
