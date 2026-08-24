/**
 * The DDL that makes row-level security real on a deployed database — the pure,
 * testable half of `app-role.ts`.
 *
 * Separated from the entrypoint for the same reason `migrate-url.ts` is: that
 * module spawns a process and calls `process.exit` at import time, so a test
 * importing it would run DDL against whatever database the environment names.
 */

/**
 * A role name reaches SQL as an identifier and cannot be a bind parameter, so it
 * is CONSTRAINED rather than escaped: anything outside this alphabet is a
 * configuration error, not user input to sanitise.
 */
const ROLE_NAME = /^[a-z_][a-z0-9_]*$/;

/** Single quotes doubled — the one escape a SQL string literal needs. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build the idempotent role script.
 *
 * ⚠ WHAT MUST STAY TRUE. `nt_app` must never hold SUPERUSER or BYPASSRLS.
 * Postgres exempts both from row-level security, and `FORCE ROW LEVEL SECURITY`
 * constrains a table OWNER but not a superuser — so either grant turns every
 * policy in `prisma/` into decoration, silently, because a tenancy leak returns
 * more rows rather than throwing.
 *
 * ⚠ THIS ASSERTS THE PROPERTY, IT DOES NOT COMMAND IT — and on RDS it cannot.
 * An earlier revision issued `ALTER ROLE … NOSUPERUSER NOBYPASSRLS`, which is
 * what `prisma/sql/app-role.sql` does on a laptop where the migration role is a
 * real superuser. Against RDS that fails outright:
 *
 *   ERROR: permission denied to alter role
 *   DETAIL: Only roles with the SUPERUSER attribute may change the SUPERUSER
 *           attribute.
 *
 * The RDS master user holds `rds_superuser`, which is a ROLE, not the SUPERUSER
 * attribute — it may not set or clear that attribute on anyone. Measured against
 * nt-staging on 20 Aug 2026.
 *
 * That turns out to be the better design and not merely the possible one. A
 * freshly created role has neither attribute, nothing here grants them, and the
 * final block reads `pg_roles` back and `RAISE EXCEPTION`s if either is set. A
 * command can be silently overridden later; an assertion catches that. The check
 * lives in SQL rather than in the caller because `prisma db execute` returns no
 * rows — a non-zero exit is the only channel it has.
 */
export function buildAppRoleSql(user: string, password: string): string {
  if (!ROLE_NAME.test(user)) {
    throw new Error(`refusing a role name that is not a plain identifier: ${user}`);
  }
  if (password === '') {
    throw new Error('refusing to set an empty password on the application role');
  }

  const name = literal(user);
  const secret = literal(password);

  return `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${name}) THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', ${name}, ${secret});
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', ${name}, ${secret});
  END IF;
END $$;

-- Hygiene, not the security control, and TOLERATED IF REFUSED: the same RDS
-- privilege boundary that blocks clearing the superuser attribute can block
-- these too, depending on the platform. They are belt to the assertion's braces, so a refusal must not
-- abort a script whose actual guarantee is checked at the end.
DO $$
BEGIN
  EXECUTE format('ALTER ROLE %I NOCREATEDB NOCREATEROLE', ${name});
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'could not set NOCREATEDB/NOCREATEROLE on % (platform-restricted); the assertion below still applies', ${name};
END $$;

GRANT USAGE ON SCHEMA public TO ${user};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${user};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${user};

-- Future tables and sequences too, or the next migration silently locks the
-- application out of whatever it adds and the failure surfaces at runtime as a
-- permission error on a table nobody remembers creating.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${user};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${user};

DO $$
DECLARE
  is_super boolean;
  is_bypass boolean;
BEGIN
  SELECT rolsuper, rolbypassrls INTO is_super, is_bypass FROM pg_roles WHERE rolname = ${name};
  IF is_super IS NULL THEN
    RAISE EXCEPTION 'role % does not exist after creation', ${name};
  END IF;
  IF is_super OR is_bypass THEN
    RAISE EXCEPTION 'role % holds SUPERUSER=% BYPASSRLS=% — row-level security would be inert',
      ${name}, is_super, is_bypass;
  END IF;
END $$;
`.trim();
}
