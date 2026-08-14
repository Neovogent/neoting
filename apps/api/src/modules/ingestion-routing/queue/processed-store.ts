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

  /**
   * Give the key back when the work it was claimed for FAILED, so the retry can
   * do it.
   *
   * Without this, `markProcessed` is a claim made before the work and never
   * undone: a persist that throws leaves the key marked, BullMQ retries, the
   * retry sees "already processed", returns cleanly — and the job reports
   * SUCCESS having written nothing. The document is lost silently and never
   * reaches the DLQ, which is the one outcome this module's "nothing is ever
   * silently dropped" invariant forbids.
   */
  release(key: string): Promise<void>;
}

export class InMemoryProcessedStore implements ProcessedStore {
  private readonly seen = new Set<string>();

  async markProcessed(key: string): Promise<boolean> {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.seen.delete(key);
  }
}
