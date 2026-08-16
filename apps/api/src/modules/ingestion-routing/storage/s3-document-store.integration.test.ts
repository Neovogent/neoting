import { expect, test } from 'vitest';

import { documentKey } from './document-store.js';
import { createS3Client, S3DocumentStore } from './s3-document-store.js';

// GUARDED so `pnpm test` stays offline (issue #16). This runs only when it is
// explicitly enabled AND MinIO is up:
//
//   docker compose up -d
//   RUN_S3_INTEGRATION=1 pnpm --filter @neoting/api test
//
// (MinIO on :9000, credentials + the nt-local-docs bucket from docker-compose.yml.)
//
// This used to say Docker was not installed here and that Shakib had to run it.
// Docker is installed as of 16 Aug 2026 and this test was run locally during #76.
const enabled = process.env.RUN_S3_INTEGRATION === '1';

test.skipIf(!enabled)('S3DocumentStore round-trips against MinIO and the key lands under w/', async () => {
  const client = createS3Client({
    S3_REGION: 'eu-west-2',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_FORCE_PATH_STYLE: true,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'neoting',
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'neoting123',
  });
  const store = new S3DocumentStore(client, process.env.S3_BUCKET_DOCUMENTS ?? 'nt-local-docs');

  const bytes = Buffer.from('object-storage-integration-bytes');
  const sha256 = 'b'.repeat(64);
  const stored = await store.put({ bytes, sha256, contentType: 'application/octet-stream', workspaceId: null, practiceId: 'prac_int' });

  expect(stored.key).toBe(documentKey({ workspaceId: null, practiceId: 'prac_int', sha256 }));
  expect(stored.key.startsWith('w/')).toBe(true);
  expect((await store.get(stored.key)).equals(bytes)).toBe(true);
});
