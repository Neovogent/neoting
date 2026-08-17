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

import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';

import type { EmailSource, InboundRawEmail } from './email-source.js';

const INBOUND_PREFIX = 'inbound/';
const UNROUTABLE_PREFIX = 'unroutable/';
const DEFAULT_MAX_KEYS = 10;
// SES rejects inbound messages over 40 MB, so nothing legitimate is bigger.
// The cap is checked against the LISTING's Size, before a single byte is
// allocated — a poll must never be an allocation the sender controls.
const DEFAULT_MAX_RAW_BYTES = 40 * 1024 * 1024;

export interface S3EmailSourceOptions {
  readonly client: S3Client;
  readonly bucket: string;
  readonly prefix?: string;
  readonly maxKeys?: number;
  readonly maxRawBytes?: number;
  readonly logger?: { warn(message: string): void };
}

export class S3EmailSource implements EmailSource {
  private readonly prefix: string;
  private readonly maxKeys: number;
  private readonly maxRawBytes: number;

  constructor(private readonly options: S3EmailSourceOptions) {
    this.prefix = options.prefix ?? INBOUND_PREFIX;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.maxRawBytes = options.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES;
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

      // Over the cap → quarantined, not skipped. A skipped oversize object
      // stays in the bounded poll window forever and starves everything that
      // sorts after it — the same wedge an unresolvable email caused. It is
      // still never dropped: the bytes sit under `unroutable/`, named in the
      // warning.
      if ((object.Size ?? 0) > this.maxRawBytes) {
        this.options.logger?.warn(
          `email ${key}: ${object.Size ?? 0} bytes exceeds the ${this.maxRawBytes}-byte raw-MIME cap — quarantined to ${UNROUTABLE_PREFIX}, not dropped`,
        );
        await this.quarantine(key);
        continue;
      }

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

  async quarantine(id: string): Promise<void> {
    // Copy-then-delete: the object leaves the bounded poll window but stays in
    // the bucket, visible and replayable once #17's recipient mapping lands.
    // CopyObject is atomic per object; a crash between the two calls leaves a
    // duplicate under both prefixes, which re-quarantines idempotently on the
    // next poll rather than losing anything.
    const target = id.startsWith(this.prefix) ? `${UNROUTABLE_PREFIX}${id.slice(this.prefix.length)}` : `${UNROUTABLE_PREFIX}${id}`;
    await this.options.client.send(
      new CopyObjectCommand({
        Bucket: this.options.bucket,
        // The source key is URL-encoded per the CopySource contract; the bucket
        // name and the slash separating it are not.
        CopySource: `${this.options.bucket}/${encodeURIComponent(id).replace(/%2F/g, '/')}`,
        Key: target,
      }),
    );
    await this.options.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: id }));
  }
}
