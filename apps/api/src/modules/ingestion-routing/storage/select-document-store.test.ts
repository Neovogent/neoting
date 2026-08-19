import { expect, test } from 'vitest';

import type { Env } from '../../../config/env.js';
import { type DocumentStore, InMemoryDocumentStore } from './document-store.js';
import { selectDocumentStore } from './select-document-store.js';

function env(overrides: Partial<Env> = {}): Env {
  return Object.freeze({
    NODE_ENV: 'test',
    PORT: 3000,
    META_APP_SECRET: '',
    META_VERIFY_TOKEN: '',
    META_MEDIA_ACCESS_TOKEN: '',
    MEDIA_FETCH: 'fixture',
    WHATSAPP_PRACTICE_MAP: {},
    AUTH_MODE: 'fixture', SESSION_SECRET: 'test-session-secret', OTP_MODE: 'demo',
    UPLOAD_URL_SECRET: 'test-secret',
    UPLOAD_URL_TTL_SECONDS: 900,
    INGEST_QUEUE: 'fixture',
    REDIS_URL: 'redis://localhost:6379',
    OBJECT_STORE: 'fixture', IMAGE_NORMALISER: 'fixture', DOCUMENT_GUARD: 'fixture', EXTRACTOR: 'demo',
    BEDROCK_MODEL_ID: 'eu.anthropic.claude-opus-5',
    BEDROCK_REGION: 'eu-west-2', LEDGER_ADAPTER: 'demo',
    SMS_SENDER: 'demo', PORTAL_LINK_SECRET: '', PORTAL_SESSION_SECRET: '',
    EMAIL_SOURCE: 'fixture',
    MAILHOG_API_URL: 'http://localhost:8025',
    S3_BUCKET_RECEIPTS: 'nt-local-receipts',
    S3_ENDPOINT: '',
    S3_REGION: 'eu-west-2',
    S3_ACCESS_KEY_ID: '',
    S3_SECRET_ACCESS_KEY: '',
    S3_FORCE_PATH_STYLE: false,
    S3_BUCKET_DOCUMENTS: 'nt-local-docs',
    ...overrides,
  });
}

test('fixture mode returns the in-memory store (offline default)', () => {
  expect(selectDocumentStore(env({ OBJECT_STORE: 'fixture' }))).toBeInstanceOf(InMemoryDocumentStore);
});

test('s3 mode builds the real store from config — no S3 client opened in the test', () => {
  const stub: DocumentStore = {
    async put() {
      return { key: 'w/x/documents/y', sha256: 'y', byteLength: 0 };
    },
    async get() {
      return Buffer.alloc(0);
    },
    async sha256() {
      return 'y';
    },
    async presignPut() {
      return { key: 'w/x/uploads/z', url: 'https://example.test/put', headers: {} };
    },
    async presignGet() {
      return { url: 'https://example.test/get', expiresAt: new Date(0) };
    },
    async head() {
      return null;
    },
  };
  let called = false;
  const store = selectDocumentStore(env({ OBJECT_STORE: 's3' }), () => {
    called = true;
    return stub;
  });
  expect(store).toBe(stub);
  expect(called).toBe(true);
});
