import type { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { expect, test } from 'vitest';

import { quarantineKey, S3Quarantine } from './s3-quarantine.js';

const SHA = 'a'.repeat(64);

function fakeS3(): { client: S3Client; sent: PutObjectCommand[] } {
  const sent: PutObjectCommand[] = [];
  const client = {
    async send(command: PutObjectCommand) {
      sent.push(command);
      return {};
    },
  } as unknown as S3Client;
  return { client, sent };
}

test('a hit is written once, write-only, as an opaque attachment under <channel>/<sha256>', async () => {
  const { client, sent } = fakeS3();
  const quarantine = new S3Quarantine(client, 'nt-staging-quarantine-123');

  await quarantine.put({
    bytes: Buffer.from('malicious'),
    sha256: SHA,
    channel: 'email',
    signature: 'Win.Test.EICAR_HDB-1',
  });

  expect(sent).toHaveLength(1);
  const input = sent[0]!.input;
  expect(input.Bucket).toBe('nt-staging-quarantine-123');
  expect(input.Key).toBe(`email/${SHA}`);
  // Never the sniffed type: nothing should be invited to render this.
  expect(input.ContentType).toBe('application/octet-stream');
  expect(input.ContentDisposition).toBe('attachment');
  expect(input.Metadata).toMatchObject({
    'av-status': 'infected',
    'av-signature': 'Win.Test.EICAR_HDB-1',
    channel: 'email',
    sha256: SHA,
  });
  // Bucket-default SSE-KMS; naming the CMK client-side is the issue #16 trap.
  expect(input.SSEKMSKeyId).toBeUndefined();
  expect(input.ServerSideEncryption).toBeUndefined();
});

test('the signature is reduced to printable ASCII before it becomes an HTTP header', async () => {
  const { client, sent } = fakeS3();
  await new S3Quarantine(client, 'b').put({
    bytes: Buffer.alloc(1),
    sha256: SHA,
    channel: 'client',
    signature: 'Bad\r\nInjected: headeré',
  });
  expect(sent[0]!.input.Metadata?.['av-signature']).toBe('Bad??Injected: header?');
});

test('an absent signature is recorded as unknown, never omitted', async () => {
  const { client, sent } = fakeS3();
  await new S3Quarantine(client, 'b').put({ bytes: Buffer.alloc(1), sha256: SHA, channel: 'client' });
  expect(sent[0]!.input.Metadata?.['av-signature']).toBe('unknown');
});

test('the key layout is pinned, and a non-hex hash cannot become a key', () => {
  expect(quarantineKey({ channel: 'accountant_upload', sha256: SHA })).toBe(`accountant_upload/${SHA}`);
  expect(() => quarantineKey({ channel: 'client', sha256: '../escape' })).toThrow(/hex sha256/);
});

test('S3Quarantine has no read path — the bucket policy denies one and the class must agree', () => {
  const { client } = fakeS3();
  const quarantine = new S3Quarantine(client, 'b') as unknown as Record<string, unknown>;
  expect(quarantine['get']).toBeUndefined();
  expect(quarantine['list']).toBeUndefined();
});
