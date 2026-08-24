/**
 * The §9.3 circuit breaker: opens after 3 consecutive failures per provider,
 * half-opens after 60 s.
 *
 * Per PROVIDER, not per tier — that is what Governance says and it is the right
 * granularity: when Bedrock is down in eu-west-2 it is down for every model
 * behind it, and a per-tier breaker would spend three more failures discovering
 * that for each tier in turn.
 *
 * Deliberately in-process and unsynchronised. A shared breaker in Redis would
 * make one task's bad minute everyone's bad minute, and the failure it guards
 * against — hammering a provider that is already refusing — is bounded per
 * process anyway. The cost of getting this wrong in the shared direction is
 * much higher than the cost of N processes each learning independently.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

const FAILURE_THRESHOLD = 3;
const OPEN_FOR_MS = 60_000;

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  /** Injected so tests do not sleep, and so a clock skew is never a real dependency. */
  constructor(private readonly now: () => number = () => Date.now()) {}

  state(): BreakerState {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= OPEN_FOR_MS ? 'half-open' : 'open';
  }

  /**
   * True when a call may proceed. A half-open breaker lets exactly one call
   * through — if it succeeds the breaker closes, if it fails the window
   * restarts. This is the probe, not a free pass back to full traffic.
   */
  allows(): boolean {
    return this.state() !== 'open';
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.openedAt = this.now();
      // Reset the counter so the NEXT half-open probe failure re-opens
      // immediately rather than needing three more failures to do it.
      this.consecutiveFailures = FAILURE_THRESHOLD - 1;
    }
  }
}
