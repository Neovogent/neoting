import type { Env } from '../config/env.js';
import {
  createClamdVirusScanner,
  fixtureVirusScanner,
  type Quarantine,
  type VirusScanner,
} from '../modules/ingestion-routing/lib/sanitisation/index.js';
import { selectQuarantine } from '../modules/ingestion-routing/storage/select-quarantine.js';

export interface VirusScanning {
  readonly scanner: VirusScanner;
  readonly quarantine: Quarantine;
}

interface BootLogger {
  log(message: string): void;
  warn(message: string): void;
}

/**
 * ONE scanner and ONE quarantine for every lane in a worker process — the
 * WhatsApp intake, the web/portal upload step and the email poller all take
 * these as deps, and building them here means "wire the same sanitisation" is
 * a fact rather than three copies of the same two lines (the Stage A3 lesson).
 *
 * What it says at boot is the operational contract:
 *   - `fixture`: a WARNING every start. Only the EICAR test string is caught;
 *     nothing is being scanned. The line exists so nobody reads a quiet worker
 *     as a scanned one (clamav.tf: "do not read 'the ClamAV path is built' as
 *     'uploads are scanned'").
 *   - `clamd`: a PING. Not reachable is a warning, not a crash — clamd takes
 *     2–3 minutes to load its database, and a worker that crash-looped while
 *     it did would look like a broken image. Scans fail closed and retry until
 *     the daemon answers, so the queue absorbs the start-up gap.
 */
export function composeVirusScanning(env: Env, logger: BootLogger): VirusScanning {
  const quarantine = selectQuarantine(env);
  const quarantineLabel = env.QUARANTINE_BUCKET === '' ? 'none (hits are refused and kept nowhere)' : env.QUARANTINE_BUCKET;

  if (env.VIRUS_SCANNER === 'fixture') {
    logger.warn(
      `virus scanner: FIXTURE — only the EICAR test string is detected; NOTHING IS BEING SCANNED. Set VIRUS_SCANNER=clamd (quarantine: ${quarantineLabel})`,
    );
    return { scanner: fixtureVirusScanner, quarantine };
  }

  const target = `${env.CLAMD_HOST}:${env.CLAMD_PORT}`;
  const scanner = createClamdVirusScanner({
    host: env.CLAMD_HOST,
    port: env.CLAMD_PORT,
    timeoutMs: env.CLAMD_TIMEOUT_MS,
  });
  logger.log(`virus scanner: clamd at ${target} (timeout ${env.CLAMD_TIMEOUT_MS} ms, quarantine: ${quarantineLabel})`);
  void scanner.ping().then((alive) => {
    if (alive) logger.log(`clamd at ${target} answered PONG`);
    else logger.warn(`clamd at ${target} did not answer PING — scans will fail CLOSED and retry until it does`);
  });
  return { scanner, quarantine };
}
