import { expect, test } from 'vitest';

import { loadEnv } from './env.js';

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
  // production env that only fixes AUTH_MODE is not a bootable one.
  const env = loadEnv({ NODE_ENV: 'production', AUTH_MODE: 'session', UPLOAD_URL_SECRET: 's' } as NodeJS.ProcessEnv);
  expect(env.AUTH_MODE).toBe('session');
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
