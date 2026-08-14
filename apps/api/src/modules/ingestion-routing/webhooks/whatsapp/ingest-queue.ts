import type { RoutingDecision } from './routing.js';

/**
 * A document handed off from the webhook to the async ingest pipeline. The
 * caption is ALREADY wrapped in `<untrusted_content>` by the time it lands here
 * (Governance §9.6). `idempotencyKey` is the `wamid`, per the async-spine rule
 * in apps/api/CLAUDE.md.
 */
export interface IngestJob {
  readonly source: 'whatsapp';
  readonly idempotencyKey: string;
  readonly from: string;
  readonly receivedAtSeconds: number;
  readonly messageType: string;
  readonly caption: string | null;
  readonly routing: RoutingDecision;
}

/**
 * The queue the webhook enqueues to. BullMQ is deliberately NOT wired yet
 * (issue #9: no Redis, no queue infra) — this interface with a fixture keeps the
 * webhook shippable and its tests offline. The real BullMQ producer drops in
 * behind this token later (the same DI pattern as the sanitisation scanner).
 */
export interface IngestQueue {
  enqueue(job: IngestJob): Promise<void>;
}

/** Fixture queue: records what would have been enqueued, for tests and local dev. */
export class FixtureIngestQueue implements IngestQueue {
  readonly enqueued: IngestJob[] = [];

  async enqueue(job: IngestJob): Promise<void> {
    this.enqueued.push(job);
  }
}
