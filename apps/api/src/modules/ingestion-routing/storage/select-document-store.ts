import type { Env } from '../../../config/env.js';
import { type DocumentStore, InMemoryDocumentStore } from './document-store.js';
import { createS3Client, S3DocumentStore } from './s3-document-store.js';

/**
 * Pick the document store from config — never by import, so tests and offline dev
 * stay on the fixture while staging runs real S3. The `makeS3` seam keeps this
 * unit-testable without opening an S3 client.
 */
export function selectDocumentStore(
  env: Env,
  makeS3: (env: Env) => DocumentStore = (resolved) =>
    new S3DocumentStore(createS3Client(resolved), resolved.S3_BUCKET_DOCUMENTS),
): DocumentStore {
  return env.OBJECT_STORE === 's3' ? makeS3(env) : new InMemoryDocumentStore();
}
