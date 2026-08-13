# --------------------------------------------------------------------------
# The credential for the non-owning database role that RLS depends on.
#
# WHY THIS FILE EXISTS
#
# Governance §5.2 makes tenant isolation a database guarantee: every query runs
# through scopedDb(ctx) inside a transaction that sets the session GUCs, and
# Postgres row-level security enforces the practice → client hierarchy below
# the application. That guarantee has a precondition almost nobody states out
# loud: **the application must not connect as the role that owns the tables.**
#
# `prisma/sql/rls.sql` sets FORCE ROW LEVEL SECURITY, which extends policies to
# the table owner, so the belt is there. But the braces matter more than usual
# here, because FORCE does NOT constrain a superuser or any role holding
# BYPASSRLS — and on RDS the master user carries `rds_superuser`. Connecting the
# application with the master credential is therefore a configuration away from
# turning every policy in prisma/ into decoration, and the failure is silent:
# queries return MORE rows, never fewer, so nothing breaks and nothing alerts.
# A tenancy leak does not throw.
#
# STATE OF PLAY, verified 13 Aug 2026:
#   - rls.sql contains the CREATE ROLE nt_app block **as a comment**, not as SQL
#   - the only thing that actually creates nt_app is prisma/sql/tenancy-check.sql
#     — the TEST script — with a hardcoded local password
#   - so nt_app exists on a developer laptop purely as a side effect of running
#     `pnpm db:tenancy-check`, and does not exist in the staging database at all
#   - the only credential that exists in staging is the RDS-managed master secret
#
# WHAT TERRAFORM CAN AND CANNOT DO
#
# Terraform can own the credential. It cannot run SQL against a database inside
# a private subnet, and it should not: creating roles is a migration concern and
# belongs with the schema, in prisma/, which is LAW and changes by contract.
#
# So this file provides the secret, and the migration step consumes it. The
# split is deliberate — the password is generated here and never printed, and
# the migration task receives it by injection rather than by anyone copying it.
# --------------------------------------------------------------------------

resource "random_password" "db_app_role" {
  length  = 48
  special = false # keep it URL-safe: this ends up inside a libpq connection string
}

resource "aws_secretsmanager_secret" "db_app_role" {
  name        = "/neoting/${local.env}/db/app-role"
  description = "Non-owning Postgres role the application connects as (RLS depends on it)"

  # Without this, Secrets Manager silently uses the AWS-managed
  # `aws/secretsmanager` key — whose policy cannot be edited and therefore
  # carries none of the `role/nt-*` explicit Deny that D36's compensating
  # controls rest on. In an account shared with three other products and seven
  # IAM users, that puts the credential the whole tenancy guarantee depends on
  # outside the boundary protecting everything else. The default is the trap:
  # the secret is encrypted either way, so nothing looks wrong.
  kms_key_id = aws_kms_key.secrets.arn

  # Staging is disposable (G1) and holds synthetic data only (G2). A long
  # recovery window here just makes it awkward to recreate the environment.
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "db_app_role" {
  secret_id = aws_secretsmanager_secret.db_app_role.id

  secret_string = jsonencode({
    username = "nt_app"
    password = random_password.db_app_role.result
    host     = aws_db_instance.main.address
    port     = aws_db_instance.main.port
    dbname   = aws_db_instance.main.db_name
  })

  # The password lands in Terraform state, which is why the state bucket needs
  # the same explicit-Deny treatment as every other Neoting bucket (ADR 0006,
  # consequence 4). Rotating it out of band is expected and must not be
  # reverted by the next apply.
  lifecycle {
    ignore_changes = [secret_string]
  }
}

# Both roles need to read it: the execution role to inject it into the task at
# start, and the task role because the migration step reads it directly.
resource "aws_iam_role_policy" "read_db_app_role_secret" {
  for_each = toset([aws_iam_role.ecs_execution.name, aws_iam_role.app.name])

  name = "read-db-app-role-secret"
  role = each.value

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.db_app_role.arn
    }]
  })
}

# --------------------------------------------------------------------------
# ⚠ THIS IS HALF A FIX. The other half is a contract change in prisma/ (G7).
#
# Until the migration actually creates the role, this secret describes a
# database user that does not exist. What has to land there:
#
#   1. Move the CREATE ROLE block in prisma/sql/rls.sql from a comment into
#      real SQL, taking the password from the environment rather than a literal.
#   2. Make it idempotent — CREATE ROLE fails on re-run, so it needs the
#      IF NOT EXISTS guard that tenancy-check.sql already demonstrates, plus an
#      ALTER ROLE ... PASSWORD so a rotated credential actually takes effect.
#   3. Assert in the CI tenancy suite (Governance §15.4) that the role the
#      application connects as is NOT the table owner, is NOT a superuser and
#      does NOT hold BYPASSRLS. tenancy-check.sql already asserts the last two
#      (assertions at lines 88-91); the ownership check is the missing one, and
#      it is the one that catches this specific mistake.
#   4. Point DATABASE_URL at this secret rather than the RDS master secret, in
#      the task definition. Anything that connects as master in normal operation
#      is a tenancy bug, not a convenience.
#
# Recorded rather than done, because prisma/ is LAW and changes there go through
# a contract-change issue approved before the PR opens.
# --------------------------------------------------------------------------
