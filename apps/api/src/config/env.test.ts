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
  SESSION_SECRET: 's',
  PORTAL_LINK_SECRET: 's',
  PORTAL_SESSION_SECRET: 's',
  EXTRACTOR: 'bedrock',
  OTP_MODE: 'totp',
  IMAGE_NORMALISER: 'sharp',
  DOCUMENT_GUARD: 'qpdf',
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
  // joined that list with the chat runtime; S2 added EMAIL_SENDER and
  // EMAIL_RATE_LIMIT, and S1 added the three signing keys, the extractor, the
  // second factor and the two sanitisation implementations — which is why the
  // list is a fixture now.
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
  expect(env.AI_DAILY_BUDGET_PENCE).toBe(2500);
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

// ── S1 · the boot gates ─────────────────────────────────────────────────────
//
// Every gate below refuses at BOOT rather than at request time, and that is the
// whole point. A request-time failure ships a deploy that goes green, passes
// its health check and reports steady state, and then breaks a user journey
// nobody connects back to a variable until several deploys later. Each test
// here pins the variable NAME into the message, because the message is the only
// thing the operator reading a crash-looping task's logs actually gets.

test('the three signing keys stay optional outside production', () => {
  const env = loadEnv({});
  expect(env.SESSION_SECRET).toBe('');
  expect(env.PORTAL_LINK_SECRET).toBe('');
  expect(env.PORTAL_SESSION_SECRET).toBe('');
});

test.each(['SESSION_SECRET', 'PORTAL_LINK_SECRET', 'PORTAL_SESSION_SECRET'] as const)(
  'NODE_ENV=production with an empty %s fails to boot',
  (key) => {
    expect(() => loadEnv({ ...PRODUCTION, [key]: '' })).toThrow(new RegExp(key));
  },
);

// The extractor is the one demo switch that INVENTS rather than degrades:
// supplier, date, total, tax and VAT number from a hash of the filename, at
// 0.8 confidence, which resolveProcessedState reads as Ready.
test('EXTRACTOR defaults to demo outside production, so a cold clone still extracts', () => {
  expect(loadEnv({}).EXTRACTOR).toBe('demo');
});

test('NODE_ENV=production with EXTRACTOR=demo fails to boot', () => {
  expect(() => loadEnv({ ...PRODUCTION, EXTRACTOR: 'demo' })).toThrow(/EXTRACTOR/);
});

// OTP_MODE=demo is one fixed code on every account in every practice. `totp`
// is accepted by the schema before A2 implements the verifier, and that is
// deliberate: it fails every second factor CLOSED in the meantime.
test('OTP_MODE defaults to demo outside production and accepts the real verifier', () => {
  expect(loadEnv({}).OTP_MODE).toBe('demo');
  expect(loadEnv({ OTP_MODE: 'totp' } as NodeJS.ProcessEnv).OTP_MODE).toBe('totp');
});

test('NODE_ENV=production with OTP_MODE=demo fails to boot', () => {
  expect(() => loadEnv({ ...PRODUCTION, OTP_MODE: 'demo' })).toThrow(/OTP_MODE/);
});

test('OTP_MODE refuses a value that is neither demo nor totp', () => {
  expect(() => loadEnv({ OTP_MODE: 'twilio-verify' } as NodeJS.ProcessEnv)).toThrow(/OTP_MODE/);
});

// Both sanitisation fixtures are SILENT about the format they cannot handle —
// HEIC for the passthrough normaliser, a mid-file /Encrypt trailer for the
// grep guard. Silence is what makes them boot gates rather than warnings.
test('IMAGE_NORMALISER and DOCUMENT_GUARD default to fixture outside production', () => {
  const env = loadEnv({});
  expect(env.IMAGE_NORMALISER).toBe('fixture');
  expect(env.DOCUMENT_GUARD).toBe('fixture');
});

test('NODE_ENV=production with the passthrough image normaliser fails to boot', () => {
  expect(() => loadEnv({ ...PRODUCTION, IMAGE_NORMALISER: 'fixture' })).toThrow(/IMAGE_NORMALISER/);
});

test('NODE_ENV=production with the grep PDF guard fails to boot', () => {
  expect(() => loadEnv({ ...PRODUCTION, DOCUMENT_GUARD: 'fixture' })).toThrow(/DOCUMENT_GUARD/);
});

// The fixture above is only useful while it is true. Without this, a gate added
// later that PRODUCTION does not satisfy turns every negative test green for
// the wrong reason — they would all throw, but on the missing variable rather
// than on the one under test.
test('the PRODUCTION fixture really is a bootable production environment', () => {
  const env = loadEnv(PRODUCTION);
  expect(env.NODE_ENV).toBe('production');
  expect(env.EXTRACTOR).toBe('bedrock');
  expect(env.OTP_MODE).toBe('totp');
  expect(env.IMAGE_NORMALISER).toBe('sharp');
  expect(env.DOCUMENT_GUARD).toBe('qpdf');
});

// The ceiling is a HARD STOP, not a warning, so the day it bites is a day the
// practice's documents stop being read. £5/day was 250 documents at the
// £0.02/document guardrail — one month-end afternoon.
test('AI_DAILY_BUDGET_PENCE is £25/day, in integer pence', () => {
  const value = loadEnv({}).AI_DAILY_BUDGET_PENCE;
  expect(value).toBe(2500);
  expect(Number.isInteger(value)).toBe(true);
});

// ---- Billing (D48, launch stage S4) ---------------------------------------

test('BILLING defaults to the offline stand-in, and demo is NOT refused in production', () => {
  // Deliberate, and the reason is written out in env.ts: staging sets
  // NODE_ENV=production for build parity, so a gate here would crash-loop the
  // next staging deploy and take /healthz down before the secrets exist.
  expect(loadEnv({}).BILLING).toBe('demo');
  // S1's own PRODUCTION fixture, not a hand-built one: it is the environment
  // the gates above already agree boots, so a pass here means BILLING was not
  // gated rather than that something else threw first.
  expect(loadEnv(PRODUCTION).BILLING).toBe('demo');
});

test('BILLING=stripe refuses to boot without each of the four values it needs', () => {
  const base = { BILLING: 'stripe' } as NodeJS.ProcessEnv;
  // Each is unreachable-at-boot rather than 500-at-checkout: an empty value
  // fails closed at REQUEST time, which means the process boots green and then
  // breaks the one screen that turns a trial into a customer.
  expect(() => loadEnv(base)).toThrow(/STRIPE_SECRET_KEY/);
  expect(() => loadEnv({ ...base, STRIPE_SECRET_KEY: 'rk_test' } as NodeJS.ProcessEnv)).toThrow(/STRIPE_WEBHOOK_SECRET/);
  expect(() =>
    loadEnv({ ...base, STRIPE_SECRET_KEY: 'rk_test', STRIPE_WEBHOOK_SECRET: 'whsec' } as NodeJS.ProcessEnv),
  ).toThrow(/STRIPE_PRICE_ID/);
  expect(() =>
    loadEnv({ ...base, STRIPE_SECRET_KEY: 'rk_test', STRIPE_WEBHOOK_SECRET: 'whsec', STRIPE_PRICE_ID: 'price_1' } as NodeJS.ProcessEnv),
  ).toThrow(/BILLING_RETURN_ORIGINS/);
});

test('THE VAT GATE: STRIPE_TAX=rate with no rate id refuses to boot', () => {
  // Without it the net price is charged with no VAT line, which HMRC reads as
  // VAT-INCLUSIVE — so we absorb the VAT and receive 7.08 instead of 8.50.
  // There is no error and no alert; the only symptom is a smaller number on an
  // invoice nobody re-reads. Hence a boot refusal rather than a runtime check.
  expect(() =>
    loadEnv({
      BILLING: 'stripe',
      STRIPE_SECRET_KEY: 'rk_test',
      STRIPE_WEBHOOK_SECRET: 'whsec',
      STRIPE_PRICE_ID: 'price_1',
      BILLING_RETURN_ORIGINS: 'https://app.example',
    } as NodeJS.ProcessEnv),
  ).toThrow(/STRIPE_TAX_RATE_ID/);
});

test('BILLING=stripe boots with the full set, in either tax mode', () => {
  const base = {
    BILLING: 'stripe',
    STRIPE_SECRET_KEY: 'rk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec',
    STRIPE_PRICE_ID: 'price_1',
    BILLING_RETURN_ORIGINS: 'https://app.example',
  };
  expect(loadEnv({ ...base, STRIPE_TAX_RATE_ID: 'txr_1' } as NodeJS.ProcessEnv).STRIPE_TAX).toBe('rate');
  // `automatic` needs no rate id — Stripe Tax computes it — but see the runbook:
  // it collects nothing until there is an ACTIVE registration.
  expect(loadEnv({ ...base, STRIPE_TAX: 'automatic' } as NodeJS.ProcessEnv).STRIPE_TAX).toBe('automatic');
});

test('BILLING=demo ignores the Stripe values entirely, so a laptop needs none of them', () => {
  const env = loadEnv({ STRIPE_TAX: 'rate' } as NodeJS.ProcessEnv);
  expect(env.BILLING).toBe('demo');
  expect(env.STRIPE_SECRET_KEY).toBe('');
});
