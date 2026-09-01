import { createHmac } from 'node:crypto';

import { type ExecutionContext, HttpStatus } from '@nestjs/common';
import { expect, test } from 'vitest';

import { AppException } from '../../../../common/problem/problem.js';
import type { Env } from '../../../../config/env.js';
import { WhatsAppSignatureGuard } from './whatsapp-signature.guard.js';

const SECRET = 'guard-secret';
const env: Env = Object.freeze({
  NODE_ENV: 'test', PORT: 3000, META_APP_SECRET: SECRET, META_VERIFY_TOKEN: 'vt',
  META_MEDIA_ACCESS_TOKEN: '', MEDIA_FETCH: 'fixture', WHATSAPP_PRACTICE_MAP: {},
  AUTH_MODE: 'fixture', SESSION_SECRET: 'test-session-secret', APP_ORIGIN: 'https://app.test', OTP_MODE: 'demo', UPLOAD_URL_SECRET: 'test-secret', UPLOAD_URL_TTL_SECONDS: 900,
  INGEST_QUEUE: 'fixture', REDIS_URL: 'redis://localhost:6379',
  OBJECT_STORE: 'fixture', EMAIL_SOURCE: 'fixture', MAILHOG_API_URL: 'http://localhost:8025', S3_BUCKET_RECEIPTS: 'nt-local-receipts',
  IMAGE_NORMALISER: 'fixture', DOCUMENT_GUARD: 'fixture', EXTRACTOR: 'demo',
  BEDROCK_REGION: 'eu-west-2',
  LEDGER_ADAPTER: 'demo', AI_CHAT: 'demo', AI_DAILY_BUDGET_PENCE: 500, SMS_SENDER: 'demo', PORTAL_LINK_SECRET: '', PORTAL_SESSION_SECRET: '', S3_ENDPOINT: '', S3_REGION: 'eu-west-2',
  EMAIL_SENDER: 'demo', SES_REGION: 'eu-west-2', EMAIL_FROM_ADDRESS: 'no-reply@neoting.neovogent.com', EMAIL_REPLY_TO_ADDRESS: 'support@neovogent.com', EMAIL_CONFIGURATION_SET: '', EMAIL_RATE_LIMIT: 'memory',
  BILLING: 'demo', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_PRICE_ID: '',
  STRIPE_TAX: 'rate', STRIPE_TAX_RATE_ID: '', BILLING_RETURN_ORIGINS: '',
  S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '', S3_FORCE_PATH_STYLE: false, S3_BUCKET_DOCUMENTS: 'nt-local-docs', STATEMENT_READER: 'none',
});

function sign(body: Buffer): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

function context(rawBody: Buffer | undefined, signature: string | undefined): ExecutionContext {
  const req = {
    rawBody,
    header: (name: string): string | undefined =>
      name.toLowerCase() === 'x-hub-signature-256' ? signature : undefined,
  };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

test('passes a correctly signed request', () => {
  const guard = new WhatsAppSignatureGuard(env);
  const body = Buffer.from(JSON.stringify({ ok: true }));
  expect(guard.canActivate(context(body, sign(body)))).toBe(true);
});

test('rejects a bad signature with a 401 problem+json — the test that matters most', () => {
  const guard = new WhatsAppSignatureGuard(env);
  const body = Buffer.from(JSON.stringify({ ok: true }));
  let thrown: unknown;
  try {
    guard.canActivate(context(body, `sha256=${'a'.repeat(64)}`));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppException);
  expect((thrown as AppException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  expect((thrown as AppException).code).toBe('NT-INT-001');
});
