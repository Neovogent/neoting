import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped trace context (Governance §13.1: one `traceId` is born at every
 * entry point and travels everywhere — into job handlers included). Kept in
 * AsyncLocalStorage so the webhook controller never has to thread it through by
 * hand: the trace middleware opens the context per request, and the queue reads
 * it at enqueue time. That is what lets `whatsapp.controller.ts` stay untouched
 * while the job still carries the trace.
 */
interface TraceStore {
  readonly traceId: string;
}

const storage = new AsyncLocalStorage<TraceStore>();

export function runWithTrace<T>(traceId: string, fn: () => T): T {
  return storage.run({ traceId }, fn);
}

export function currentTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}
