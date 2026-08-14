import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { INGEST_DLQ_NAME } from './queue-names.js';

export const MAX_REPLAYS = 3;

export type FailureAction = 'retry' | 'dead-letter' | 'quarantine';

/**
 * What to do with a failed job: keep retrying while attempts remain; once
 * exhausted, dead-letter it — unless it has already been replayed off the DLQ
 * `MAX_REPLAYS` times, in which case it is a poison message and is quarantined
 * rather than looped forever (Governance §7).
 */
export function classifyFailure(attemptsMade: number, maxAttempts: number, replays: number): FailureAction {
  if (attemptsMade < maxAttempts) return 'retry';
  if (replays >= MAX_REPLAYS) return 'quarantine';
  return 'dead-letter';
}

export interface DeadLetterQueue {
  deadLetter(payload: unknown, reason: string): Promise<void>;
}

/** Real DLQ: a separate BullMQ queue exhausted jobs are moved to, not deleted. */
export class BullmqDeadLetterQueue implements DeadLetterQueue {
  private readonly queue: Queue;

  constructor(connection: Redis) {
    this.queue = new Queue(INGEST_DLQ_NAME, { connection });
  }

  async deadLetter(payload: unknown, reason: string): Promise<void> {
    await this.queue.add('dead', { payload, reason }, { removeOnComplete: false, removeOnFail: false });
  }
}
