# --------------------------------------------------------------------------
# Self-hosted Unleash — feature flags and standing kill switches
# (Kickoff 3.9 · D23 · runbook Step 9 · Governance §8)
#
# WHAT THIS IS FOR. Governance §8 does not treat flags as a release convenience:
# it requires a standing kill switch per AI feature, per extraction vendor, per
# ledger adapter and per outbound channel (SMS, email, WhatsApp intake),
# "flippable without deploy". That is what makes this an operational control
# rather than developer tooling — the thing you reach for when a chase template
# starts texting the wrong people at 6pm on a Friday.
#
# Which is also why runbook Step 9 calls the admin UI a kill-switch console and
# says to treat it like one. Everything in the ACCESS banner further down
# follows from that sentence.
#
# THREE HONEST HEADLINES, so nobody has to reverse-engineer them from the HCL:
#
#   1. THE SERVICE SHIPS AT desired_count = 0. It *could* run today — unlike
#      api and workers, Unleash has a real published image — and it is still
#      off. The defence is in the DESIRED COUNT banner below; the short form is
#      Guideline §8.5 (`FLAGS_MODE=file` until Infra Week) plus ~$21/month
#      against a $140–170/month staging envelope to serve zero clients.
#
#   2. THERE IS NO INGRESS. No target group, no listener rule, no DNS record,
#      and the security group below has zero ingress rules. See the ACCESS
#      banner for why that is the cheapest *defensible* option and not just the
#      cheapest one.
#
#   3. THE DATABASE AND ROLE DO NOT EXIST YET. Terraform owns the credential;
#      it cannot own the `CREATE DATABASE`. The SQL is written out verbatim
#      below, and the same "how do we actually run SQL against a private RDS"
#      question that blocks db-app-role.tf blocks this too. Said here rather
#      than discovered on the day someone flips the count.
# --------------------------------------------------------------------------

locals {
  # Unleash's own default listen port. Deliberately not 3000: the app security
  # group's rules (network.tf) are pinned to 3000 and this must never be
  # confusable with an api task by a rule that matches on port alone.
  unleash_port = 4242

  # ⚠ THIS TAG IS A PLACEHOLDER, in exactly the way services.tf's
  # `image_tag = "bootstrap"` is — and for a sharper reason. Our own ECR repos
  # are IMMUTABLE (compute.tf), so a tag can never move under a running task.
  # A Docker Hub major-version tag is the opposite: it floats forward on every
  # upstream release, so the image that starts next week is not the image that
  # was reviewed this week.
  #
  # BEFORE desired_count GOES ABOVE 0:
  #   docker buildx imagetools inspect unleashorg/unleash-server:6
  # confirm the tag resolves and that a linux/arm64 manifest is present (see
  # the runtime_platform note on the task definition), then pin the digest here
  # as unleashorg/unleash-server@sha256:… — a digest is the only reference that
  # cannot change meaning.
  unleash_image = "unleashorg/unleash-server:6"

  # Sized from the shape of the workload, not copied from api. Unleash is a
  # small Node service whose steady state is serving a cached flag document to
  # a handful of SDK clients; the peak is the db-migrate run at boot. 0.25 vCPU
  # is enough to serve and not enough to migrate comfortably, so this takes the
  # next step up on CPU and the smallest memory that pairs with it.
  #
  # eu-west-2 ARM64 rates ($0.03725/vCPU-hr, $0.00409/GB-hr):
  #   0.5 vCPU + 1 GB ≈ $0.0227/hr ≈ $16.60/mo, plus ~$3.60/mo of public IPv4.
  # That number is the whole argument in the DESIRED COUNT banner.
  unleash_task_size = { cpu = 512, memory = 1024 }

  # The dedicated database and its owning role (runbook Step 9: "a dedicated
  # database on the existing RDS instance — separate DB, separate role, not the
  # app DB"). Neither exists yet; the SQL that creates them is below.
  unleash_db_name = "unleash"
  unleash_db_role = "nt_unleash"

  # The hostname the admin UI WOULD live on. It does not resolve — no Route 53
  # record is created in this file and that is deliberate (ACCESS banner).
  #
  # Unleash uses UNLEASH_URL only to build absolute links in the UI and in
  # password-reset mail, so a name that does not resolve produces a dead link,
  # not a broken server. Defining it now means standing up ingress at Infra
  # Week is a DNS record plus a listener rule, with no task-definition change.
  unleash_host = "flags.${local.domain}"
}

# --------------------------------------------------------------------------
# SUPPLY CHAIN — read this before the first `desired_count = 1`.
#
# `unleashorg/unleash-server` is pulled straight from Docker Hub by the ECS
# agent. Every other container in this environment comes from our own ECR
# (compute.tf), and the difference is not cosmetic:
#
#   * NO SCAN. aws_ecr_repository.this sets scan_on_push; a Docker Hub pull is
#     never scanned by anything we own. A CVE in this image is invisible to us.
#   * MUTABLE REFERENCE. See the local above. IMMUTABLE tags are an ECR
#     feature, not a Docker Hub one.
#   * NO CACHED COPY. If Docker Hub is down, rate-limits us, or the image is
#     withdrawn (it has happened to more popular images than this), the service
#     cannot start. Anonymous pulls are rate-limited per source IP; staging
#     tasks carry their own public IPs (no NAT — network.tf) so that is fine
#     today and is exactly the thing that bites the moment prod puts tasks
#     behind one NAT address.
#   * THE PULL IS UNAUTHENTICATED AND OVER THE PUBLIC INTERNET, from a task
#     that we otherwise give no AWS credentials to at all.
#
# THE FIX IS ECR PULL-THROUGH CACHE, and it is cheap enough that the only
# reason it is not here is that it is one more resource to own on a service
# that is switched off:
#
#   aws_ecr_pull_through_cache_rule with upstream_registry_url
#   registry-1.docker.io (Docker Hub upstream needs a Secrets Manager entry
#   holding a Docker Hub username + access token, named ecr-pullthroughcache/*
#   — ECR will not accept any other secret name), then pull
#   <acct>.dkr.ecr.eu-west-2.amazonaws.com/docker-hub/unleashorg/unleash-server
#   instead. Cost is ECR storage at $0.10/GB-month — this image is a few
#   hundred MB, so ~$0.03/month — and it buys scan-on-push, an immutable local
#   copy, and a pull that never leaves AWS.
#
# Do that in the same change that first sets desired_count above 0.
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# Security group.
#
# ZERO INGRESS RULES, and that is the entire access-control story for this
# service today (ACCESS banner below). A security group with no ingress rules
# denies all inbound — there is nothing to remove and nothing to get wrong.
#
# Egress is deliberately TIGHTER than aws_vpc_security_group_egress_rule
# .app_all, which opens everything to 0.0.0.0/0. The app tasks are our code
# calling AWS APIs we grant them; this is a third-party image we do not build,
# do not scan, and hand no AWS credentials to. Narrowing its egress is the one
# containment control available that costs nothing.
#
# ⚠ IF THE FIRST RUN HANGS ON IMAGE PULL OR AT BOOT, suspect these rules before
# suspecting the image. The symptom of a missing egress rule is a timeout, not
# a refusal, so it looks like a slow registry. Widening to a single
# `cidr_ipv4 = "0.0.0.0/0"` / `ip_protocol = "-1"` rule (copy app_all) is a
# one-line diagnostic; put the narrow rules back once it starts.
# --------------------------------------------------------------------------

resource "aws_security_group" "unleash" {
  name        = "nt-${local.env}-unleash"
  description = "Unleash feature-flag server. No inbound at all in staging."
  vpc_id      = module.network.vpc_id

  tags = {
    Name      = "nt-${local.env}-unleash"
    Component = "unleash"
  }
}

# Docker Hub, Secrets Manager and CloudWatch Logs are all HTTPS. There is no
# NAT in staging (network.tf), so this leaves via the task's own public IP.
resource "aws_vpc_security_group_egress_rule" "unleash_https" {
  security_group_id = aws_security_group.unleash.id
  description       = "HTTPS out: Docker Hub image pull, Secrets Manager, CloudWatch Logs"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

# The VPC resolver sits at the VPC CIDR base + 2 and IS subject to security
# group egress rules — the classic way a "tightened" egress policy breaks every
# hostname lookup in the task while every other rule looks correct. UDP first
# (the normal path), TCP for responses that exceed 512 bytes.
resource "aws_vpc_security_group_egress_rule" "unleash_dns_udp" {
  security_group_id = aws_security_group.unleash.id
  description       = "DNS to the VPC resolver"
  cidr_ipv4         = local.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "udp"
}

resource "aws_vpc_security_group_egress_rule" "unleash_dns_tcp" {
  security_group_id = aws_security_group.unleash.id
  description       = "DNS to the VPC resolver (truncated responses)"
  cidr_ipv4         = local.vpc_cidr
  from_port         = 53
  to_port           = 53
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "unleash_to_data" {
  security_group_id            = aws_security_group.unleash.id
  description                  = "PostgreSQL to the data tier"
  referenced_security_group_id = module.network.data_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# The matching half, written the same way as
# module.network's postgres_from_app rule: a reference to a security group ID,
# never a CIDR, so the chain stays explicit. This rule attaches to the EXISTING
# data security group but is created here — the shared network module is NOT
# edited to add a workload, and deleting this file removes the grant with it.
# That is the whole reason module.network exports data_security_group_id.
resource "aws_vpc_security_group_ingress_rule" "postgres_from_unleash" {
  security_group_id            = module.network.data_security_group_id
  description                  = "PostgreSQL from the Unleash service"
  referenced_security_group_id = aws_security_group.unleash.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# --------------------------------------------------------------------------
# Log group.
#
# Created here rather than auto-created by ECS: auto-created groups have
# infinite retention, which is both a cost leak and a compliance problem.
# 30 days matches every other application log group (Governance §12.2).
#
# NOT added to compute.tf's `local.services` map, on purpose. That map drives
# the ECR repositories, the api/web/workers log groups AND observability.tf's
# `log.errors.<service>` metric filters, which parse `{ $.level = "error" }` —
# the structured-JSON shape Governance §13.1 mandates for OUR code. Unleash
# logs in its own format, so a filter over this group would sit permanently at
# zero and read as "no errors" rather than "not parsed".
# --------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "unleash" {
  name              = "/nt/${local.env}/unleash"
  retention_in_days = 30 # Governance §12.2

  tags = { Component = "unleash" }
}

# ==========================================================================
# THE DATABASE CREDENTIAL, AND THE SQL TERRAFORM CANNOT RUN.
#
# This is the same shape as db-app-role.tf and for the same reason: Terraform
# can own a credential, but it cannot create a role or a database inside RDS.
# Doing so needs the `postgresql` provider, which needs a TCP path from
# wherever `terraform apply` runs to port 5432 — and the database sits in the
# data subnets, which have no route to the internet in either direction
# (network.tf) and a security group that admits only named security groups.
# Making that provider work would mean punching a hole in exactly the control
# that makes the data tier a data tier. So the split is deliberate, not a
# shortcut: Terraform generates the password and publishes it, and a one-off
# SQL step consumes it.
#
# THE SQL. Run ONCE, as the RDS master user (nt_migrator, whose password is in
# the RDS-managed secret — data.tf), connected to the `postgres` database.
# Take the password from /neoting/<env>/unleash/database, key `password`, and
# pass it as a psql variable so it never lands in shell history:
#
#   psql "host=… user=nt_migrator dbname=postgres sslmode=require" \
#        -v unleash_password="$(aws secretsmanager get-secret-value \
#             --secret-id /neoting/staging/unleash/database \
#             --query SecretString --output text | jq -r .password)"
#
#   -- 1. The role. LOGIN and nothing else: no CREATEDB, no CREATEROLE, no
#   --    SUPERUSER, no BYPASSRLS. It owns one database and can reach nothing
#   --    else on this instance once step 4 has run.
#   CREATE ROLE nt_unleash LOGIN PASSWORD :'unleash_password';
#
#   -- 2. ⚠ NOT OPTIONAL, AND THE ERROR IT PREVENTS LOOKS LIKE AN AWS BUG.
#   --    The RDS "master" user is not a Postgres superuser — it is a member of
#   --    rds_superuser. `CREATE DATABASE … OWNER x` requires the executing role
#   --    to be a member of x, so without this line step 3 fails with
#   --    `ERROR: must be member of role "nt_unleash"`, which reads as a missing
#   --    AWS permission and is not one.
#   GRANT nt_unleash TO CURRENT_USER;
#
#   -- 3. The database. SEPARATE from `neoting` — this IS runbook Step 9's
#   --    requirement, not a tidiness preference. Postgres has no cross-database
#   --    query path without dblink/postgres_fdw, so a separate database is a
#   --    real boundary: a compromised Unleash cannot read a single row of
#   --    client data, and it never gets near the RLS policies in prisma/.
#   CREATE DATABASE unleash OWNER nt_unleash ENCODING 'UTF8' TEMPLATE template0;
#
#   -- 4. ⚠ THE BOUNDARY IS NOT REAL UNTIL THIS RUNS. Postgres grants CONNECT on
#   --    every new database to PUBLIC, and every role is a member of PUBLIC. So
#   --    by default nt_unleash can open a session on the APPLICATION database.
#   --    It would land there with no table privileges, but "no privileges" is a
#   --    much thinner wall than "cannot connect", and it is one GRANT away from
#   --    being nothing at all.
#   REVOKE CONNECT ON DATABASE unleash FROM PUBLIC;
#   GRANT  CONNECT ON DATABASE unleash TO nt_unleash;
#
#   -- 5. Schema privileges. On Postgres 15+ (this is 16.14 — data.tf) the
#   --    `public` schema is owned by pg_database_owner and PUBLIC no longer has
#   --    CREATE on it, so the database owner already has exactly what Unleash's
#   --    boot migrations need. Verify rather than assume:
#   --      \c unleash
#   --      \dn+ public          -- owner should resolve to nt_unleash
#
#   -- 6. Extensions, IF the boot log asks for them. Unleash's migrations have
#   --    historically run `CREATE EXTENSION IF NOT EXISTS pgcrypto`. A plain
#   --    role cannot create an extension on RDS; only a member of rds_superuser
#   --    can. Symptom: the task starts, migrates for a few seconds, then exits
#   --    with `permission denied to create extension "pgcrypto"`. Fix, once, as
#   --    the master user:
#   --      \c unleash
#   --      CREATE EXTENSION IF NOT EXISTS pgcrypto;
#
# THE OTHER HALF OF STEP 4 IS A CONTRACT CHANGE (G7) AND IS NOT DONE HERE.
# The application database has the identical PUBLIC-can-CONNECT default, so
# `REVOKE CONNECT ON DATABASE neoting FROM PUBLIC; GRANT CONNECT ON DATABASE
# neoting TO nt_app, nt_migrator;` belongs in prisma/, which is LAW and changes
# by contract-change issue. Recorded, not done.
#
# HOW THIS ACTUALLY GETS RUN, honestly: it does not, yet. There is no bastion
# and no SSH (runbook §6.1), the database has no route off the VPC, and no
# migration task exists. This is the SAME blocker db-app-role.tf documents for
# the nt_app role, and it has one answer for both: a one-off
# `aws ecs run-task` on the app security group with the migrator credential
# injected. When that task lands, this SQL rides along with it. Until then the
# secret below describes a role and a database that do not exist — which is
# harmless precisely because the service is at desired_count = 0.
# ==========================================================================

resource "random_password" "unleash_db" {
  length  = 48
  special = false # keep it URL-safe: this ends up inside a libpq connection string
}

resource "aws_secretsmanager_secret" "unleash_database" {
  name        = "/neoting/${local.env}/unleash/database"
  description = "Postgres credential for the dedicated Unleash database (runbook Step 9)"
  kms_key_id  = aws_kms_key.secrets.arn

  # 7 days, matching the application secrets. Staging is disposable (G1) and a
  # deleted secret RESERVES ITS NAME for the whole recovery window, so anything
  # longer turns "rebuild staging this week" into a name collision.
  recovery_window_in_days = 7

  tags = {
    DataClass = "credential"
    Component = "unleash"
    Rotation  = "manual-365d" # same honest caveat as secrets.tf's ROTATION banner
  }
}

resource "aws_secretsmanager_secret_version" "unleash_database" {
  secret_id = aws_secretsmanager_secret.unleash_database.id

  # Discrete fields AND a ready-made URL. The fields are what a human pastes
  # into psql when running the SQL above; the URL is what the container needs,
  # because the ECS `secrets` block can only inject a whole JSON value and
  # cannot assemble one from parts.
  secret_string = jsonencode({
    username = local.unleash_db_role
    password = random_password.unleash_db.result
    host     = module.data.db_address
    port     = module.data.db_port
    dbname   = local.unleash_db_name

    # ⚠ sslmode=require, not verify-full, and the gap is deliberate rather than
    # overlooked. data.tf sets rds.force_ssl = 1, so the connection IS
    # encrypted — `require` guarantees that much. What it does not do is verify
    # that the server presenting the certificate is our RDS instance, which
    # needs the RDS regional CA bundle inside the container. Baking a CA bundle
    # into a third-party image means building our own image, which is Infra
    # Week work. Inside a VPC where the only route to 5432 is a
    # security-group-gated private subnet this is a defensible staging trade;
    # it is NOT a defensible prod one, and prod must not inherit this line.
    database_url = "postgres://${local.unleash_db_role}:${urlencode(random_password.unleash_db.result)}@${module.data.db_address}:${module.data.db_port}/${local.unleash_db_name}?sslmode=require"
  })

  # The password reaches Terraform state, which is why the state bucket carries
  # the same explicit-Deny treatment as every other Neoting bucket (ADR 0006).
  # Rotating out of band — change it in Postgres with ALTER ROLE, then
  # put-secret-value — is expected and must never be reverted by the next
  # apply, which is what this block guarantees.
  lifecycle {
    ignore_changes = [secret_string]
  }
}

# --------------------------------------------------------------------------
# API tokens.
#
# A SECOND secret rather than three more keys in the one above, and the $0.40
# is bought deliberately. secrets.tf groups by rotation unit, and these two are
# different units with different readers:
#
#   * the database credential is read by a human running SQL and by the Unleash
#     container. The api and workers tasks must NEVER be able to read it.
#   * the client SDK token is read by the api and workers tasks — a grant that
#     does not exist yet and that lands the day FLAGS_MODE flips.
#
# One secret would mean granting the application tasks read access to a
# database credential in order to give them a flag token. Two secrets means the
# grants can be shaped like the actual need. That is worth $0.40/month.
#
# WHY GENERATE THEM AT ALL WHEN NOTHING CONSUMES THEM: Guideline §8.5's G8 test
# is that flipping from the local flags file to the server "changes config
# only". A token that has to be minted by hand in an admin UI first is not a
# config change — it is a manual step in the middle of the flip, at the moment
# the flip is under time pressure. INIT_ADMIN_API_TOKENS / INIT_CLIENT_API_TOKENS
# are Unleash's own answer to this: it creates the tokens at first boot from
# these values, so the token exists before anyone needs it.
#
# Token grammar is Unleash's, not ours: `<project>:<environment>.<secret>`,
# with `*:*` meaning "all projects, all environments" — which is what makes the
# admin token an admin token. random_id gives a hex string, which is the shape
# Unleash's own docs use; random_password's mixed alphabet is fine for a
# password but the hex form is what every example and every support thread
# assumes.
#
# `default:development` for the client token because Unleash ships `development`
# and `production` environments out of the box and staging is not production
# (Guideline §8.4 keeps sandbox-grade everything in staging). A production flag
# state must never be readable with a token minted here.
# --------------------------------------------------------------------------

resource "random_id" "unleash_admin_token" {
  byte_length = 32 # → 64 hex characters
}

resource "random_id" "unleash_client_token" {
  byte_length = 32
}

# For UNLEASH_DEFAULT_ADMIN_PASSWORD — see the ⚠ DEFAULT ADMIN note in the
# ACCESS banner. Generated now so that closing that hole is a config change.
resource "random_password" "unleash_admin_password" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "unleash_tokens" {
  name        = "/neoting/${local.env}/unleash/tokens"
  description = "Unleash init admin token, client SDK token and admin password (runbook Step 9)"
  kms_key_id  = aws_kms_key.secrets.arn

  recovery_window_in_days = 7

  tags = {
    DataClass = "credential"
    Component = "unleash"
    Rotation  = "manual-365d"
  }
}

resource "aws_secretsmanager_secret_version" "unleash_tokens" {
  secret_id = aws_secretsmanager_secret.unleash_tokens.id

  secret_string = jsonencode({
    # INIT_ADMIN_API_TOKENS. Full control of every project and environment —
    # i.e. it can flip every kill switch Governance §8 requires. Treat a leak
    # of this as "someone can turn off our SMS chase and turn on every AI
    # feature", not as a config value.
    admin_token = "*:*.${random_id.unleash_admin_token.hex}"

    # INIT_CLIENT_API_TOKENS. Read-only, scoped to one project + environment.
    # This is the one the application's flag wrapper eventually reads.
    client_token = "default:development.${random_id.unleash_client_token.hex}"

    # ⚠ NOT WIRED INTO THE TASK DEFINITION, deliberately. Unleash's variable for
    # seeding the first admin password has changed name across major versions,
    # and shipping a guess that silently does nothing would be worse than
    # shipping nothing — it would read as "the default password is handled".
    # Verify the name against the version pinned in local.unleash_image, then
    # add ONE `secrets` entry pointing at this key in the same change that adds
    # any ingress. Until there is ingress, nothing can reach the login form.
    admin_password = random_password.unleash_admin_password.result
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# --------------------------------------------------------------------------
# The read grant.
#
# A THIRD inline policy on the execution role. Inline policies union, so the
# effect is identical to editing compute.tf's or secrets.tf's, and keeping it
# here means this whole file can be deleted without leaving an orphaned grant
# to a secret ARN that no longer exists.
#
# The kms:Decrypt statement is intentionally REDUNDANT with secrets.tf's
# `DecryptApplicationSecrets`. secrets.tf tells future readers not to copy that
# policy around, and the advice is right for a fourth vendor secret — but this
# file is a separable unit that a reviewer should be able to delete in one go,
# and a silent dependency on another lane's statement surviving a refactor is
# the kind of coupling that fails at task start with
# ResourceInitializationError and no clue as to why. Same ViaService condition,
# so the grant is still shaped like its one job.
#
# EXECUTION ROLE ONLY. The task role is discussed on the task definition below:
# there isn't one.
# --------------------------------------------------------------------------
resource "aws_iam_role_policy" "ecs_execution_unleash_secrets" {
  name = "read-unleash-secrets"
  role = aws_iam_role.ecs_execution.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadUnleashSecrets"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        # Resolved ARNs, never a "/neoting/staging/unleash/*" wildcard: Secrets
        # Manager appends a random six-character suffix to every secret ARN, so
        # a hand-written ARN cannot work and a wildcard wide enough to cover the
        # suffix is also wide enough to cover every future secret on the path.
        Resource = [
          aws_secretsmanager_secret.unleash_database.arn,
          aws_secretsmanager_secret.unleash_tokens.arn,
        ]
      },
      {
        Sid      = "DecryptUnleashSecrets"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.secrets.arn
        Condition = {
          StringEquals = { "kms:ViaService" = "secretsmanager.${local.region}.amazonaws.com" }
        }
      }
    ]
  })
}

# --------------------------------------------------------------------------
# Task definition.
#
# ⚠ NO TASK ROLE. `task_role_arn` is omitted, not left blank by accident, and
# it is the strongest control in this file.
#
# The task role is the one credential that IS reachable from inside a
# container: the ECS agent publishes it on the task metadata endpoint at
# 169.254.170.2, so any code in the container — ours or a dependency's — can
# fetch it. Giving a third-party image we neither build nor scan a role that
# can call AWS at all buys nothing, because Unleash needs nothing from AWS: it
# needs Postgres and a port. So it gets no AWS identity whatsoever, and a
# compromised Unleash has no AWS API surface to attack from.
#
# The EXECUTION role (nt-<env>-ecs-execution) is still used, and that is not
# the same exposure: those credentials are held by the ECS agent outside the
# container to pull the image, write logs and resolve the `secrets` block. They
# are never present on the metadata endpoint. What the container receives is
# the resolved environment variables, nothing more.
#
# ⚠ IF UNLEASH EVER NEEDS AWS (SES for password-reset mail is the realistic
# one), THE NEW ROLE MUST BE NAMED nt-*. Every bucket policy and every KMS key
# policy in this account guards on
# `arn:aws:iam::252959251643:role/nt-*` (policies/kms-*.json.tftpl,
# policies/bucket*.json.tftpl). A role named anything else is not merely
# unprivileged — it is explicitly denied, silently, with an error that names
# the resource and not the naming rule.
#
# ARM64, matching api and workers and the Graviton data tier. ⚠ The price of
# that: unlike our own images, we cannot fix this one if it lacks an arm64
# manifest. Verify before flipping the count (see local.unleash_image); the
# failure is an instant "exec format error" and nothing else. If the manifest
# is amd64-only, change cpu_architecture to X86_64 here — the cost of that flip
# is roughly $3/month.
# --------------------------------------------------------------------------
resource "aws_ecs_task_definition" "unleash" {
  family                   = "nt-${local.env}-unleash"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.unleash_task_size.cpu
  memory                   = local.unleash_task_size.memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  # task_role_arn deliberately omitted — see the banner above.

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "unleash"
      image     = local.unleash_image
      essential = true

      portMappings = [
        {
          containerPort = local.unleash_port
          protocol      = "tcp"
        }
      ]

      # Non-secret runtime coordinates only. Anything carrying a credential is
      # in `secrets` below — Governance §11.5 forbids plaintext credentials in
      # a task definition, and a task definition is readable by anyone with
      # ecs:DescribeTaskDefinition, which is a much wider set of principals
      # than can read the secret itself.
      environment = [
        { name = "NODE_ENV", value = "production" },

        # Storage is UTC, full stop (CLAUDE.md invariant). Flag audit records
        # are timestamps someone will one day correlate with an incident.
        { name = "TZ", value = "UTC" },

        { name = "PORT", value = tostring(local.unleash_port) },

        # Does not resolve today, on purpose — see local.unleash_host. Used
        # only to build links, so the cost of it being wrong is a dead link.
        { name = "UNLEASH_URL", value = "https://${local.unleash_host}" },

        { name = "DATABASE_SCHEMA", value = "public" },

        # ⚠ TLS TO RDS, AND THE TWO ERROR STRINGS THAT TELL YOU WHICH LEVER TO
        # PULL. data.tf sets rds.force_ssl = 1, so a plaintext connection is
        # refused outright. Two independent things ask for TLS here: the
        # `?sslmode=require` on the injected DATABASE_URL, and this variable,
        # which Unleash passes through to node-postgres as its `ssl` option.
        # Belt and braces, because which of the two is honoured has varied
        # across node-postgres and Unleash versions.
        #   "no pg_hba.conf entry … SSL off"        → TLS is not being requested
        #                                             at all; neither lever took.
        #   "self signed certificate in chain"      → TLS is on and verification
        #                                             is the problem; that is
        #                                             what rejectUnauthorized
        #                                             below turns off, and see
        #                                             the secret's verify-full
        #                                             note for why.
        # If the pinned version rejects this variable's format, delete it and
        # rely on the URL — an unparsed value here is ignored, not fatal.
        { name = "DATABASE_SSL", value = jsonencode({ rejectUnauthorized = false }) },

        # No phoning home. Unleash checks version.unleash.run for updates by
        # default, which sends our instance identifier and version to a third
        # party on a schedule and opens an egress path we would otherwise not
        # need. We patch by changing local.unleash_image, not by being told to.
        { name = "CHECK_VERSION", value = "false" },

        # Appendix B.2 names CloudWatch ingest the sleeper line item and warns
        # that debug-level structured logs can out-cost RDS. Info in staging.
        { name = "LOG_LEVEL", value = "info" },
      ]

      # Injected by the ECS agent at task start (Gov §11.5, runbook §6.4). The
      # `:key::` suffix selects one field out of the secret's JSON; the format
      # is <arn>:<json-key>:<version-stage>:<version-id> and the trailing
      # colons are required even when empty.
      #
      # ⚠ Every ARN here must also appear in
      # aws_iam_role_policy.ecs_execution_unleash_secrets above. A `secrets`
      # entry without its grant fails the task at start with
      # ResourceInitializationError, which reads like a broken image and is not.
      secrets = [
        { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.unleash_database.arn}:database_url::" },
        { name = "INIT_ADMIN_API_TOKENS", valueFrom = "${aws_secretsmanager_secret.unleash_tokens.arn}:admin_token::" },
        { name = "INIT_CLIENT_API_TOKENS", valueFrom = "${aws_secretsmanager_secret.unleash_tokens.arn}:client_token::" },
      ]

      # There is no load balancer probing this container (ACCESS banner), so a
      # container-level check is the only thing that can tell a wedged Unleash
      # from a healthy one — the same gap services.tf leaves open as a TODO on
      # workers.
      #
      # Written against `node`, not curl or wget, on purpose: node is the one
      # binary this image is guaranteed to contain, and a health check that
      # depends on a tool that may not be installed reports "unhealthy" for a
      # reason that has nothing to do with health.
      #
      # startPeriod 90 because the first boot runs db-migrate against an empty
      # database. Failures during the start period do not count against
      # `retries`, which is what stops the very first launch from being killed
      # mid-migration and re-launched into a half-migrated schema.
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"require('http').get('http://127.0.0.1:${local.unleash_port}/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 90
      }

      # PID 1 in a container reaps nothing.
      linuxParameters = {
        initProcessEnabled = true
      }

      stopTimeout = 30

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.unleash.name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = { Component = "unleash" }
}

# ==========================================================================
# DESIRED COUNT — the decision this file is most likely to be argued with.
#
# IT SHIPS AT 0, AND UNLIKE api AND workers THAT IS NOT BECAUSE IT CANNOT RUN.
# `unleashorg/unleash-server` is a real published image; there is no ECR
# placeholder tag here and no missing application code. Set this to 1, run the
# SQL above, and Unleash comes up. The reason it is off is cost against value,
# and the value is currently zero:
#
#   VALUE TODAY. `.env.example` ships FLAGS_MODE=file and Guideline §8.5 puts
#   the Unleash server on the deferred list explicitly — "use a local flags
#   file with the same interface". There is no application code in this
#   repository yet, so there is not one SDK client to serve. A running Unleash
#   would hold flags that nothing reads, in an admin UI nobody can reach
#   (ACCESS banner), for a product that is not deployed.
#
#   COST OF RUNNING IT ANYWAY. ~$16.60/month of Fargate + ~$3.60/month of
#   public IPv4 + ~$0.50/month of log ingest ≈ $21/month, against Appendix B.2's
#   $140–170/month staging envelope. That is ~14% of staging spend, every
#   month, for a service with no consumers — on an $8,000 six-month pot (D35)
#   whose binding constraint is months 4–6, not the sprint.
#
#   WHY IT IS STILL WORTH BUILDING NOW. Guideline §8.5's G8 test is that
#   flipping to the server "changes config only". That test is only meetable if
#   the infrastructure, the credential, the tokens and the grants all exist
#   before the flip. This file makes the flip: run the SQL once, set this to 1,
#   change FLAGS_MODE. No Terraform authoring under time pressure, no token
#   minted by hand, no "who owns the Unleash database" conversation at the
#   moment someone needs a kill switch.
#
# WHEN TO TURN IT ON: at Infra Week, in the same change that adds ingress
# (ACCESS banner), pins the image digest, and adds the alarms (COST banner).
# Not before — an Unleash nobody can administer is not a kill-switch console.
#
# ⚠ CONSEQUENCE OF ignore_changes BELOW, stated plainly: once anyone runs
# `aws ecs update-service --desired-count 1`, THE 0 IN THIS FILE STOPS BEING
# TRUE and Terraform will not correct it. That is the deliberate trade
# services.tf makes for api and workers — a `terraform apply` from a laptop
# must never silently scale staging down — and it applies with more force to a
# kill-switch console, which is the last thing that should go dark because
# someone ran a plan. The price is that this file is not the authority on
# whether Unleash is costing money. Cost Explorer filtered on
# `Component=unleash` is; that tag is on every resource here for exactly that
# reason (Gov §13.5).
# ==========================================================================

resource "aws_ecs_service" "unleash" {
  name            = "nt-${local.env}-unleash"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.unleash.arn
  desired_count   = 0

  # ON-DEMAND, NEVER SPOT, and the reasoning is different from the api's.
  # Appendix B.2 permits Spot in staging for workers because a reclaimed worker
  # costs a re-delivered BullMQ job. A reclaimed FLAG SERVER costs something
  # else: Unleash SDK clients hold a cached flag document and keep serving it
  # when the server is unreachable, which is correct behaviour and exactly what
  # makes it dangerous here — a kill switch you just flipped would appear to
  # have been flipped while the clients carried on with the stale answer. A
  # two-minute Spot warning is not a risk worth $11/month.
  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }

  # Gov §14.9/§16: a deployment whose task cannot pass its health check is
  # rolled back to the last good revision by ECS, without a human.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # 0/100 — replace in place, the same shape as workers and for a sharper
  # reason. Unleash runs its schema migrations at startup. Running a new and an
  # old task concurrently means two processes racing on those migrations
  # against one database, and there is no availability here worth protecting:
  # SDK clients ride out a restart on their cached flag document, which is the
  # same property that rules out Spot above.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  network_configuration {
    subnets         = module.network.public_subnet_ids
    security_groups = [aws_security_group.unleash.id]

    # There is NO NAT gateway in staging by design (network.tf, Appendix B.3):
    # a public IP is the only way this task reaches Docker Hub, Secrets Manager
    # and CloudWatch Logs at all. Nothing can reach IN — the security group
    # above has zero ingress rules, which is a stronger statement than the app
    # tier's "only from the ALB".
    assign_public_ip = true
  }

  # Per-service cost attribution in Cost Explorer (Gov §13.5) rather than a
  # guess. Given the ignore_changes caveat above, this is the tag that answers
  # "is Unleash running and what is it costing".
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  # ECS Exec stays OFF, consistent with api and workers: there is no task role
  # at all here, so there is nothing to attach ssmmessages:* to, and enabling
  # it would produce a task running with a permanently STOPPED managed agent —
  # a broken debugging tool being worse than an absent one.
  enable_execute_command = false

  # FARGATE must be associated with the cluster before a service may name it,
  # and that association is invisible to Terraform's graph through `cluster`
  # alone: creating the service first fails with "capacity provider not
  # associated".
  depends_on = [aws_ecs_cluster_capacity_providers.main]

  tags = { Component = "unleash" }

  lifecycle {
    # desired_count only. task_definition is deliberately NOT ignored, which is
    # the opposite of api and workers — and the difference is who owns the
    # revision. CI registers a new revision for our services on every deploy,
    # so Terraform must keep its hands off. Nothing deploys Unleash: the
    # revision changes when this file changes, so Terraform SHOULD own it, and
    # a pinned image digest here must actually reach the running task.
    ignore_changes = [desired_count]
  }
}

# ==========================================================================
# ACCESS — why there is no way in, and what to build when there needs to be.
#
# THE THREE OPTIONS, PRICED.
#
#   A. A SECOND, INTERNAL ALB. ~$16–18/month of fixed cost (Appendix B.2 prices
#      the existing one at $18) for a load balancer that, today, NOTHING CAN
#      REACH. There is no VPN, no Client VPN endpoint, no bastion and no SSH
#      (runbook §6.1). An internal ALB in this VPC is an $18/month private
#      hostname with no client on the private side of it. Rejected on the
#      arithmetic alone.
#
#   B. A TARGET GROUP ON THE EXISTING ALB + A LISTENER RULE SCOPED BY
#      source_ip. The ALB is already paid for and target groups and listener
#      rules are free, so this looks like the obvious answer. It is the right
#      answer LATER and the wrong one now, for three specific reasons:
#
#        1. THE LISTENER RULE WOULD NEVER BE EVALUATED. network.tf admits
#           exactly one thing to the ALB security group: the CloudFront
#           origin-facing managed prefix list, on 443. An operator's laptop is
#           dropped by the security group before the listener sees the packet,
#           so a source_ip condition would be decorative. Making it real means
#           adding operator IPs as ALB ingress — and that SG carries the ⚠
#           QUOTA note: the managed prefix list consumes its max_entries (55)
#           against the default 60 rules per security group, so there is room
#           for a handful of rules in the whole environment, permanently.
#           Spending them on a service that is switched off is a bad trade.
#
#        2. A source_ip ALLOWLIST ROTS, AND IT ROTS OPEN-ENDED. The addresses
#           available are residential broadband and mobile — dynamic. The
#           allowlist is either re-applied every few weeks (it will not be) or
#           it is widened "just for today" (it will be). Either way an admin
#           console reachable from the public internet is one stale CIDR away
#           from being reachable by someone else on the same ISP.
#
#        3. ⚠ DEFAULT ADMIN. Open-source Unleash seeds a first admin user on an
#           empty database with a well-known default password. Publishing a
#           kill-switch console to the internet in that state — even behind an
#           IP allowlist — is the single worst outcome available in this file,
#           because it is a console whose entire purpose is to change
#           production behaviour without a deploy. The generated
#           `admin_password` in the tokens secret exists so that closing this
#           is a config change, but it is NOT wired in (see the note on that
#           key), so today the hole is real and the only thing closing it is
#           the absence of a route.
#
#   C. NO INGRESS AT ALL. $0. Chosen.
#
# WHY C IS DEFENSIBLE AND NOT MERELY CHEAP: the service is at desired_count = 0
# and `FLAGS_MODE=file`, so there is nothing running to administer and no
# client to serve. Option C is not "we skipped the security work" — it is that
# the correct amount of attack surface for a switched-off admin console is
# none, and the security group having zero ingress rules is a control that
# cannot be misconfigured, cannot expire, and does not consume the ALB's
# scarce rule quota.
#
# WHAT TO BUILD WHEN THE SERVICE IS TURNED ON — option B, plus the part runbook
# Step 9 actually asks for and that source_ip alone does not provide
# ("Identity Center-fronted auth"):
#
#   1. aws_lb_target_group (port 4242, target_type "ip", health check /health)
#      + aws_lb_listener_rule on the EXISTING aws_lb_listener.https, with a
#      host_header condition on local.unleash_host. Free.
#   2. ⚠ READ THE HOST-HEADER TRAP IN edge.tf FIRST. CloudFront's
#      Managed-AllViewerExceptHostHeader policy replaces the Host header with
#      the ORIGIN hostname, so the moment any listener rule matches on
#      host_header, every request arriving through CloudFront stops matching
#      the api rule. That is the most misleading failure shape available here
#      and it is one line away.
#   3. An `authenticate-oidc` default action on that rule, pointed at Identity
#      Center as an OIDC application. THIS is what "Identity Center-fronted"
#      means and it is what makes source_ip unnecessary: the ALB refuses to
#      forward the request at all until the viewer has an identity. Free.
#   4. Ingress on the unleash security group from the ALB security group on
#      4242, and matching egress on the ALB group — one rule each, and the ALB
#      SG quota note above applies to the egress side too.
#   5. A Route 53 alias for local.unleash_host (the *.${local.domain} wildcard
#      certificate in alb.tf already covers it — no new certificate).
#   6. Change the default admin password BEFORE step 5, not after.
#
# THE APPLICATION SIDE, which needs none of this: api and workers reach Unleash
# over the VPC on 4242, not through any load balancer. That path needs a stable
# address — ECS Service Connect or a Cloud Map namespace, both free — plus one
# ingress rule from the app security group. It is a separate, smaller change
# from the admin-UI change, and it is the one that actually has to work for
# flags to function. Do not let the admin UI block it.
# ==========================================================================

# ==========================================================================
# COST — what this file adds, itemised (D35: $8,000 / 6 months; Appendix B.2
# budgets staging at $140–170/month).
#
# TODAY, at desired_count = 0:
#
#   Secrets Manager, 2 secrets       $0.80/mo   $0.40 each; the split is argued
#                                               at the tokens secret above
#   ECS task definition + service    $0.00      neither is billable; a service
#                                               with no tasks costs nothing
#   Security group + 5 rules         $0.00
#   CloudWatch log group             $0.00      billed on ingest and storage,
#                                               and nothing is writing to it
#   RDS                              $0.00      shares the existing db.t4g.small
#                                               (data.tf). Unleash's schema is a
#                                               few MB against 50 GB allocated
#                                               and its connection pool is
#                                               single-digit against the ~225
#                                               max_connections that
#                                               observability.tf alarms on
#   KMS                              $0.00      reuses alias/nt-staging-secrets
#   ---------------------------------------
#   TOTAL                            $0.80/month
#
# IF FLIPPED TO desired_count = 1:
#
#   Fargate 0.5 vCPU + 1 GB, ARM64  $16.60/mo
#   Public IPv4 (no NAT — B.3)       $3.60/mo
#   CloudWatch Logs ingest+storage   ~$0.50/mo  at info level
#   Secrets Manager                  $0.80/mo
#   ---------------------------------------
#   TOTAL                            ~$21.50/month  ≈ 14% of the staging envelope
#
# IS THAT PROPORTIONATE? At Infra Week, yes — a kill switch per outbound
# channel is a Governance §8 requirement and $21/month is a cheap way to hold
# one. Today, with no application code and FLAGS_MODE=file, it would be 14% of
# staging spend for nothing, which is why the count is 0.
#
# ⚠ D33 / Gov §13.5 GATE — "no paid service goes live without a budget line, a
# usage metric, and an alert". This service is not live, so the gate is not
# open yet, and it must be satisfied BEFORE the count changes rather than
# after. The cheapest way to satisfy it reuses machinery that already exists:
# add one line to `local.ecs_services` in observability.tf —
#
#     unleash = aws_ecs_service.unleash.name
#
# — which gives Unleash both the task-shortfall and the memory-high alarms for
# $0.20/month. Deliberately NOT done here: observability.tf belongs to another
# lane, and adding a permanently-grey alarm for a service that is switched off
# is precisely the noise that file's tiering banner exists to prevent.
# ==========================================================================

output "unleash_security_group_id" {
  value       = aws_security_group.unleash.id
  description = "Zero ingress rules by design. Adding one is the change described in the ACCESS banner."
}

output "unleash_service_name" {
  value       = aws_ecs_service.unleash.name
  description = "Runs at desired_count = 0 until Infra Week; turning it on is a count change plus the one-off SQL."
}

output "unleash_task_family" { value = aws_ecs_task_definition.unleash.family }

output "unleash_database_secret_arn" {
  value       = aws_secretsmanager_secret.unleash_database.arn
  description = "Credential for a Postgres role and database that DO NOT EXIST YET - the SQL is in unleash.tf."
}

output "unleash_tokens_secret_arn" {
  value       = aws_secretsmanager_secret.unleash_tokens.arn
  description = "Init admin token, client SDK token and admin password. The app reads client_token when FLAGS_MODE flips."
}

output "unleash_log_group_name" { value = aws_cloudwatch_log_group.unleash.name }
