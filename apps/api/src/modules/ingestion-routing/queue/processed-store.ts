/**
 * Idempotency store for the worker, keyed on `idempotencyKey` (the wamid). BullMQ
 * can deliver the same job twice under the right failure, so handling must be a
 * no-op the second time. Behind an interface so the in-memory Set is a fixture
 * (offline tests) and Redis backs it in production — same pattern as the
 * webhook's ReplayStore.
 */
export interface ProcessedStore {
  /** true if this key is NEW (and now marked processed); false if already seen. */
  markProcessed(key: string): Promise<boolean>;
}

export class InMemoryProcessedStore implements ProcessedStore {
  private readonly seen = new Set<string>();

  async markProcessed(key: string): Promise<boolean> {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}
