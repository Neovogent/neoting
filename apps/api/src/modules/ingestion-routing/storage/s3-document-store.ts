import { createHash } from 'node:crypto';

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { Env } from '../../../config/env.js';
import {
  type DocumentStore,
  type DocumentStorePutInput,
  documentKey,
  type PresignedPut,
  type PresignPutInput,
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
    const key = documentKey(input);
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

  async sha256(key: string): Promise<string> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (response.Body === undefined) throw new Error(`no object body at key ${key}`);
    // Chunk by chunk into the hash — peak memory is one chunk, never the object.
    // In the Node runtime `Body` is a Readable, which is async-iterable; the SDK
    // types it for three runtimes at once, hence the assertion.
    const hash = createHash('sha256');
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) hash.update(chunk);
    return hash.digest('hex');
  }

  async presignPut(input: PresignPutInput): Promise<PresignedPut> {
    // ContentType and ContentLength are set on the command, so the presigner
    // folds them into the signature: the client must PUT with exactly this type
    // and this many bytes, or S3 rejects it. That is the "presigned policy
    // enforces the cap too" half — the API cap check is the other half.
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.byteSize,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: input.expiresInSeconds,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return { key: input.key, url, headers: { 'Content-Type': input.contentType } };
  }

  async head(key: string): Promise<{ readonly byteLength: number } | null> {
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { byteLength: response.ContentLength ?? 0 };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}

/** S3 signals a missing object as 404 / NotFound / NoSuchKey depending on the operation. */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}
