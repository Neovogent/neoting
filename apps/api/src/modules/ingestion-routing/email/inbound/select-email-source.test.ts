import { expect, test } from 'vitest';

import type { Env } from '../../../../config/env.js';
import { type EmailSource, FixtureEmailSource } from './email-source.js';
import { selectEmailSource } from './select-email-source.js';

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
    OBJECT_STORE: 'fixture',
    EMAIL_SOURCE: 'fixture',
    MAILHOG_API_URL: 'http://localhost:8025',
    S3_BUCKET_RECEIPTS: 'nt-local-receipts',
    IMAGE_NORMALISER: 'fixture',
    DOCUMENT_GUARD: 'fixture',
    EXTRACTOR: 'demo',
    SMS_SENDER: 'demo',
    PORTAL_LINK_SECRET: '',
    PORTAL_SESSION_SECRET: '',
    LEDGER_ADAPTER: 'demo',
    S3_ENDPOINT: '',
    S3_REGION: 'eu-west-2',
    S3_ACCESS_KEY_ID: '',
    S3_SECRET_ACCESS_KEY: '',
    S3_FORCE_PATH_STYLE: false,
    S3_BUCKET_DOCUMENTS: 'nt-local-docs',
    ...overrides,
  });
}

const stub: EmailSource = {
  async poll() {
    return [];
  },
  async ack() {
    /* no-op */
  },
  async quarantine() {
    /* no-op */
  },
};

test('fixture mode returns the in-memory source and constructs no real client', () => {
  let mailhog = false;
  let s3 = false;
  const source = selectEmailSource(
    env({ EMAIL_SOURCE: 'fixture' }),
    () => {
      mailhog = true;
      return stub;
    },
    () => {
      s3 = true;
      return stub;
    },
  );
  expect(source).toBeInstanceOf(FixtureEmailSource);
  expect(mailhog).toBe(false);
  expect(s3).toBe(false);
});

test('mailhog mode builds from the mailhog seam only', () => {
  let s3 = false;
  const source = selectEmailSource(
    env({ EMAIL_SOURCE: 'mailhog' }),
    () => stub,
    () => {
      s3 = true;
      return stub;
    },
  );
  expect(source).toBe(stub);
  expect(s3).toBe(false);
});

test('s3 mode builds from the s3 seam only — no S3 client opened in the test', () => {
  let mailhog = false;
  const source = selectEmailSource(
    env({ EMAIL_SOURCE: 's3' }),
    () => {
      mailhog = true;
      return stub;
    },
    () => stub,
  );
  expect(source).toBe(stub);
  expect(mailhog).toBe(false);
});
