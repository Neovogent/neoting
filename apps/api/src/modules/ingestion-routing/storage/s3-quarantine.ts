import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

import type { Quarantine, QuarantineSample } from '../lib/sanitisation/quarantine.js';

/**
 * The real quarantine: one `PutObject` into `nt-<env>-quarantine-<acct>`.
 *
 * WRITE-ONLY BY CONSTRUCTION, and the bucket agrees. clamav.tf's bucket policy
 * denies `GetObject` to every automated principal — including this task role —
 * so malware moves in one direction and the only way back out is a human doing
 * forensics. This class therefore has no `get`, and must never grow one.
 *
 * The key is content-addressed under the channel, and carries NO tenant,
 * document or sender identifier: the bucket is incident evidence, not a
 * document store, and "which practice" is answered by the `sanitise` event on
 * the document row (which records the same sha256), not by the object key.
 *
 * ⚠ The bucket's EventBridge rule (`nt-<env>-av-quarantine-write`) alerts on
 * EVERY object created here. That is the operator alert SoT Stage 1 asks for,
 * so nothing but a scanner hit may ever be written through this class.
 */
export class S3Quarantine implements Quarantine {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(sample: QuarantineSample): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: quarantineKey(sample),
        Body: sample.bytes,
        // Never the sniffed type. A browser or a tool that trusts Content-Type
        // must not be invited to render this.
        ContentType: 'application/octet-stream',
        ContentDisposition: 'attachment',
        // Same reasoning as S3DocumentStore: no SSEKMSKeyId client-side; the
        // bucket default (docs CMK) encrypts the object.
        Metadata: {
          'av-status': 'infected',
          'av-signature': asciiMetadata(sample.signature ?? 'unknown'),
          channel: sample.channel,
          sha256: sample.sha256,
          'quarantined-at': new Date().toISOString(),
        },
      }),
    );
  }
}

/** `<channel>/<sha256>` — exported so the layout is pinned by a test, not inferred. */
export function quarantineKey(sample: Pick<QuarantineSample, 'channel' | 'sha256'>): string {
  if (!/^[0-9a-f]{64}$/.test(sample.sha256)) throw new Error('quarantine key needs a hex sha256');
  return `${sample.channel}/${sample.sha256}`;
}

/**
 * S3 user metadata must be US-ASCII and is sent as an HTTP header. A signature
 * name comes from the scanner's database, not from the file — but it is still
 * text we did not write, so it is reduced to printable ASCII and capped.
 */
function asciiMetadata(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
}
