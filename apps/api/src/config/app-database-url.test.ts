import { expect, test } from 'vitest';

import { resolveAppDatabaseUrl } from './app-database-url.js';

const INJECTED = {
  DATABASE_HOST: 'nt-staging.abc.eu-west-2.rds.amazonaws.com',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'neoting',
  DB_APP_USER: 'nt_app',
  DB_APP_PASSWORD: 'generated',
} as NodeJS.ProcessEnv;

test('composes the URL from the parts the task definition injects', () => {
  expect(resolveAppDatabaseUrl(INJECTED)).toBe(
    'postgresql://nt_app:generated@nt-staging.abc.eu-west-2.rds.amazonaws.com:5432/neoting?sslmode=require',
  );
});

test('an explicit DATABASE_URL wins — the laptop and CI path', () => {
  const env = { ...INJECTED, DATABASE_URL: 'postgresql://localhost:5433/neoting' } as NodeJS.ProcessEnv;
  expect(resolveAppDatabaseUrl(env)).toBe('postgresql://localhost:5433/neoting');
});

test('undefined when a part is missing — the caller then behaves as before', () => {
  const { DB_APP_PASSWORD: _omitted, ...rest } = INJECTED as Record<string, string>;
  expect(resolveAppDatabaseUrl(rest as NodeJS.ProcessEnv)).toBeUndefined();
  expect(resolveAppDatabaseUrl({} as NodeJS.ProcessEnv)).toBeUndefined();
});

test('the MIGRATOR credential alone never composes a URL — nt_app or nothing', () => {
  const migrator = {
    DATABASE_HOST: 'h',
    DATABASE_NAME: 'neoting',
    DB_MIGRATOR_USER: 'postgres',
    DB_MIGRATOR_PASSWORD: 'master',
  } as NodeJS.ProcessEnv;
  // The owner bypasses FORCE ROW LEVEL SECURITY and rds_superuser bypasses RLS
  // outright, so silently falling back to it would make tenancy decoration.
  expect(resolveAppDatabaseUrl(migrator)).toBeUndefined();
});

test('defaults the port, and forces sslmode=require (rds.force_ssl)', () => {
  const { DATABASE_PORT: _omitted, ...rest } = INJECTED as Record<string, string>;
  const url = resolveAppDatabaseUrl(rest as NodeJS.ProcessEnv)!;
  expect(url).toContain(':5432/neoting');
  expect(url).toContain('sslmode=require');
});

test('percent-encodes a password with punctuation', () => {
  const env = { ...INJECTED, DB_APP_PASSWORD: 'p@ss/word#1' } as NodeJS.ProcessEnv;
  expect(resolveAppDatabaseUrl(env)).toContain('p%40ss%2Fword%231');
});
