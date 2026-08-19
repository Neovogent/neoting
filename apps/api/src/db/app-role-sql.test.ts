import { expect, test } from 'vitest';

import { buildAppRoleSql } from './app-role-sql.js';

test('creates the role when absent and resets the password when present', () => {
  const sql = buildAppRoleSql('nt_app', 'secret');
  expect(sql).toContain("CREATE ROLE %I LOGIN PASSWORD %L");
  expect(sql).toContain("ALTER ROLE %I LOGIN PASSWORD %L");
});

test('strips the two grants that would make RLS inert, every run', () => {
  expect(buildAppRoleSql('nt_app', 'secret')).toContain('ALTER ROLE nt_app NOSUPERUSER NOBYPASSRLS');
});

test('grants on existing AND future tables — the next migration must not lock the app out', () => {
  const sql = buildAppRoleSql('nt_app', 'secret');
  expect(sql).toContain('ON ALL TABLES IN SCHEMA public TO nt_app');
  expect(sql).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nt_app');
});

test('verifies the flags in-database rather than trusting the ALTER', () => {
  const sql = buildAppRoleSql('nt_app', 'secret');
  // `prisma db execute` returns no rows, so a RAISE is the only failure channel.
  expect(sql).toContain('RAISE EXCEPTION');
  expect(sql).toContain('rolsuper, rolbypassrls');
});

test('escapes a password containing a single quote', () => {
  const sql = buildAppRoleSql('nt_app', "it's");
  expect(sql).toContain("'it''s'");
});

test('refuses a role name that is not a plain identifier', () => {
  expect(() => buildAppRoleSql('nt_app; DROP TABLE documents', 'secret')).toThrow(/plain identifier/);
  expect(() => buildAppRoleSql('"nt_app"', 'secret')).toThrow(/plain identifier/);
  expect(() => buildAppRoleSql('', 'secret')).toThrow(/plain identifier/);
});

test('refuses an empty password rather than creating a passwordless login', () => {
  expect(() => buildAppRoleSql('nt_app', '')).toThrow(/empty password/);
});
