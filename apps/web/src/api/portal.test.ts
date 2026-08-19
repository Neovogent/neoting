import { afterEach, expect, test, vi } from 'vitest';

import { fetchPortalView, openPortalSession, sendPortalUpload, toPortalItem } from './portal';

/**
 * The portal boundary.
 *
 * Offline by construction (Governance §15.1): `globalThis.fetch` is replaced
 * with a recorder, so nothing opens a socket and every assertion is about what
 * this module *sent* and what it did with the answer. That is the part worth
 * testing — the money conversion, and the two rules that make the delegated
 * session safe: the bearer goes to the API and the bearer does NOT go to the
 * storage host.
 */

const CONTEXT = {
  businessName: 'American Burger Ltd',
  items: [
    {
      transactionId: 'txn_currys',
      merchantName: 'Currys',
      descriptionRaw: 'CURRYS PC WORLD 4417',
      amountPence: -129_900,
      bookedAt: '2026-08-09T00:00:00.000Z',
      received: false,
    },
  ],
  expiresAt: '2026-08-19T12:00:00.000Z',
};

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

/* ── the money and the labels ─────────────────────────────────────────────── */

test('integer pence become pounds, with the sign the feed recorded', () => {
  const item = toPortalItem(CONTEXT.items[0]!);
  expect(item.amount).toBe(-1299);
  expect(item.transactionId).toBe('txn_currys');
  expect(item.received).toBe(false);
});

test('a pence value that is not a round pound survives the conversion exactly', () => {
  const item = toPortalItem({ ...CONTEXT.items[0]!, amountPence: -42_099 });
  expect(item.amount).toBe(-420.99);
});

test('the merchant name wins, the raw bank descriptor is the fallback, then nothing', () => {
  expect(toPortalItem(CONTEXT.items[0]!).label).toBe('Currys');
  expect(toPortalItem({ ...CONTEXT.items[0]!, merchantName: null }).label).toBe('CURRYS PC WORLD 4417');
  expect(toPortalItem({ ...CONTEXT.items[0]!, merchantName: null, descriptionRaw: null }).label).toBeNull();
});

test('the booked date renders the way every other screen renders one', () => {
  expect(toPortalItem(CONTEXT.items[0]!).date).toBe('09 Aug 2026');
});

/* ── the session ──────────────────────────────────────────────────────────── */

test('a code that is not six digits is refused before the network is touched', async () => {
  const calls = stubFetch([]);
  await expect(openPortalSession('tok.sig', '00000')).rejects.toThrow();
  expect(calls).toEqual([]);
});

test('opening a session posts the link token and the code, and nothing else', async () => {
  const calls = stubFetch([{ body: { token: 'portal.bearer', expiresAt: '2026-08-19T12:00:00.000Z' }, status: 201 }]);

  const session = await openPortalSession('tok.sig', '000000');

  expect(session.token).toBe('portal.bearer');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toMatch(/\/v1\/portal\/sessions$/);
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ linkToken: 'tok.sig', otp: '000000' });
  // Public operation: there is no session yet to authenticate with.
  expect(header(calls[0]!.init, 'Authorization')).toBeNull();
});

/* ── the context ──────────────────────────────────────────────────────────── */

test('the context is read with the bearer and parsed by the contract schema', async () => {
  const calls = stubFetch([{ body: CONTEXT }]);

  const view = await fetchPortalView('portal.bearer');

  expect(header(calls[0]!.init, 'Authorization')).toBe('Bearer portal.bearer');
  expect(view.businessName).toBe('American Burger Ltd');
  expect(view.items).toHaveLength(1);
  expect(view.items[0]!.amount).toBe(-1299);
});

test('a context body that does not match the contract fails at the boundary', async () => {
  // A float in a pence field is exactly what the money invariant exists to
  // stop, and the generated schema carries `.int()` for that reason. The value
  // arrives through a variable because the R5 lint rule refuses a float literal
  // in a `*Pence` slot — including in the test that proves the runtime gate
  // works, which is the rule doing its job rather than an inconvenience.
  const halfAPennyShort = -1299.5;
  stubFetch([{ body: { ...CONTEXT, items: [{ ...CONTEXT.items[0]!, amountPence: halfAPennyShort }] } }]);
  await expect(fetchPortalView('portal.bearer')).rejects.toThrow();
});

/* ── the upload ───────────────────────────────────────────────────────────── */

test('the bytes go to the presigned URL with its own headers and no bearer', async () => {
  const calls = stubFetch([
    {
      status: 201,
      body: {
        uploadId: 'up_1',
        upload: { method: 'PUT', url: 'https://storage.test/nt/up_1?sig=abc', headers: { 'x-amz-meta-nt': '1' } },
        expiresAt: '2026-08-18T13:00:00.000Z',
      },
    },
    { body: {} },
    { status: 201, body: { id: 'doc_1' } },
  ]);

  await sendPortalUpload(
    'portal.bearer',
    { filename: 'currys.jpg', mimeType: 'image/jpeg', bytes: new Blob(['receipt'], { type: 'image/jpeg' }) },
    'txn_currys',
  );

  const [intent, put, complete] = calls;

  // ① the intent — ours, so it carries the bearer and the chased item.
  expect(intent!.url).toMatch(/\/v1\/portal\/uploads$/);
  expect(header(intent!.init, 'Authorization')).toBe('Bearer portal.bearer');
  expect(JSON.parse(String(intent!.init.body))).toMatchObject({
    filename: 'currys.jpg',
    mimeType: 'image/jpeg',
    transactionId: 'txn_currys',
  });

  // ② the bytes — the storage host, signed headers verbatim, and NOT our
  // credential. Sending the bearer to a third-party host would leak an upload
  // grant for someone's books to whoever runs it.
  expect(put!.url).toBe('https://storage.test/nt/up_1?sig=abc');
  expect(put!.init.method).toBe('PUT');
  expect(put!.init.headers).toEqual({ 'x-amz-meta-nt': '1' });
  expect(header(put!.init, 'Authorization')).toBeNull();
  expect(put!.init.credentials).toBeUndefined();

  // ③ completion — the shared endpoint, which the contract lets the portal
  // bearer use. One completion path, two trust levels.
  expect(complete!.url).toMatch(/\/v1\/document-uploads\/up_1\/complete$/);
  expect(header(complete!.init, 'Authorization')).toBe('Bearer portal.bearer');
  expect(JSON.parse(String(complete!.init.body)).byteHash).toMatch(/^[a-f0-9]{64}$/);
});
