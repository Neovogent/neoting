import { expect, test } from 'vitest';

import { processEmail } from '../email/email-intake.js';
import type { EmailAttachment, ParsedEmail } from '../email/parsed-email.js';
import { FixtureIngestQueue } from '../webhooks/whatsapp/ingest-queue.js';
import { documentKey, InMemoryDocumentStore, UNROUTED_WORKSPACE } from './document-store.js';

const PRAC = 'prac_1';
const SHA = 'a'.repeat(64);

function png(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('img')]);
}
function email(attachments: EmailAttachment[], overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    from: 'sender@acme.co',
    to: 'doc@neoting.neovogent.com',
    subject: 'Invoice',
    date: new Date(1_700_000_000_000),
    messageId: '<m@acme.co>',
    text: 'hi',
    attachments,
    ...overrides,
  };
}

test('every key starts w/ — routed and unrouted alike (the IAM constraint)', () => {
  expect(documentKey({ workspaceId: 'biz-1', practiceId: PRAC, sha256: SHA })).toBe(`w/biz-1/documents/${SHA}`);
  expect(documentKey({ workspaceId: null, practiceId: PRAC, sha256: SHA })).toBe(`w/${UNROUTED_WORKSPACE}/${PRAC}/documents/${SHA}`);
  expect(documentKey({ workspaceId: 'biz-1', practiceId: PRAC, sha256: SHA }).startsWith('w/')).toBe(true);
  expect(documentKey({ workspaceId: null, practiceId: PRAC, sha256: SHA }).startsWith('w/')).toBe(true);
});

test('the fixture round-trips: put then get returns identical bytes', async () => {
  const store = new InMemoryDocumentStore();
  const bytes = png();
  const stored = await store.put({ bytes, sha256: SHA, contentType: 'image/png', workspaceId: 'biz-1', practiceId: PRAC });
  expect(stored.key).toBe(`w/biz-1/documents/${SHA}`);
  expect(stored.byteLength).toBe(bytes.length);
  expect((await store.get(stored.key)).equals(bytes)).toBe(true);
});

test('content-addressed: storing identical content twice is one object', async () => {
  const store = new InMemoryDocumentStore();
  const a = await store.put({ bytes: png(), sha256: SHA, contentType: 'image/png', workspaceId: null, practiceId: PRAC });
  const b = await store.put({ bytes: png(), sha256: SHA, contentType: 'image/png', workspaceId: null, practiceId: PRAC });
  expect(a.key).toBe(b.key);
});

test('get on a missing key throws rather than returning empty', async () => {
  const store = new InMemoryDocumentStore();
  await expect(store.get('w/biz-1/documents/missing')).rejects.toThrow();
});

test('processEmail stores the sanitised bytes; the job carries a w/ key that fetches them', async () => {
  const store = new InMemoryDocumentStore();
  const queue = new FixtureIngestQueue();
  await processEmail(email([{ filename: 'receipt.png', contentType: 'image/png', bytes: png() }]), { queue, practiceId: PRAC, store });
  const key = queue.enqueued[0]?.storageKey;
  expect(key).toBeDefined();
  expect(key?.startsWith('w/')).toBe(true);
  if (key !== undefined) expect((await store.get(key)).equals(png())).toBe(true);
});

test('unrouted mail stores under w/_unrouted; a routed sender under its workspace', async () => {
  const store = new InMemoryDocumentStore();

  const unrouted = new FixtureIngestQueue();
  await processEmail(email([{ filename: 'a.png', contentType: 'image/png', bytes: png() }]), { queue: unrouted, practiceId: PRAC, store });
  expect(unrouted.enqueued[0]?.storageKey?.startsWith('w/_unrouted/')).toBe(true);

  const routed = new FixtureIngestQueue();
  const senderMap = new Map<string, readonly string[]>([['sender@acme.co', ['biz-1']]]);
  await processEmail(email([{ filename: 'a.png', contentType: 'image/png', bytes: png() }]), { queue: routed, practiceId: PRAC, store, senderMap });
  expect(routed.enqueued[0]?.storageKey?.startsWith('w/biz-1/')).toBe(true);
});
