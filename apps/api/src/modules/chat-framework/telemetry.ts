import { Logger } from '@nestjs/common';

import type { Tier } from './models.js';

/**
 * What every model call logs (Governance §9.7): `traceId`, workspace, use case,
 * model ID, input/output tokens, computed cost, latency, cache-hit status.
 *
 * One line, one JSON object, one logger name — because the consumers are a
 * CloudWatch metric filter and a cost dashboard, not a human reading prose.
 * `ai.fallback.count` (§9.3) and the cost aggregation both key off fields in
 * here, so renaming one is a dashboard change, not a cosmetic edit.
 *
 * **No prompt text and no reply text is ever logged.** The fields below are
 * counts and identifiers. A log line carrying a client's document text would
 * put customer data into CloudWatch, where the retention policy, the access
 * grants and the DPIA all say something different from what `documents` says.
 */
const logger = new Logger('ai');

export interface ModelCallLog {
  readonly traceId: string;
  readonly practiceId: string;
  readonly businessId: string | null;
  readonly task: string;
  readonly tier: Tier;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly costPence: number;
  readonly latencyMs: number;
  readonly outcome: 'ok' | 'schema-retry' | 'schema-failed' | 'unavailable' | 'budget-blocked';
  /** Set when a lower tier answered because the intended one failed (§9.3). */
  readonly degradedFrom?: Tier;
}

export function logModelCall(entry: ModelCallLog): void {
  logger.log(
    JSON.stringify({
      event: 'ai.call',
      ...entry,
      // Explicit rather than derived at query time: a cache hit rate is a
      // tracked metric (§9.7) and "was this cached at all" is the field a
      // metric filter can count without arithmetic.
      cacheHit: entry.cachedInputTokens > 0,
    }),
  );
}

/** §9.3: every fallback event logs with its `traceId` and surfaces as a metric. */
export function logFallback(entry: {
  traceId: string;
  practiceId: string;
  task: string;
  from: Tier;
  to: Tier | 'none';
  reason: string;
}): void {
  logger.warn(JSON.stringify({ event: 'ai.fallback', metric: 'ai.fallback.count', ...entry }));
}

/**
 * §9.6: an injection attempt that the wrapper neutralised is still worth
 * counting. A rise here is either an attack or a customer whose supplier writes
 * strange invoices, and both are things somebody should look at.
 */
export function logInjectionSignal(entry: { traceId: string; practiceId: string; source: string }): void {
  logger.warn(JSON.stringify({ event: 'ai.injection_signal', metric: 'ai.injection.count', ...entry }));
}
