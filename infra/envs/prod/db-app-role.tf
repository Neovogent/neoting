# ==========================================================================
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
# the table owner, so the belt is there. The braces matter more than usual,
# because FORCE does NOT constrain a superuser or any role holding BYPASSRLS —
# and on RDS the master user carries `rds_superuser`. Connecting the
# application with the master credential is a configuration away from turning
# every policy in prisma/ into decoration, and the failure is silent: queries
# return MORE rows, never fewer, so nothing breaks and nothing alerts.
#
# ⚠ A TENANCY LEAK DOES NOT THROW. In staging that sentence is a design note.
# In production it is the difference between one accounting practice seeing its
# own clients and seeing another practice's — which is the single worst thing
# this product can do, is immediately reportable to the ICO, and would end the
# pilot. This file, and the prisma/ work it depends on, is the control.
#
# STATE OF PLAY, verified 13 Aug 2026 and unchanged as of writing:
#   - rls.sql contains the CREATE ROLE nt_app block **as a comment**, not SQL
#   - the only thing that actually creates nt_app is prisma/sql/tenancy-check.sql
#     — the TEST script — with a hardcoded local password
#   - so nt_app exists on a developer laptop as a side effect of running
#     `pnpm db:tenancy-check`, and exists in no deployed database
#
# WHAT TERRAFORM CAN AND CANNOT DO
#
# Terraform can own the credential. It cannot run SQL against a database inside
# a private subnet, and it should not: creating roles is a migration concern
# and belongs with the schema, in prisma/, which is LAW (G7) and changes by
# contract.
#
# So this file provides the secret and the migration task consumes it
# (services.tf, `migration_secrets`). The split is deliberate — the password is
# generated here and never printed, and the migration receives it by injection
# rather than by anyone copying it.
# ==========================================================================

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
  # IAM users, that would put the credential the whole tenancy guarantee
  # depends on outside the boundary protecting everything else. The default is
  # the trap: the secret is encrypted either way, so nothing looks wrong.
  kms_key_id = aws_kms_key.secrets.arn

  # 30 days in prod (staging uses 7 because it is disposable by design, G1).
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret_version" "db_app_role" {
  secret_id = aws_secretsmanager_secret.db_app_role.id

  secret_string = jsonencode({
    username = "nt_app"
    password = random_password.db_app_role.result
    host     = module.data.db_address
    port     = module.data.db_port
    dbname   = module.data.db_name
  })

  # ⚠ THIS PASSWORD IS IN TERRAFORM STATE, AND IN PROD THAT IS A REAL EXPOSURE,
  # not a footnote. `random_password` writes its result to state in plaintext.
  # The state file lives in nt-tfstate-staging-252959251643, which ADR 0006
  # records as having NO bucket policy — so it does not carry the `role/nt-*`
  # explicit Deny every other Neoting bucket has, in an account with seven IAM
  # users. ADR 0006's own follow-up list has "add a bucket policy to the state
  # bucket" open.
  #
  # Two things follow, in order of urgency:
  #   1. That state-bucket policy must land before this environment holds real
  #      customer data. It is a small change and it is currently the weakest
  #      link in the chain protecting the production database credential.
  #   2. Rotating this password out of band is expected, and `ignore_changes`
  #      is what stops the next apply reverting it. After an out-of-band
  #      rotation, state holds a password that no longer works — which is the
  #      correct outcome and should not be "fixed" by re-applying.
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

# ==========================================================================
# ⚠ THIS IS HALF A FIX, AND THE OTHER HALF IS A HARD GATE ON PRODUCTION DATA.
#
# Until the migration actually creates the role, this secret describes a
# database user that does not exist, and the application has no choice but to
# connect as the master — i.e. as a superuser, i.e. with RLS bypassed. What has
# to land in prisma/ (a contract change, G7, approved before the PR opens):
#
#   1. Move the CREATE ROLE block in prisma/sql/rls.sql from a comment into
#      real SQL, taking the password from the environment rather than a
#      literal.
#   2. Make it idempotent — CREATE ROLE fails on re-run, so it needs the
#      IF NOT EXISTS guard tenancy-check.sql already demonstrates, plus an
#      ALTER ROLE ... PASSWORD so a rotated credential takes effect.
#   3. Assert in the CI tenancy suite (Governance §15.4) that the role the
#      application connects as is NOT the table owner, is NOT a superuser and
#      does NOT hold BYPASSRLS. tenancy-check.sql already asserts the last two;
#      the OWNERSHIP check is the missing one, and it is the one that catches
#      this specific mistake.
#   4. Point DATABASE_URL at this secret rather than the RDS master secret in
#      the task definition (services.tf). Anything that connects as master in
#      normal operation is a tenancy bug, not a convenience.
#
# NOTHING ABOVE IS OPTIONAL BEFORE THE FIRST REAL DOCUMENT. An environment
# where the application connects as a superuser does not have the tenancy
# property the Source of Truth promises, whatever the Prisma policies say.
# ==========================================================================
