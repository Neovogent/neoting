import { afterEach, expect, test, vi } from 'vitest';
import type { Redis } from 'ioredis';

import { clearScheduledJobs, registerScheduledJob, runScheduledJob, startScheduler } from './scheduler.js';

afterEach(() => {
  clearScheduledJobs();
  vi.useRealTimers();
});

const logger = { log: () => undefined, error: () => undefined };

test('fixture mode runs each registered job on its interval, in process', async () => {
  vi.useFakeTimers();
  let runs = 0;
  registerScheduledJob({ name: 'tick', everyMs: 1000, run: async () => void (runs += 1) });
  const stop = await startScheduler({ mode: 'fixture', connection: {} as Redis, logger });

  await vi.advanceTimersByTimeAsync(3500);
  expect(runs).toBe(3);
  await stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(runs).toBe(3);
});

test('a tick that arrives while the job is still running is dropped, and a name registers once', async () => {
  let release: () => void = () => undefined;
  let runs = 0;
  registerScheduledJob({
    name: 'slow',
    everyMs: 1000,
    run: () => new Promise<void>((resolve) => ((runs += 1), (release = resolve))),
  });
  expect(() => registerScheduledJob({ name: 'slow', everyMs: 1, run: async () => undefined })).toThrow(/twice/);

  const first = runScheduledJob('slow');
  await runScheduledJob('slow'); // overlaps — dropped
  release();
  await first;
  expect(runs).toBe(1);
  await expect(runScheduledJob('missing')).rejects.toThrow(/no scheduled job/);
});
