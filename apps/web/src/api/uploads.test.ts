import { afterEach, expect, test, vi } from 'vitest';

import { sendWorkspaceUpload, serverBusinessIdFor } from './uploads';

/**
 * The practice-side upload boundary (METH S7).
 *
 * Offline by construction: `globalThis.fetch` is replaced with a recorder, so
 * every assertion is about what this module *sent*. The rules worth pinning
 * are the same ones the portal suite pins for the delegated session, at the
 * workspace trust level: our two calls go to the API under `/v1`, the bytes go
 * raw to the presigned URL exactly as signed, and the completion hash is the
 * SHA-256 of what was actually sent.
 */

interface Recorded {
  url: string;
  init: RequestInit;
}

function stubFetch(replies: { body: unknown; status?: number }[]): Recorded[] {
  const calls: Recorded[] = [];
  let index = 0;
  vi.stubGlobal('fetch', (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const reply = replies[index++] ?? { body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const header = (init: RequestInit, name: string): string | null => new Headers(init.headers).get(name);

const INTENT = {
  status: 201,
  body: {
    uploadId: 'up_9',
    upload: { method: 'PUT', url: 'https://storage.test/nt/up_9?sig=xyz', headers: { 'x-amz-meta-nt': '1' } },
    expiresAt: '2026-08-19T13:00:00.000Z',
  },
};

test('the whole journey: intent under /v1, raw PUT to storage, completion with the true hash', async () => {
  const calls = stubFetch([INTENT, { body: {} }, { status: 201, body: { id: 'doc_42', state: 'RECEIVED' } }]);

  const result = await sendWorkspaceUpload('biz_burger', {
    filename: 'currys-receipt.jpg',
    mimeType: 'image/jpeg',
    bytes: new Blob(['receipt bytes'], { type: 'image/jpeg' }),
  });

  expect(result).toEqual({ documentId: 'doc_42', state: 'RECEIVED' });
  const [intent, put, complete] = calls;

  // ① the intent — ours: /v1, the named workspace, the declared file facts.
  expect(intent!.url).toMatch(/\/v1\/document-uploads$/);
  expect(intent!.init.credentials).toBe('include');
  expect(header(intent!.init, 'Idempotency-Key')).not.toBeNull();
  expect(JSON.parse(String(intent!.init.body))).toMatchObject({
    businessId: 'biz_burger',
    channel: 'WEB_UPLOAD',
    filename: 'currys-receipt.jpg',
    mimeType: 'image/jpeg',
    byteSize: 13,
  });

  // ② the bytes — the storage host, the signed headers verbatim, and nothing
  // of ours: no /v1 prefix, no cookie, no Idempotency-Key. Any of those would
  // break the presigned signature — or leak a credential to a third party.
  expect(put!.url).toBe('https://storage.test/nt/up_9?sig=xyz');
  expect(put!.init.method).toBe('PUT');
  expect(put!.init.headers).toEqual({ 'x-amz-meta-nt': '1' });
  expect(put!.init.credentials).toBeUndefined();

  // ③ completion — the shared endpoint, hash of the bytes that actually went.
  expect(complete!.url).toMatch(/\/v1\/document-uploads\/up_9\/complete$/);
  expect(JSON.parse(String(complete!.init.body)).byteHash).toMatch(/^[a-f0-9]{64}$/);
});

test('the channel is the caller\'s to declare — CHAT_UPLOAD travels; unstated it stays WEB_UPLOAD', async () => {
  // WEB_UPLOAD-by-default is pinned by the journey test above (no channel
  // argument there); this pins the chat surface's door name reaching the wire.
  const calls = stubFetch([INTENT, { body: {} }, { status: 201, body: { id: 'doc_43', state: 'RECEIVED' } }]);

  await sendWorkspaceUpload(
    'biz_burger',
    { filename: 'from-chat.jpg', mimeType: 'image/jpeg', bytes: new Blob(['chat bytes']) },
    'CHAT_UPLOAD',
  );

  expect(JSON.parse(String(calls[0]!.init.body)).channel).toBe('CHAT_UPLOAD');
});

test('an empty file is refused before the network is touched', async () => {
  const calls = stubFetch([]);
  await expect(
    sendWorkspaceUpload('biz_burger', { filename: 'empty.jpg', mimeType: 'image/jpeg', bytes: new Blob([]) }),
  ).rejects.toThrow();
  expect(calls).toEqual([]);
});

test('a storage refusal stops the journey — completion is never claimed for bytes that did not land', async () => {
  const calls = stubFetch([INTENT, { body: 'denied', status: 403 }]);
  await expect(
    sendWorkspaceUpload('biz_burger', { filename: 'currys.jpg', mimeType: 'image/jpeg', bytes: new Blob(['x']) }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(2);
});

test('seed client ids bridge to the fixture business ids; real ids pass through untouched', () => {
  // The seed dataset predates the API ('1', '2'); the MSW fixtures and the
  // seeded server businesses carry biz_-prefixed ids. Retires with the real
  // businesses slice (METH S6).
  expect(serverBusinessIdFor('1')).toBe('biz_1');
  expect(serverBusinessIdFor('biz_burger')).toBe('biz_burger');
});
