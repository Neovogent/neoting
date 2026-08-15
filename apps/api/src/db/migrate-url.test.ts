import { expect, test } from 'vitest';

import { resolveMigrationUrl } from './migrate-url.js';

const INJECTED = {
  DATABASE_HOST: 'nt-staging.abc.eu-west-2.rds.amazonaws.com',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'neoting',
  DB_MIGRATOR_USER: 'nt_migrator',
  DB_MIGRATOR_PASSWORD: 'generated',
} as NodeJS.ProcessEnv;

test('composes the URL from the parts the migrate task definition injects', () => {
  expect(resolveMigrationUrl(INJECTED)).toBe(
    'postgresql://nt_migrator:generated@nt-staging.abc.eu-west-2.rds.amazonaws.com:5432/neoting?sslmode=require',
  );
});

test('an explicit DATABASE_URL wins — the laptop and CI path', () => {
  const env = { ...INJECTED, DATABASE_URL: 'postgresql://localhost:5433/neoting' } as NodeJS.ProcessEnv;
  expect(resolveMigrationUrl(env)).toBe('postgresql://localhost:5433/neoting');
});

test('defaults the port when only it is absent', () => {
  const { DATABASE_PORT: _omitted, ...rest } = INJECTED as Record<string, string>;
  expect(resolveMigrationUrl(rest as NodeJS.ProcessEnv)).toContain(':5432/neoting');
});

test('names every missing part, and never the values', () => {
  expect(() => resolveMigrationUrl({ DATABASE_HOST: 'h', DB_MIGRATOR_PASSWORD: 'secret' } as NodeJS.ProcessEnv))
    .toThrow(/missing DATABASE_NAME, DB_MIGRATOR_USER/);

  try {
    resolveMigrationUrl({ DATABASE_HOST: 'h', DB_MIGRATOR_PASSWORD: 'secret' } as NodeJS.ProcessEnv);
  } catch (error) {
    expect((error as Error).message).not.toContain('secret');
  }
});

test('forces sslmode=require, which rds.force_ssl makes mandatory', () => {
  expect(resolveMigrationUrl(INJECTED)).toContain('sslmode=require');
});
