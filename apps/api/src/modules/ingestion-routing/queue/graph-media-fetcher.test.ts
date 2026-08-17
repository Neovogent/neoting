import { expect, test } from 'vitest';

import { createGraphMediaFetcher } from './graph-media-fetcher.js';
import { MediaFetchError } from './media-fetcher.js';

const TOKEN = 'test-token';
const BASE = 'https://graph.test/v1';

interface RecordedCall {
  readonly url: string;
  readonly authorization: string | null;
  readonly redirect: string | undefined;
}

/**
 * A stub `fetch` that answers each call from a queued handler and records the URL
 * and Authorization header it saw. Entirely offline — no socket is ever opened,
 * so every branch of the real two-step Graph fetch is exercised deterministically.
 */
function stubFetch(handlers: ReadonlyArray<(url: string) => Response>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      redirect: init?.redirect,
    });
    const handler = handlers[index];
    index += 1;
    if (handler === undefined) throw new Error(`unexpected fetch call #${index} to ${String(input)}`);
    return handler(String(input));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function make(
  handlers: ReadonlyArray<(url: string) => Response>,
  maxBytes?: number,
): { fetcher: ReturnType<typeof createGraphMediaFetcher>; calls: RecordedCall[] } {
  const { fetchImpl, calls } = stubFetch(handlers);
  const fetcher = createGraphMediaFetcher({
    accessToken: TOKEN,
    graphBaseUrl: BASE,
    fetchImpl,
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  return { fetcher, calls };
}

test('resolves a media id in two authenticated steps and returns the bytes', async () => {
  const bytes = Buffer.from([1, 2, 3, 4]);
  const { fetcher, calls } = make([
    () => json({ url: 'https://lookaside.fbsbx.com/media/abc', mime_type: 'image/png', file_size: bytes.length }),
    () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }),
  ]);

  const media = await fetcher.fetch('a b'); // a space, to prove the id is URL-encoded

  expect(calls).toHaveLength(2);
  expect(calls[0]?.url).toBe(`${BASE}/a%20b`); // step 1 hit the base with the id encoded
  expect(calls[1]?.url).toBe('https://lookaside.fbsbx.com/media/abc'); // step 2 hit the download url
  // BOTH requests carry the bearer — the download is authenticated too.
  expect(calls[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  expect(calls[1]?.authorization).toBe(`Bearer ${TOKEN}`);
  // BOTH requests refuse to auto-follow a redirect — the host allowlist would only
  // validate the first hop, so a 30x must not be chased (SSRF defence in depth).
  expect(calls[0]?.redirect).toBe('manual');
  expect(calls[1]?.redirect).toBe('manual');
  expect(media.bytes).toEqual(bytes);
  expect(media.declaredMimeType).toBe('image/png');
  expect(media.declaredFilename).toBeNull(); // Meta puts the filename on the message, not the media
});

test('refuses to send the bearer to a host off the allowlist — the SSRF guard', async () => {
  // The download URL comes from a JSON field. Sending our bearer to whatever host
  // it names is the shape of an SSRF, so a foreign host is refused BEFORE step 2,
  // and the token is never put on the wire to it. 'evil-fbcdn.net' also proves the
  // suffix match is a real dotted-suffix, not a substring.
  for (const evil of ['https://evil.example.com/x', 'https://evil-fbcdn.net/x']) {
    const { fetcher, calls } = make([() => json({ url: evil, mime_type: 'image/png' })]);
    const error = await fetcher.fetch('m1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaFetchError);
    expect((error as MediaFetchError).failure).toBe('malformed_response');
    expect(calls).toHaveLength(1); // step 2 never happened — the bearer never left for the foreign host
  }
});

test('refuses to follow a redirect on the metadata step — the allowlist only validates the first hop', async () => {
  // A 30x from the Graph base could bounce the bearer to a non-Meta or internal
  // host that the allowlist never checks. It must be refused, not followed, and the
  // redirect target must never be requested.
  const { fetcher, calls } = make([
    () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } }),
  ]);
  const error = await fetcher.fetch('m1').catch((e: unknown) => e);
  expect((error as MediaFetchError).failure).toBe('malformed_response');
  expect(calls).toHaveLength(1); // the redirect target was never requested
});

test('refuses to follow a redirect on the download step, even from an allowed host', async () => {
  const { fetcher, calls } = make([
    () => json({ url: 'https://lookaside.fbsbx.com/media/abc' }),
    () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } }),
  ]);
  const error = await fetcher.fetch('m1').catch((e: unknown) => e);
  expect((error as MediaFetchError).failure).toBe('malformed_response');
  expect(calls).toHaveLength(2); // the download was made and refused; no third hop to evil
});

test('refuses a non-https download url even on an allowed host', async () => {
  const { fetcher, calls } = make([() => json({ url: 'http://lookaside.fbsbx.com/x' })]);
  const error = await fetcher.fetch('m1').catch((e: unknown) => e);
  expect((error as MediaFetchError).failure).toBe('malformed_response');
  expect(calls).toHaveLength(1);
});

test('an unparseable download url is a malformed response', async () => {
  const { fetcher } = make([() => json({ url: 'not a url' })]);
  const error = await fetcher.fetch('m1').catch((e: unknown) => e);
  expect((error as MediaFetchError).failure).toBe('malformed_response');
});

test('a metadata response with no url field is a malformed response', async () => {
  const { fetcher } = make([() => json({ mime_type: 'image/png' })]);
  const error = await fetcher.fetch('m1').catch((e: unknown) => e);
  expect((error as MediaFetchError).failure).toBe('malformed_response');
});

test('maps upstream statuses to failure kinds, carrying the status through', async () => {
  const cases: Array<{ status: number; body: unknown; failure: string; retryable: boolean }> = [
    { status: 401, body: {}, failure: 'unauthorised', retryable: false },
    { status: 403, body: {}, failure: 'unauthorised', retryable: false },
    { status: 429, body: {}, failure: 'upstream', retryable: true },
    { status: 500, body: {}, failure: 'upstream', retryable: true },
    { status: 503, body: {}, failure: 'upstream', retryable: true },
    { status: 404, body: { error: { code: 100, error_subcode: 33 } }, failure: 'expired', retryable: false },
    { status: 404, body: { error: { message: 'gone' } }, failure: 'not_found', retryable: false },
    { status: 400, body: { error: { code: 100, error_subcode: 33 } }, failure: 'expired', retryable: false },
  ];
  for (const c of cases) {
    const { fetcher } = make([() => json(c.body, c.status)]);
    const error = await fetcher.fetch('m1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaFetchError);
    const mfe = error as MediaFetchError;
    expect(mfe.failure).toBe(c.failure);
    expect(mfe.retryable).toBe(c.retryable);
    expect(mfe.status).toBe(c.status);
  }
});

test('a 5xx on the download step is upstream and retryable', async () => {
  const { fetcher, calls } = make([
    () => json({ url: 'https://lookaside.fbsbx.com/media/abc' }),
    () => new Response('boom', { status: 503 }),
  ]);
  const error = await fetcher.fetch('m1').catch((e: unknown) => e);
  expect((error as MediaFetchError).failure).toBe('upstream');
  expect((error as MediaFetchError).retryable).toBe(true);
  expect(calls).toHaveLength(2);
});

test('a thrown fetch is a transport failure and retryable, on either step', async () => {
  const boom = (): Response => {
    throw new Error('ECONNRESET');
  };
  const step1 = make([boom]);
  const e1 = await step1.fetcher.fetch('m1').catch((e: unknown) => e);
  expect((e1 as MediaFetchError).failure).toBe('transport');
  expect((e1 as MediaFetchError).retryable).toBe(true);

  const step2 = make([() => json({ url: 'https://lookaside.fbsbx.com/media/abc' }), boom]);
  const e2 = await step2.fetcher.fetch('m1').catch((e: unknown) => e);
  expect((e2 as MediaFetchError).failure).toBe('transport');
});

test('a declared file_size over the cap is refused before the download starts', async () => {
  const { fetcher, calls } = make([() => json({ url: 'https://lookaside.fbsbx.com/media/abc', file_size: 100 })], 8);
  const error = await fetcher.fetch('m1').catch((e: unknown) => e);
  expect((error as MediaFetchError).failure).toBe('too_large');
  expect(calls).toHaveLength(1); // step 2 never ran — no bytes transferred
});

test('a download whose content-length exceeds the cap is refused without reading the body', async () => {
  const { fetcher } = make(
    [
      () => json({ url: 'https://lookaside.fbsbx.com/media/abc' }),
      () => new Response(Buffer.alloc(100), { status: 200, headers: { 'content-length': '100' } }),
    ],
    8,
  );
  const error = await fetcher.fetch('m1').catch((e: unknown) => e);
  expect((error as MediaFetchError).failure).toBe('too_large');
});

test('a chunked download with no content-length is capped ON THE STREAM, not after', async () => {
  // The dangerous case: no content-length to check up front. The cap must be
  // enforced per-chunk and must cancel the stream, or a malicious sender streams
  // gigabytes into a worker that already "passed" the header check.
  let produced = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced += 1;
      if (produced > 50) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(4)); // 4 bytes per chunk
    },
  });
  const { fetcher } = make(
    [() => json({ url: 'https://lookaside.fbsbx.com/media/abc' }), () => new Response(stream, { status: 200 })],
    8,
  );

  const error = await fetcher.fetch('m1').catch((e: unknown) => e);
  expect((error as MediaFetchError).failure).toBe('too_large');
  // The stream was cancelled early — the worker did NOT drain all 50 chunks.
  expect(produced).toBeLessThan(50);
});

test('a download with a null body is a malformed response', async () => {
  const { fetcher } = make([
    () => json({ url: 'https://lookaside.fbsbx.com/media/abc' }),
    () => new Response(null, { status: 200 }),
  ]);
  const error = await fetcher.fetch('m1').catch((e: unknown) => e);
  expect((error as MediaFetchError).failure).toBe('malformed_response');
});
