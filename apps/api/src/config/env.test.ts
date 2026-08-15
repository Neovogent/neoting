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
