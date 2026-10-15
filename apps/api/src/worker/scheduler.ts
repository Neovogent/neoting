import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * The worker's general scheduler (rush/chase-scheduler) — a tiny registry of
 * repeating jobs, driven by BullMQ job schedulers on the `scheduled` queue.
 *
 * Any composition-root code adds a job with `registerScheduledJob` BEFORE
 * `startScheduler` runs; a job is a name, an interval and an idempotent
 * `run()`. Every job here must be safe to run twice and safe to miss a tick —
 * each one reads its work list from the database.
 *
 * - **bullmq** (`INGEST_QUEUE=bullmq`): one job scheduler per registered job,
 *   upserted by name, so N worker tasks share one tick rather than each firing
 *   its own. Schedulers left in Redis by a job that no longer exists are
 *   removed on boot.
 * - **fixture**: a plain `setInterval` per job, in this process — the dev
 *   fallback, the same one `INGEST_QUEUE=fixture` means everywhere else.
 *
 * A job never runs twice concurrently in one process (`runScheduledJob`).
 */

export const SCHEDULED_QUEUE_NAME = 'scheduled';

export interface ScheduledJob {
  readonly name: string;
  readonly everyMs: number;
  readonly run: () => Promise<unknown>;
}

interface SchedulerLogger {
  log(message: string): void;
  error(message: string): void;
}

const registry = new Map<string, ScheduledJob>();
const running = new Set<string>();

export function registerScheduledJob(job: ScheduledJob): void {
  if (registry.has(job.name)) throw new Error(`scheduled job "${job.name}" is registered twice`);
  registry.set(job.name, job);
}

export function scheduledJobs(): readonly ScheduledJob[] {
  return [...registry.values()];
}

/** Run one registered job by name. A tick that arrives while the last is still running is dropped. */
export async function runScheduledJob(name: string): Promise<void> {
  const job = registry.get(name);
  if (job === undefined) throw new Error(`no scheduled job named "${name}"`);
  if (running.has(name)) return;
  running.add(name);
  try {
    await job.run();
  } finally {
    running.delete(name);
  }
}

/** Test seam: forget every registration. */
export function clearScheduledJobs(): void {
  registry.clear();
  running.clear();
}

export async function startScheduler(options: {
  readonly mode: 'bullmq' | 'fixture';
  readonly connection: Redis;
  readonly logger: SchedulerLogger;
}): Promise<() => Promise<void>> {
  const { logger } = options;
  const jobs = scheduledJobs();
  const fail = (name: string) => (error: unknown) =>
    logger.error(`scheduled job ${name} failed: ${error instanceof Error ? error.message : String(error)}`);

  if (options.mode === 'fixture') {
    const timers = jobs.map((job) => {
      const timer = setInterval(() => void runScheduledJob(job.name).catch(fail(job.name)), job.everyMs);
      timer.unref();
      return timer;
    });
    logger.log(`scheduler (in-process): ${jobs.map((j) => j.name).join(', ') || 'no jobs'}`);
    return async () => timers.forEach(clearInterval);
  }

  const queue = new Queue(SCHEDULED_QUEUE_NAME, { connection: options.connection });
  const wanted = new Set(jobs.map((j) => j.name));
  for (const stale of await queue.getJobSchedulers()) {
    if (!wanted.has(stale.key)) await queue.removeJobScheduler(stale.key);
  }
  for (const job of jobs) {
    await queue.upsertJobScheduler(job.name, { every: job.everyMs }, { name: job.name });
  }
  const worker = new Worker(
    SCHEDULED_QUEUE_NAME,
    async (bullJob) => {
      await runScheduledJob(bullJob.name);
    },
    { connection: options.connection, concurrency: 1 },
  );
  worker.on('failed', (bullJob, err) => fail(bullJob?.name ?? 'unknown')(err));
  logger.log(`scheduler (bullmq '${SCHEDULED_QUEUE_NAME}'): ${jobs.map((j) => j.name).join(', ') || 'no jobs'}`);
  return async () => {
    await worker.close();
    await queue.close();
  };
}
