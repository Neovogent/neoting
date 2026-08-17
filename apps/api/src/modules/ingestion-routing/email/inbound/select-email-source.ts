import type { Env } from '../../../../config/env.js';
import { createS3Client } from '../../storage/s3-document-store.js';
import { type EmailSource, FixtureEmailSource } from './email-source.js';
import { MailHogEmailSource } from './mailhog-email-source.js';
import { S3EmailSource } from './s3-email-source.js';

/**
 * Pick the inbound email source from config — never by import, so the suite and
 * any dev without AWS stay on the fixture, a laptop uses MailHog, and staging
 * uses S3. Same shape as `selectIngestQueue` / `selectDocumentStore`; the two
 * factory seams keep this unit-testable without a socket.
 */
export function selectEmailSource(
  env: Env,
  makeMailHog: (env: Env) => EmailSource = (resolved) => new MailHogEmailSource({ apiUrl: resolved.MAILHOG_API_URL }),
  makeS3: (env: Env) => EmailSource = (resolved) =>
    new S3EmailSource({ client: createS3Client(resolved), bucket: resolved.S3_BUCKET_RECEIPTS }),
): EmailSource {
  if (env.EMAIL_SOURCE === 'mailhog') return makeMailHog(env);
  if (env.EMAIL_SOURCE === 's3') return makeS3(env);
  return new FixtureEmailSource();
}
