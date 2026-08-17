import { expect, test } from 'vitest';

import { CHANNEL_POLICY } from '../lib/sanitisation/index.js';
import {
  FixtureMediaFetcher,
  isRetryable,
  MAX_MEDIA_BYTES,
  MediaFetchError,
  type MediaFetchFailure,
  WHATSAPP_MEDIA_CHANNEL,
} from './media-fetcher.js';

test('WhatsApp media rides the existing client channel, not a channel of its own', () => {
  // There is deliberately no 'whatsapp' Channel: adding one would be a second
  // place to keep the same 25 MB number. 'client' already means WhatsApp intake.
  expect(WHATSAPP_MEDIA_CHANNEL).toBe('client');
  expect(CHANNEL_POLICY[WHATSAPP_MEDIA_CHANNEL]).toBeDefined();
});

test('the size cap is read from the channel policy — one number, not two', () => {
  expect(MAX_MEDIA_BYTES).toBe(CHANNEL_POLICY.client.maxBytes);
  expect(MAX_MEDIA_BYTES).toBe(25 * 1024 * 1024);
});

test('retryability is the whole point of the failure type', () => {
  // This classification decides retry-with-backoff vs straight-to-DLQ. Getting it
  // wrong either burns the retry budget on a dead media id or drops a document a
  // retry would have fetched — so it is asserted by name, exhaustively.
  expect(isRetryable('upstream')).toBe(true);
  expect(isRetryable('transport')).toBe(true);

  const terminal: MediaFetchFailure[] = ['expired', 'not_found', 'unauthorised', 'too_large', 'malformed_response'];
  for (const failure of terminal) {
    expect(isRetryable(failure)).toBe(false);
  }
});

test('MediaFetchError carries its classification, status and an Error identity', () => {
  const error = new MediaFetchError('upstream', 'Meta Graph returned 503', 503);
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('MediaFetchError');
  expect(error.failure).toBe('upstream');
  expect(error.status).toBe(503);
  expect(error.retryable).toBe(true);

  const terminal = new MediaFetchError('expired', 'gone', 404);
  expect(terminal.retryable).toBe(false);
});

test('the fixture round-trips seeded bytes and records what was asked for', async () => {
  const fetcher = new FixtureMediaFetcher();
  const bytes = Buffer.from([1, 2, 3]);
  fetcher.put('media-1', { bytes, declaredMimeType: 'image/png', declaredFilename: 'r.png' });

  const media = await fetcher.fetch('media-1');
  expect(media.bytes).toEqual(bytes);
  expect(media.declaredMimeType).toBe('image/png');
  expect(media.declaredFilename).toBe('r.png');
  expect(fetcher.requested).toEqual(['media-1']);
});

test('the fixture defaults the declared hints to null when they are not seeded', async () => {
  const fetcher = new FixtureMediaFetcher();
  fetcher.put('media-2', { bytes: Buffer.from([0]) });
  const media = await fetcher.fetch('media-2');
  expect(media.declaredMimeType).toBeNull();
  expect(media.declaredFilename).toBeNull();
});

test('failWith makes exactly that id throw exactly that error', async () => {
  const fetcher = new FixtureMediaFetcher();
  const boom = new MediaFetchError('upstream', 'Meta Graph returned 503', 503);
  fetcher.failWith('media-3', boom);
  await expect(fetcher.fetch('media-3')).rejects.toBe(boom);
});

test('an unseeded id fails as not_found and NEVER fabricates bytes', async () => {
  // MEDIA_FETCH defaults to 'fixture', so a fixture that invented a placeholder
  // image would turn every real staging receipt into a made-up document that
  // looks successfully ingested. A missing document is visible in the DLQ; a fake
  // one is visible nowhere. So the unseeded path must fail, not fabricate.
  const fetcher = new FixtureMediaFetcher();
  const error = await fetcher.fetch('never-seeded').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MediaFetchError);
  expect((error as MediaFetchError).failure).toBe('not_found');
  expect(fetcher.requested).toEqual(['never-seeded']);
});
