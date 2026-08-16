/**
 * The staging email source: the SES receipt prefix in S3 (issue #78).
 *
 * SES receives at `doc@` and writes the raw MIME to `s3://…-receipts/inbound/…`
 * (`infra/envs/staging/email.tf`). This LISTS that prefix, fetches each object,
 * and deletes it on ack.
 *
 * ⚠ TWO INFRA GAPS, flagged on #78 (Terraform is Shakib's, never edited here):
 *  1. An event-driven trigger (S3 → SQS/EventBridge → consume) does NOT exist for
 *     the receipts bucket — only ClamAV's notification does. Polling the prefix is
 *     the mechanism that works TODAY without it; when the notification lands it
 *     replaces this list loop.
 *  2. The staging task role is granted `s3:GetObject` on `receipts/inbound/*`, but
 *     `s3:ListBucket` and `s3:DeleteObject` for this prefix must be confirmed —
 *     without them poll/ack `AccessDenied` in staging (unit tests pass regardless).
 */

import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';

import type { EmailSource, InboundRawEmail } from './email-source.js';

const INBOUND_PREFIX = 'inbound/';
const DEFAULT_MAX_KEYS = 10;

export interface S3EmailSourceOptions {
  readonly client: S3Client;
  readonly bucket: string;
  readonly prefix?: string;
  readonly maxKeys?: number;
}

export class S3EmailSource implements EmailSource {
  private readonly prefix: string;
  private readonly maxKeys: number;

  constructor(private readonly options: S3EmailSourceOptions) {
    this.prefix = options.prefix ?? INBOUND_PREFIX;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  async poll(): Promise<readonly InboundRawEmail[]> {
    const listed = await this.options.client.send(
      new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: this.prefix, MaxKeys: this.maxKeys }),
    );

    const emails: InboundRawEmail[] = [];
    for (const object of listed.Contents ?? []) {
      const key = object.Key;
      // Skip the prefix "folder" placeholder S3 can surface as a zero-byte key.
      if (key === undefined || key.endsWith('/')) continue;

      const got = await this.options.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
      if (got.Body === undefined) continue;

      emails.push({
        id: key,
        raw: Buffer.from(await got.Body.transformToByteArray()),
        // SES does not put the recipient in the object key; it is in the MIME the
        // parser reads. So the runner falls back to the parsed `To` header here.
        envelopeRecipient: null,
        receivedAtSeconds: object.LastModified ? Math.floor(object.LastModified.getTime() / 1000) : 0,
      });
    }
    return emails;
  }

  async ack(id: string): Promise<void> {
    await this.options.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: id }));
  }
}
