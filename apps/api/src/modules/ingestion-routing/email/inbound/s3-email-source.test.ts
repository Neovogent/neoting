import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { expect, test } from 'vitest';

import { S3EmailSource } from './s3-email-source.js';

interface FakeContents {
  readonly Key?: string;
  readonly LastModified?: Date;
  readonly Size?: number;
}

/** A minimal fake S3 client that dispatches on the command type — no network. */
function fakeClient(opts: { contents: FakeContents[]; bodies: Record<string, string> }): {
  client: S3Client;
  deleted: string[];
  copied: { from: string; to: string }[];
  fetched: string[];
} {
  const deleted: string[] = [];
  const copied: { from: string; to: string }[] = [];
  const fetched: string[] = [];
  const client = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof ListObjectsV2Command) return { Contents: opts.contents };
      if (command instanceof GetObjectCommand) {
        const key = (command.input as { Key?: string }).Key ?? '';
        fetched.push(key);
        return { Body: { transformToByteArray: async () => new TextEncoder().encode(opts.bodies[key] ?? '') } };
      }
      if (command instanceof DeleteObjectCommand) {
        deleted.push((command.input as { Key?: string }).Key ?? '');
        return {};
      }
      if (command instanceof CopyObjectCommand) {
        const input = command.input as { CopySource?: string; Key?: string };
        copied.push({ from: input.CopySource ?? '', to: input.Key ?? '' });
        return {};
      }
      throw new Error('unexpected command');
    },
  } as unknown as S3Client;
  return { client, deleted, copied, fetched };
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

test('quarantine copies under unroutable/ then deletes the original — out of the window, never dropped', async () => {
  const { client, deleted, copied } = fakeClient({ contents: [], bodies: {} });
  const source = new S3EmailSource({ client, bucket: 'nt-local-receipts' });
  await source.quarantine('inbound/msg-9');
  expect(copied).toEqual([{ from: 'nt-local-receipts/inbound/msg-9', to: 'unroutable/msg-9' }]);
  expect(deleted).toEqual(['inbound/msg-9']); // delete AFTER the copy, so a crash duplicates, never loses
});

test('an object over the raw-MIME cap is quarantined from the LISTING, before any bytes are fetched', async () => {
  // The cap must run off the listing's Size: a poll must never be an
  // allocation the sender controls, and a merely-skipped oversize object would
  // occupy its window slot forever — the same starvation an unresolvable
  // email caused.
  const warns: string[] = [];
  const { client, copied, fetched } = fakeClient({
    contents: [
      { Key: 'inbound/huge', LastModified: new Date('2024-01-01T00:00:00Z'), Size: 50 * 1024 * 1024 },
      { Key: 'inbound/ok', LastModified: new Date('2024-01-01T00:00:00Z'), Size: 100 },
    ],
    bodies: { 'inbound/ok': 'raw-mime' },
  });
  const source = new S3EmailSource({ client, bucket: 'nt-local-receipts', logger: { warn: (m) => warns.push(m) } });
  const emails = await source.poll();

  expect(emails.map((e) => e.id)).toEqual(['inbound/ok']);
  expect(fetched).toEqual(['inbound/ok']); // the oversize bytes were never allocated
  expect(copied).toEqual([{ from: 'nt-local-receipts/inbound/huge', to: 'unroutable/huge' }]);
  expect(warns.some((w) => w.includes('inbound/huge') && w.includes('cap'))).toBe(true);
});
