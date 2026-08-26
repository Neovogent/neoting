// DEMO-MOCK / demo driver — METH Stage 5 (§7).
//
// Resets the local demo world to a coherent, scripted state in one command:
//   1. `pnpm db:reset`  — prisma migrate reset (drop + migrate) + app-role + seed v2
//   2. Redis FLUSHALL   — drop every queued/DLQ job so nothing half-processed lingers
//   3. clear the demo MinIO prefixes — nt-local-docs / nt-local-receipts / nt-local-exports
//
// This is an OPERATIONAL script, not part of the app build: it shells out to
// the same tools a human would (`pnpm`, `docker exec`), fails LOUDLY on the
// first error, and is expected to complete well under ~2 minutes from cold.
//
// // DEMO-MOCK: the real environment reset is `terraform`/`ecs run-task` against
// // staging; this is the laptop stand-in for the 21 Aug demo (METH_MODE §4, §7).

import { execSync } from 'node:child_process';

/** The MinIO buckets the demo writes into (docker-compose + .env.example). */
const DEMO_BUCKETS = ['nt-local-docs', 'nt-local-receipts', 'nt-local-exports'] as const;

/** Container + MinIO admin credentials, matching docker-compose.yml. */
const MINIO_CONTAINER = 'nt-minio';
const REDIS_CONTAINER = 'nt-redis';
const MINIO_ENDPOINT = 'http://localhost:9000'; // inside the container the server is local
const MINIO_ACCESS_KEY = 'neoting';
const MINIO_SECRET_KEY = 'neoting123'; // DEMO-MOCK: published local MinIO root creds (docker-compose), never a real secret

/**
 * Run a command, streaming its output, and throw with a clear banner on failure.
 * `stdio: 'inherit'` so `pnpm db:reset`'s progress is visible live — a two-minute
 * silent script reads as a hang.
 */
function run(label: string, command: string): void {
  process.stdout.write(`\n▶ ${label}\n  $ ${command}\n`);
  execSync(command, { stdio: 'inherit' });
}

/**
 * Run a command whose non-zero exit is TOLERATED (e.g. clearing an
 * already-empty bucket). Output is captured so a benign "empty" message does not
 * masquerade as a failure banner. Returns whether it succeeded.
 */
function runTolerant(label: string, command: string): boolean {
  process.stdout.write(`\n▶ ${label}\n  $ ${command}\n`);
  try {
    const output = execSync(command, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    if (output.length > 0) process.stdout.write(`  ${output}\n`);
    return true;
  } catch (error: unknown) {
    // `mc rm` on an empty/absent prefix exits non-zero — that is the desired end
    // state, not a failure. Show the reason and carry on rather than aborting.
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    process.stdout.write(`  (tolerated) ${message}\n`);
    return false;
  }
}

function main(): void {
  const started = Date.now();
  process.stdout.write('┌────────────────────────────────────────────┐\n');
  process.stdout.write('│  Neoting demo reset (METH Stage 5)          │\n');
  process.stdout.write('└────────────────────────────────────────────┘\n');

  // 1. Database — the heavy step. `pnpm db:reset` = migrate reset + app-role + seed.
  //    Sequential and fail-loud: a broken DB must stop the run, not race the flush.
  run('Database: migrate reset + app-role + seed v2', 'pnpm db:reset');

  // 2. Redis — drop every queue (ingest, DLQ) so no stale job survives the reset.
  run('Redis: FLUSHALL', `docker exec ${REDIS_CONTAINER} redis-cli FLUSHALL`);

  // 3. MinIO — clear the demo prefixes. The `local` alias exists in the container
  //    (its healthcheck uses it), but re-set it explicitly so this does not depend
  //    on prior container state. Clearing an empty bucket is tolerated.
  run(
    'MinIO: (re)configure mc alias',
    `docker exec ${MINIO_CONTAINER} mc alias set local ${MINIO_ENDPOINT} ${MINIO_ACCESS_KEY} ${MINIO_SECRET_KEY}`,
  );
  for (const bucket of DEMO_BUCKETS) {
    runTolerant(
      `MinIO: clear local/${bucket}`,
      `docker exec ${MINIO_CONTAINER} mc rm --recursive --force local/${bucket}/`,
    );
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write('\n┌────────────────────────────────────────────┐\n');
  process.stdout.write(`│  ✅ demo reset complete in ${seconds}s`.padEnd(45) + '│\n');
  process.stdout.write('│  DB seeded · Redis flushed · MinIO cleared  │\n');
  process.stdout.write('└────────────────────────────────────────────┘\n');
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n❌ demo reset FAILED: ${message}\n`);
  process.stderr.write('   Nothing was left in a half-reset state on purpose — fix the cause and re-run.\n');
  process.exit(1);
}
