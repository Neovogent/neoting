import { expect, test } from 'vitest';

import { MailHogEmailSource } from './mailhog-email-source.js';

interface RecordedCall {
  readonly url: string;
  readonly method: string;
}

function stubFetch(handler: (url: string) => Response): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    return handler(String(input));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('poll maps MailHog messages to raw emails with the envelope recipient and receipt time', async () => {
  const { fetchImpl, calls } = stubFetch(() =>
    json({
      items: [
        {
          ID: 'mh-1',
          Created: '2024-04-05T18:14:38Z',
          Raw: { Data: 'From: a@x\r\n\r\nhi', To: ['doc+prac_a@neoting.test'] },
        },
      ],
    }),
  );
  const source = new MailHogEmailSource({ apiUrl: 'http://localhost:8025/', fetchImpl });
  const emails = await source.poll();

  expect(emails).toHaveLength(1);
  expect(emails[0]?.id).toBe('mh-1');
  expect(emails[0]?.raw.toString()).toBe('From: a@x\r\n\r\nhi');
  expect(emails[0]?.envelopeRecipient).toBe('doc+prac_a@neoting.test');
  expect(emails[0]?.receivedAtSeconds).toBe(Math.floor(Date.parse('2024-04-05T18:14:38Z') / 1000));
  // Trailing slash on the base URL must not double up in the path.
  expect(calls[0]?.url).toBe('http://localhost:8025/api/v2/messages?limit=50');
});

test('poll tolerates an empty inbox and a missing items array', async () => {
  const empty = new MailHogEmailSource({ apiUrl: 'http://localhost:8025', fetchImpl: stubFetch(() => json({ items: [] })).fetchImpl });
  expect(await empty.poll()).toEqual([]);
  const noItems = new MailHogEmailSource({ apiUrl: 'http://localhost:8025', fetchImpl: stubFetch(() => json({ total: 0 })).fetchImpl });
  expect(await noItems.poll()).toEqual([]);
});

test('poll throws on a non-200 rather than silently returning nothing', async () => {
  const source = new MailHogEmailSource({
    apiUrl: 'http://localhost:8025',
    fetchImpl: stubFetch(() => new Response('boom', { status: 500 })).fetchImpl,
  });
  await expect(source.poll()).rejects.toThrow(/mailhog list failed/);
});

test('ack DELETEs the message by id; a 404 is treated as already gone', async () => {
  const del = stubFetch(() => new Response(null, { status: 200 }));
  const source = new MailHogEmailSource({ apiUrl: 'http://localhost:8025', fetchImpl: del.fetchImpl });
  await source.ack('mh 1');
  expect(del.calls[0]?.method).toBe('DELETE');
  expect(del.calls[0]?.url).toBe('http://localhost:8025/api/v1/messages/mh%201');

  const gone = new MailHogEmailSource({
    apiUrl: 'http://localhost:8025',
    fetchImpl: stubFetch(() => new Response(null, { status: 404 })).fetchImpl,
  });
  await expect(gone.ack('x')).resolves.toBeUndefined();
});
