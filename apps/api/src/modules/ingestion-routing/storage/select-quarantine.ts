import type { Env } from '../../../config/env.js';
import { noQuarantine, type Quarantine } from '../lib/sanitisation/quarantine.js';
import { createS3Client } from './s3-document-store.js';
import { S3Quarantine } from './s3-quarantine.js';

/**
 * Pick the quarantine from config, the same way `selectDocumentStore` picks the
 * store. An empty `QUARANTINE_BUCKET` means "refuse the file, keep nothing" —
 * the right answer for a laptop and for CI, and the one `env.ts` refuses to
 * combine with a real scanner in production.
 */
export function selectQuarantine(
  env: Env,
  makeS3: (env: Env) => Quarantine = (resolved) =>
    new S3Quarantine(createS3Client(resolved), resolved.QUARANTINE_BUCKET),
): Quarantine {
  return env.QUARANTINE_BUCKET !== '' ? makeS3(env) : noQuarantine;
}
