import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import type { Env } from '../../../config/env.js';
import {
  type DocumentStore,
  type DocumentStorePutInput,
  documentKey,
  type StoredDocument,
} from './document-store.js';

type S3Env = Pick<
  Env,
  'S3_REGION' | 'S3_ENDPOINT' | 'S3_FORCE_PATH_STYLE' | 'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY'
>;

/**
 * One S3 client for both MinIO (local) and the real bucket (staging), the
 * difference being config only:
 *  - endpoint empty → the real AWS endpoint; set (`http://localhost:9000`) → MinIO;
 *  - static credentials for MinIO; empty → the task role's default provider chain
 *    in staging (never static keys in the repo).
 */
export function createS3Client(env: S3Env): S3Client {
  const hasStaticCreds = env.S3_ACCESS_KEY_ID !== '' && env.S3_SECRET_ACCESS_KEY !== '';
  return new S3Client({
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    ...(env.S3_ENDPOINT !== '' ? { endpoint: env.S3_ENDPOINT } : {}),
    ...(hasStaticCreds
      ? { credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } }
      : {}),
  });
}

export class S3DocumentStore implements DocumentStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(input: DocumentStorePutInput): Promise<StoredDocument> {
    const key = documentKey(input.workspaceId, input.sha256);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.bytes,
        ContentType: input.contentType,
        // Deliberately NO ServerSideEncryption / SSEKMSKeyId: the bucket's default
        // SSE-KMS encrypts the object. Naming a CMK client-side is how you get an
        // object only this caller can decrypt (issue #16).
      }),
    );
    return { key, sha256: input.sha256, byteLength: input.bytes.length };
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (response.Body === undefined) throw new Error(`no object body at key ${key}`);
    return Buffer.from(await response.Body.transformToByteArray());
  }
}
