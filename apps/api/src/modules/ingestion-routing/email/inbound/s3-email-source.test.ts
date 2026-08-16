import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { expect, test } from 'vitest';

import { S3EmailSource } from './s3-email-source.js';

interface FakeContents {
  readonly Key?: string;
  readonly LastModified?: Date;
}

/** A minimal fake S3 client that dispatches on the command type — no network. */
function fakeClient(opts: { contents: FakeContents[]; bodies: Record<string, string> }): {
  client: S3Client;
  deleted: string[];
} {
  const deleted: string[] = [];
  const client = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof ListObjectsV2Command) return { Contents: opts.contents };
      if (command instanceof GetObjectCommand) {
        const key = (command.input as { Key?: string }).Key ?? '';
        return { Body: { transformToByteArray: async () => new TextEncoder().encode(opts.bodies[key] ?? '') } };
      }
      if (command instanceof DeleteObjectCommand) {
        deleted.push((command.input as { Key?: string }).Key ?? '');
        return {};
      }
      throw new Error('unexpected command');
    },
  } as unknown as S3Client;
  return { client, deleted };
}

test('poll lists the inbound prefix, fetches each object, and skips folder placeholders', async () => {
  const { client } = fakeClient({
    contents: [
      { Key: 'inbound/msg-1', LastModified: new Date('2024-01-01T00:00:00Z') },
      { Key: 'inbound/' }, // the prefix placeholder must not become an email
    ],
    bodies: { 'inbound/msg-1': 'raw-mime' },
  });
  const source = new S3EmailSource({ client, bucket: 'nt-local-receipts' });
  const emails = await source.poll();

  expect(emails).toHaveLength(1);
  expect(emails[0]?.id).toBe('inbound/msg-1');
  expect(emails[0]?.raw.toString()).toBe('raw-mime');
  // SES does not put the recipient in the key, so the runner falls back to the To header.
  expect(emails[0]?.envelopeRecipient).toBeNull();
  expect(emails[0]?.receivedAtSeconds).toBe(Math.floor(Date.parse('2024-01-01T00:00:00Z') / 1000));
});

test('ack deletes the object by its key', async () => {
  const { client, deleted } = fakeClient({ contents: [], bodies: {} });
  const source = new S3EmailSource({ client, bucket: 'nt-local-receipts' });
  await source.ack('inbound/msg-1');
  expect(deleted).toEqual(['inbound/msg-1']);
});
