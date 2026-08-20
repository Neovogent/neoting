import { expect, test } from 'vitest';

import { buildAppRoleSql } from './app-role-sql.js';

test('creates the role when absent and resets the password when present', () => {
  const sql = buildAppRoleSql('nt_app', 'secret');
  expect(sql).toContain("CREATE ROLE %I LOGIN PASSWORD %L");
  expect(sql).toContain("ALTER ROLE %I LOGIN PASSWORD %L");
});

test('no ALTER ROLE touches SUPERUSER or BYPASSRLS — neither granting nor clearing', () => {
  // Granting either makes RLS inert. CLEARING either is refused by RDS:
  //   ERROR: permission denied to alter role
  //   DETAIL: Only roles with the SUPERUSER attribute may change it.
  // The master holds rds_superuser, which is a role, not that attribute.
  // Measured against nt-staging, 20 Aug 2026.
  const offending = buildAppRoleSql('nt_app', 'secret')
    .split(/\r?\n/)
    .filter((line) => /ALTER ROLE/i.test(line) && /SUPERUSER|BYPASSRLS/i.test(line));
  expect(offending).toEqual([]);
});

test('tolerates a refused NOCREATEDB/NOCREATEROLE rather than aborting', () => {
  const sql = buildAppRoleSql('nt_app', 'secret');
  expect(sql).toContain('NOCREATEDB NOCREATEROLE');
  expect(sql).toContain('EXCEPTION WHEN insufficient_privilege');
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
