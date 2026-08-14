-- The application's database role — LOCAL DEVELOPMENT ONLY.
--
--   pnpm db:app-role      (after `docker compose up -d`, before `pnpm dev`)
--
-- Run as the owner/migration role. Idempotent, so re-running is harmless.
--
-- WHY THIS EXISTS AT ALL
--
-- Postgres bypasses row-level security for superusers and for the owner of a
-- table. If the application connects as `neoting`, every policy in rls.sql is
-- inert: the queries look scoped, the policies look correct, and a practice can
-- read another practice's documents. The role split is the thing that makes the
-- tenancy guarantee real, and it is invisible when it is missing — nothing
-- fails, everything is simply readable.
--
-- STAGING AND PRODUCTION DO NOT USE THIS FILE. There the role and its password
-- are created by Terraform (`infra/envs/*/db-app-role.tf`) with the password in
-- Secrets Manager. The password below is a local-only constant on a database
-- that listens on localhost and contains fabricated demo data; it is written
-- down here on purpose so a fresh clone reaches a working state inside the
-- 10-minute target, and it must never be reused anywhere else.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nt_app') THEN
    CREATE ROLE nt_app LOGIN PASSWORD 'nt_app_local';
  END IF;
END $$;

-- Explicitly NOT superuser, NOT BYPASSRLS. Stated rather than assumed, because
-- inheriting either one silently would undo everything above.
ALTER ROLE nt_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO nt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nt_app;

-- Future tables too — otherwise the next migration silently locks the
-- application out of whatever it adds, and the failure appears at runtime as a
-- permission error on a table nobody remembers creating.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nt_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nt_app;

-- nt_app must NOT own anything and must NOT be granted the owner role.
