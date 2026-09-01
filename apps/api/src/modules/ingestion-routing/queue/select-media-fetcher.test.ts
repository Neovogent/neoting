import { expect, test } from 'vitest';

import type { Env } from '../../../config/env.js';
import { DEMO_WHATSAPP_MEDIA_ID, FixtureMediaFetcher, type MediaFetcher } from './media-fetcher.js';
import { selectMediaFetcher } from './select-media-fetcher.js';

function env(overrides: Partial<Env> = {}): Env {
  return Object.freeze({
    NODE_ENV: 'test',
    PORT: 3000,
    META_APP_SECRET: '',
    META_VERIFY_TOKEN: '',
    META_MEDIA_ACCESS_TOKEN: '',
    MEDIA_FETCH: 'fixture',
    WHATSAPP_PRACTICE_MAP: {},
    AUTH_MODE: 'fixture', SESSION_SECRET: 'test-session-secret', OTP_MODE: 'demo', APP_ORIGIN: 'https://app.test',
    UPLOAD_URL_SECRET: 'test-secret',
    UPLOAD_URL_TTL_SECONDS: 900,
    INGEST_QUEUE: 'fixture',
    REDIS_URL: 'redis://localhost:6379',
    OBJECT_STORE: 'fixture',
    EMAIL_SOURCE: 'fixture',
    MAILHOG_API_URL: 'http://localhost:8025',
    S3_BUCKET_RECEIPTS: 'nt-local-receipts',
    IMAGE_NORMALISER: 'fixture',
    DOCUMENT_GUARD: 'fixture',
    EXTRACTOR: 'demo',
    BEDROCK_REGION: 'eu-west-2',
    SMS_SENDER: 'demo',
    EMAIL_SENDER: 'demo', SES_REGION: 'eu-west-2', EMAIL_FROM_ADDRESS: 'no-reply@neoting.neovogent.com', EMAIL_REPLY_TO_ADDRESS: 'support@neovogent.com', EMAIL_CONFIGURATION_SET: '', EMAIL_RATE_LIMIT: 'memory',
    PORTAL_LINK_SECRET: '',
    PORTAL_SESSION_SECRET: '',
    LEDGER_ADAPTER: 'demo',
    AI_CHAT: 'demo',
    AI_DAILY_BUDGET_PENCE: 500,
    BILLING: 'demo', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_PRICE_ID: '',
    STRIPE_TAX: 'rate', STRIPE_TAX_RATE_ID: '', BILLING_RETURN_ORIGINS: '',
    S3_ENDPOINT: '',
    S3_REGION: 'eu-west-2',
    S3_ACCESS_KEY_ID: '',
    S3_SECRET_ACCESS_KEY: '',
    S3_FORCE_PATH_STYLE: false,
    S3_BUCKET_DOCUMENTS: 'nt-local-docs',
    STATEMENT_READER: 'none',
    ...overrides,
  });
}

const stub: MediaFetcher = {
  async fetch() {
    return { bytes: Buffer.alloc(0), declaredMimeType: null, declaredFilename: null };
  },
};

test('fixture mode returns the in-memory fetcher and never constructs a graph client', () => {
  // The offline default must not build a Graph client — that is what keeps the
  // suite (and any dev without Meta credentials) from needing a network.
  let called = false;
  const fetcher = selectMediaFetcher(env({ MEDIA_FETCH: 'fixture' }), () => {
    called = true;
    return stub;
  });
  expect(fetcher).toBeInstanceOf(FixtureMediaFetcher);
  expect(called).toBe(false);
});

test('fixture mode pre-seeds the demo:whatsapp media id so the demo lands a document', async () => {
  // DEMO-MOCK path: without the seed the demo webhook's media id throws not_found
  // and the job dead-letters with no document. selectMediaFetcher seeds it on the
  // fixture branch only.
  const fetcher = selectMediaFetcher(env({ MEDIA_FETCH: 'fixture' }));
  const media = await fetcher.fetch(DEMO_WHATSAPP_MEDIA_ID);
  expect(media.bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

test('graph mode builds the fetcher from the seam exactly once — no socket in the test', () => {
  let calls = 0;
  const fetcher = selectMediaFetcher(env({ MEDIA_FETCH: 'graph', META_MEDIA_ACCESS_TOKEN: 'tok_live' }), () => {
    calls += 1;
    return stub;
  });
  expect(fetcher).toBe(stub);
  expect(calls).toBe(1);
});

test('graph mode is untouched by the demo seed — the demo id does not resolve there', async () => {
  // The graph fetcher must never carry a fabricated demo id. Proves the seed is
  // strictly fixture-scoped, so no real Meta media id path is affected.
  const fetcher = selectMediaFetcher(env({ MEDIA_FETCH: 'graph', META_MEDIA_ACCESS_TOKEN: 'tok_live' }), () => stub);
  const media = await fetcher.fetch(DEMO_WHATSAPP_MEDIA_ID);
  expect(media.bytes.byteLength).toBe(0); // the stub, not seeded demo bytes
});

test('graph mode hands the seam the resolved env, so the token comes from config', () => {
  // Proves the bearer reaches the Graph client from env, not from a module-level
  // read of process.env — the credential path issue #79 flagged as Shakib's.
  let seenToken: string | undefined;
  selectMediaFetcher(env({ MEDIA_FETCH: 'graph', META_MEDIA_ACCESS_TOKEN: 'tok_from_config' }), (resolved) => {
    seenToken = resolved.META_MEDIA_ACCESS_TOKEN;
    return stub;
  });
  expect(seenToken).toBe('tok_from_config');
});
