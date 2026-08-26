import { expect, test } from 'vitest';

import { loadEnv } from './env.js';

/**
 * The smallest environment that actually boots under `NODE_ENV=production`.
 *
 * It is a named fixture because the list only ever grows — every gate added to
 * the `superRefine` block adds a variable a production boot must supply, and
 * spelling the list out at each call site means the next gate breaks six tests
 * that were not about it. Adding a line here is the intended cost of adding a
 * gate.
 */
const PRODUCTION = {
  NODE_ENV: 'production',
  AUTH_MODE: 'session',
  UPLOAD_URL_SECRET: 's',
  AI_CHAT: 'bedrock',
  EMAIL_SENDER: 'ses',
  EMAIL_CONFIGURATION_SET: 'nt-staging-default',
  EMAIL_RATE_LIMIT: 'redis',
  // A2: the fixed six-digit code is refused in production, so a bootable
  // production environment now has to name the real verifier. This is the line
  // the comment above predicts every new gate will cost.
  OTP_MODE: 'totp',
} as unknown as NodeJS.ProcessEnv;

test('loads defaults; the Meta secrets are optional and default empty', () => {
  const env = loadEnv({});
  expect(env.PORT).toBe(3000);
  expect(env.NODE_ENV).toBe('development');
  expect(env.META_APP_SECRET).toBe('');
  expect(env.META_VERIFY_TOKEN).toBe('');
});

test('coerces PORT and reads the Meta secrets when present', () => {
  const env = loadEnv({ PORT: '3000', META_APP_SECRET: 'secret', META_VERIFY_TOKEN: 'token' } as NodeJS.ProcessEnv);
  expect(env.PORT).toBe(3000);
  expect(env.META_APP_SECRET).toBe('secret');
});

test('fails fast on a malformed PORT', () => {
  expect(() => loadEnv({ PORT: 'not-a-number' } as NodeJS.ProcessEnv)).toThrow(/environment configuration/i);
});

// The bug that kept the workers service at desired_count = 0: ECS injects the
// parts, nothing joined them, and REDIS_URL silently defaulted to localhost.
test('derives REDIS_URL from the parts ECS injects', () => {
  const env = loadEnv({
    REDIS_HOST: 'nt-staging-redis.abc.cache.amazonaws.com',
    REDIS_PORT: '6379',
    REDIS_TLS: 'true',
    REDIS_AUTH_TOKEN: 'token',
  } as NodeJS.ProcessEnv);

  expect(env.REDIS_URL).toBe('rediss://:token@nt-staging-redis.abc.cache.amazonaws.com:6379');
});

test('an explicit REDIS_URL always wins over the parts', () => {
  const env = loadEnv({
    REDIS_URL: 'redis://explicit:6379',
    REDIS_HOST: 'ignored.example.com',
    REDIS_TLS: 'true',
  } as NodeJS.ProcessEnv);

  expect(env.REDIS_URL).toBe('redis://explicit:6379');
});

test('REDIS_TLS=false is honoured rather than read as truthy', () => {
  const env = loadEnv({ REDIS_HOST: 'localhost', REDIS_TLS: 'false' } as NodeJS.ProcessEnv);
  expect(env.REDIS_URL).toBe('redis://localhost:6379');
});

test('falls back to the localhost default when no parts are present', () => {
  expect(loadEnv({}).REDIS_URL).toBe('redis://localhost:6379');
});

// #75: AUTH_MODE. The header-trusting fixture resolver must be structurally
// impossible in production — refused at boot, not at request time.
test('AUTH_MODE defaults to fixture in development', () => {
  expect(loadEnv({}).AUTH_MODE).toBe('fixture');
});

test('NODE_ENV=production with the fixture (defaulted) auth mode fails to boot', () => {
  expect(() => loadEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/AUTH_MODE|production/i);
});

test('NODE_ENV=production with AUTH_MODE=session boots', () => {
  // UPLOAD_URL_SECRET is required in production too (see below), so a
  // production env that only fixes AUTH_MODE is not a bootable one. AI_CHAT
  // joined that list with the chat runtime — see the block below. EMAIL_SENDER
  // and EMAIL_RATE_LIMIT joined it with S2, for the reason in that block.
  const env = loadEnv(PRODUCTION);
  expect(env.AUTH_MODE).toBe('session');
});

// Governance §9.1. Every other `demo` switch degrades something a user can SEE
// — no SMS arrives, no bill reaches Xero. This one degrades the JUDGEMENT while
// the screen looks identical: same cards, same confident wording, same
// Review → Approve path behind it. Hence a boot refusal rather than a safe
// default.
test('NODE_ENV=production with AI_CHAT=demo fails to boot', () => {
  expect(() =>
    loadEnv({ NODE_ENV: 'production', AUTH_MODE: 'session', UPLOAD_URL_SECRET: 's' } as NodeJS.ProcessEnv),
  ).toThrow(/AI_CHAT/);
});

test('AI_CHAT defaults to demo outside production, so a cold clone runs offline', () => {
  const env = loadEnv({});
  expect(env.AI_CHAT).toBe('demo');
  expect(env.BEDROCK_REGION).toBe('eu-west-2');
  expect(env.AI_DAILY_BUDGET_PENCE).toBe(500);
});

// A2 (and S1's gate, landing here first). `OTP_MODE=demo` accepts ONE literal
// six-digit code — the same one on every account, in every practice, on every
// portal session, written down in the source and in the seed. A universal second
// factor on a workspace holding other people's financial records is not a second
// factor, so it gets the AI_CHAT treatment: refused at boot, not defaulted away.
test('NODE_ENV=production with OTP_MODE=demo fails to boot', () => {
  expect(() => loadEnv({ ...PRODUCTION, OTP_MODE: 'demo' } as NodeJS.ProcessEnv)).toThrow(/OTP_MODE/);
});

test('OTP_MODE defaults to demo outside production, so a cold clone signs in offline', () => {
  expect(loadEnv({}).OTP_MODE).toBe('demo');
  expect(loadEnv({ ...PRODUCTION } as NodeJS.ProcessEnv).OTP_MODE).toBe('totp');
});

// #76: UPLOAD_URL_SECRET. Unlike the Meta secrets it is NOT optional in
// production. An empty one does fail closed, but at REQUEST time — the process
// boots, passes its health check, reports steady state, and 500s every upload,
// which reads as a broken lane rather than a missing variable.
test('UPLOAD_URL_SECRET is optional outside production', () => {
  expect(loadEnv({}).UPLOAD_URL_SECRET).toBe('');
});

test('NODE_ENV=production with an empty UPLOAD_URL_SECRET fails to boot', () => {
  expect(() => loadEnv({ NODE_ENV: 'production', AUTH_MODE: 'session' } as NodeJS.ProcessEnv))
    .toThrow(/UPLOAD_URL_SECRET/);
});

// #79 / review of #96: real Graph fetches must never land in the in-memory
// store — the row would outlive the bytes, which is loss dressed as success.
test('MEDIA_FETCH=graph with the fixture object store fails to boot', () => {
  expect(() =>
    loadEnv({ MEDIA_FETCH: 'graph', META_MEDIA_ACCESS_TOKEN: 't' } as NodeJS.ProcessEnv),
  ).toThrow(/OBJECT_STORE/i);
});

// #78 / review of #97: the SES prefix is real client mail and the poller
// DELETES it after processing — handing it to in-memory infrastructure and
// then deleting the source is destruction dressed as a clean drain.
test('EMAIL_SOURCE=s3 with a fixture queue or store fails to boot', () => {
  expect(() => loadEnv({ EMAIL_SOURCE: 's3' } as NodeJS.ProcessEnv)).toThrow(/EMAIL_SOURCE/);
  expect(() =>
    loadEnv({ EMAIL_SOURCE: 's3', INGEST_QUEUE: 'bullmq' } as NodeJS.ProcessEnv),
  ).toThrow(/EMAIL_SOURCE/);
});

test('EMAIL_SOURCE=s3 boots with the real queue and store; mailhog stays a fixture-friendly dev tool', () => {
  const staging = loadEnv({ EMAIL_SOURCE: 's3', INGEST_QUEUE: 'bullmq', OBJECT_STORE: 's3' } as NodeJS.ProcessEnv);
  expect(staging.EMAIL_SOURCE).toBe('s3');
  const laptop = loadEnv({ EMAIL_SOURCE: 'mailhog' } as NodeJS.ProcessEnv);
  expect(laptop.EMAIL_SOURCE).toBe('mailhog');
});

test('MEDIA_FETCH=graph with a real store boots', () => {
  const env = loadEnv({ MEDIA_FETCH: 'graph', META_MEDIA_ACCESS_TOKEN: 't', OBJECT_STORE: 's3' } as NodeJS.ProcessEnv);
  expect(env.MEDIA_FETCH).toBe('graph');
});

// ── Outbound email (S2) ──────────────────────────────────────────────────────
//
// The AI_CHAT treatment, and for the AI_CHAT reason. `EMAIL_SENDER=demo` sends
// into an in-memory outbox: every call succeeds, every call returns a message
// id, and no email exists. With SMS cut for Initial Delivery, email is the
// client's ONLY channel — so this is not a degraded feature, it is a client who
// is never contacted, in a workspace where nothing looks wrong.

test('EMAIL_SENDER defaults to demo outside production, so a cold clone runs offline', () => {
  const env = loadEnv({});
  expect(env.EMAIL_SENDER).toBe('demo');
  expect(env.EMAIL_RATE_LIMIT).toBe('memory');
  // ⚠ no-reply@, never doc@ — doc@ is the INBOUND intake address, and mail
  // arriving there is filed as a client document (email.tf, doc-to-s3).
  expect(env.EMAIL_FROM_ADDRESS).toBe('no-reply@neoting.neovogent.com');
  expect(env.EMAIL_FROM_ADDRESS).not.toContain('doc@');
  expect(env.SES_REGION).toBe('eu-west-2');
});

test('NODE_ENV=production with EMAIL_SENDER=demo fails to boot', () => {
  expect(() => loadEnv({ ...PRODUCTION, EMAIL_SENDER: 'demo' } as NodeJS.ProcessEnv)).toThrow(/EMAIL_SENDER/);
});

test('EMAIL_SENDER=ses without a configuration set fails to boot, in every environment', () => {
  // Without it a send silently opts out of bounce suppression — so we keep
  // mailing addresses that have already bounced, which is the fastest route to
  // the 5% suspension the reputation alarms watch for (observability.tf).
  expect(() => loadEnv({ EMAIL_SENDER: 'ses' } as NodeJS.ProcessEnv)).toThrow(/EMAIL_CONFIGURATION_SET/);
  expect(() => loadEnv({ EMAIL_SENDER: 'ses', EMAIL_CONFIGURATION_SET: 'c', EMAIL_FROM_ADDRESS: '' } as NodeJS.ProcessEnv)).toThrow(
    /EMAIL_FROM_ADDRESS/,
  );
});

test('a real sender behind a per-process rate limiter fails to boot in production', () => {
  // The API runs more than one ECS task, so an in-process ceiling of five is
  // five PER TASK — the numbers in email-rate-limit.ts become fiction, in the
  // direction that costs a sending reputation, and nothing about it is visible.
  expect(() => loadEnv({ ...PRODUCTION, EMAIL_RATE_LIMIT: 'memory' } as NodeJS.ProcessEnv)).toThrow(/EMAIL_RATE_LIMIT/);
});

test('the memory limiter is fine outside production, where there genuinely is one process', () => {
  const laptop = loadEnv({ EMAIL_SENDER: 'ses', EMAIL_CONFIGURATION_SET: 'c', EMAIL_RATE_LIMIT: 'memory' } as NodeJS.ProcessEnv);
  expect(laptop.EMAIL_RATE_LIMIT).toBe('memory');
});
