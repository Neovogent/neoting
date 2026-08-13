terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Credentials come from the environment: AWS_PROFILE=nt locally, OIDC in CI.
  # No `profile` here on purpose — hardcoding a local profile name breaks CI.
  backend "s3" {
    bucket = "nt-tfstate-staging-252959251643"
    key    = "staging/core.tfstate"
    region = "eu-west-2"

    # S3-native state locking (Terraform >= 1.11). Replaces the DynamoDB lock
    # table, which is now deprecated — one less resource to own.
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = local.region

  # Guardrail: refuse to run against the wrong account (shared-account risk).
  allowed_account_ids = [local.account_id]

  default_tags {
    tags = {
      Project   = "neoting"
      Env       = local.env
      Owner     = "eng"
      ManagedBy = "terraform"
    }
  }
}

locals {
  account_id  = "252959251643"
  env         = "staging"
  region      = "eu-west-2"
  github_repo = "neovogent/neoting"
  domain      = "neoting.neovogent.com" # pre-launch domain (D5); neoting.com at cutover
  azs         = ["eu-west-2a", "eu-west-2b", "eu-west-2c"]
  vpc_cidr    = "10.20.0.0/16" # staging; prod takes 10.30.0.0/16 — never overlap

  # DataClass drives retention jobs (Governance §12.2) and cost attribution (§13.5).
  #
  # sse: the receipts bucket is AES256 by default, NOT aws:kms. SES validates a
  # receipt rule by test-writing to the bucket, and that write fails against a
  # customer-managed-key default ("InvalidS3Configuration: Kms key is not
  # available") no matter how the key policy is written — verified empirically
  # 13 Aug 2026.
  #
  # ⚠ CORRECTION. This comment used to continue: "Inbound mail is still
  # encrypted with our CMK: the key is named on the SES action itself
  # (email.tf), which SES accepts. Objects land SSE-KMS under
  # alias/nt-staging-docs exactly as intended." That was WRONG, and it was the
  # sentence a future reader would have trusted.
  #
  # Naming a key on an SES s3_action makes SES encrypt CLIENT-side with the S3
  # encryption client — not SSE-KMS — producing envelope ciphertext that only
  # the Java and Ruby SDKs can decrypt. This repo is TypeScript. The key is
  # therefore NOT named (see email.tf for the full reasoning), and objects in
  # `inbound/` land under the bucket's AES256 default. They are transient:
  # lifecycle.tf expires them at 30 days, and the extracted document lands in
  # the docs bucket under the CMK. ADR 0002 records the trade.
  buckets = {
    docs     = { data_class = "customer-document", sse = "aws:kms" }
    receipts = { data_class = "customer-document", sse = "AES256" }
    exports  = { data_class = "customer-document", sse = "aws:kms" }
  }

  bucket_names = { for k, v in local.buckets : k => "nt-${local.env}-${k}-${local.account_id}" }
}

# --------------------------------------------------------------------------
# KMS — one CMK per environment.
#
# NOTE: SoT §15 / Governance §5.2 describe a per-workspace KMS encryption
# context. S3 SSE-KMS cannot carry an arbitrary encryption context (S3 sets it
# from the object ARN), and client-side encryption would break Textract's
# async S3 path. Workspace isolation is therefore enforced by workspace-prefixed
# object keys + IAM/session scoping + RLS. See runbook Step 6.2 and ADR 0008.
# --------------------------------------------------------------------------
resource "aws_kms_key" "docs" {
  description              = "Neoting staging - documents, receipts, exports (D30 eu-west-2)"
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation      = true
  deletion_window_in_days  = 30

  policy = templatefile("${path.module}/policies/kms-docs.json.tftpl", {
    account_id = local.account_id
  })
}

resource "aws_kms_alias" "docs" {
  name          = "alias/nt-${local.env}-docs"
  target_key_id = aws_kms_key.docs.key_id
}

# --------------------------------------------------------------------------
# S3 — originals are immutable (versioned); isolation by explicit deny.
# --------------------------------------------------------------------------
resource "aws_s3_bucket" "this" {
  for_each = local.buckets
  bucket   = local.bucket_names[each.key]

  tags = { DataClass = each.value.data_class }
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = local.buckets
  bucket                  = aws_s3_bucket.this[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = each.value.sse
      kms_master_key_id = each.value.sse == "aws:kms" ? aws_kms_key.docs.key_id : null
    }
    # Cuts KMS request charges by up to ~99% on a read-heavy document store.
    bucket_key_enabled = each.value.sse == "aws:kms"
  }
}

resource "aws_s3_bucket_policy" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id

  # The receipts bucket additionally grants SES the right to deliver inbound
  # mail into inbound/ — a service principal, so it needs an explicit Allow.
  policy = templatefile(
    each.key == "receipts" ? "${path.module}/policies/bucket-receipts.json.tftpl" : "${path.module}/policies/bucket.json.tftpl",
    {
      bucket     = local.bucket_names[each.key]
      account_id = local.account_id
    }
  )
}

# --------------------------------------------------------------------------
# IAM — the SCP substitute plus the three Neoting principals.
# --------------------------------------------------------------------------
resource "aws_iam_policy" "region_guardrail" {
  name        = "nt-region-guardrail"
  description = "D30 UK-first residency guardrail - SCP substitute (org is consolidated-billing, SCPs unavailable)"
  policy      = file("${path.module}/policies/region-guardrail.json")
}

resource "aws_iam_role" "app" {
  name        = "nt-${local.env}-app"
  description = "Neoting staging ECS task role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "app_guardrail" {
  role       = aws_iam_role.app.name
  policy_arn = aws_iam_policy.region_guardrail.arn
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]

  # AWS populates and maintains the thumbprint for well-known IdPs and no longer
  # validates it for GitHub's provider. Let AWS own it rather than pinning a value
  # that silently rots when GitHub rotates its CA.
  lifecycle {
    ignore_changes = [thumbprint_list]
  }
}

resource "aws_iam_role" "ci_deploy" {
  name        = "nt-${local.env}-ci-deploy"
  description = "GitHub Actions deploy role - ${local.github_repo} main only"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        # IgnoreCase, deliberately. IAM string conditions are case-SENSITIVE and
        # GitHub emits the repository in the `sub` claim with its canonical
        # casing — which is `Neovogent/neoting`, while this config carries
        # `neovogent/neoting`. A plain StringEquals would therefore deny every
        # deploy, and because no workflow had ever assumed this role, the first
        # symptom would have been an unexplained AssumeRoleWithWebIdentity
        # failure on the first real deploy.
        #
        # This costs nothing in strength: GitHub does not allow two
        # organisations whose names differ only by case, so case-insensitive
        # matching cannot widen who this trusts.
        StringEqualsIgnoreCase = {
          "token.actions.githubusercontent.com:sub" = "repo:${local.github_repo}:ref:refs/heads/main"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ci_deploy_power" {
  role       = aws_iam_role.ci_deploy.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

resource "aws_iam_role_policy_attachment" "ci_deploy_guardrail" {
  role       = aws_iam_role.ci_deploy.name
  policy_arn = aws_iam_policy.region_guardrail.arn
}

resource "aws_iam_role_policy" "ci_deploy_scoped_iam" {
  name = "nt-terraform-scoped-iam"
  role = aws_iam_role.ci_deploy.name
  policy = templatefile("${path.module}/policies/ci-deploy-inline.json.tftpl", {
    account_id = local.account_id
  })
}

resource "aws_iam_role" "ci_plan" {
  name        = "nt-${local.env}-ci-plan"
  description = "GitHub Actions plan role - ${local.github_repo} read-only"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com" }

        # The condition MUST be on `sub`. An earlier revision of this file
        # matched the `repository` claim instead, because that claim can use
        # StringEqualsIgnoreCase and `sub` cannot — StringLike has no
        # case-insensitive variant. That was wrong: IAM enforces a guardrail
        # requiring a `sub` condition on any role trusting the GitHub OIDC
        # provider, precisely to stop the aud-only policy that trusts every
        # repository on GitHub. Dropping `sub` fails at apply, not at plan, so
        # nothing above catches it.
        #
        # Both casings are listed because IAM ORs the values of a condition and
        # `sub` is case-sensitive, while the canonical casing of the GitHub
        # organisation is not something this file should have to be right about.
        # It costs nothing: GitHub does not allow two organisations whose names
        # differ only by case, so no third party can occupy the other spelling.
        StringLike = {
          "token.actions.githubusercontent.com:sub" = [
            "repo:Neovogent/neoting:*",
            "repo:neovogent/neoting:*",
          ]
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ci_plan_readonly" {
  role       = aws_iam_role.ci_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# --------------------------------------------------------------------------
# What ReadOnlyAccess does NOT give a plan role, and why plan breaks without it.
#
# Measured against ReadOnlyAccess v188, not assumed: the only Secrets Manager
# action it grants is `secretsmanager:GetResourcePolicy`. It grants neither
# GetSecretValue nor kms:Decrypt.
#
# `terraform plan` refreshes every `aws_secretsmanager_secret_version` in state
# by calling GetSecretValue, so once those resources exist, EVERY PR plan fails
# with AccessDenied — a permanent break that appears on the first PR after the
# first apply, long after anyone associates it with this file.
#
# ⚠ THE TRADE-OFF, STATED RATHER THAN BURIED. `nt-staging-ci-plan` is trusted
# for ANY ref in the repository (that is what makes plan-on-PR work), so this
# grant means a pull request can run Terraform with credentials that can read
# staging secrets, before any human reviews the PR. That is acceptable HERE and
# only here, for one reason: staging holds sandbox credentials exclusively
# (Guideline §8.4, G2) — a leaked staging Twilio token is a sandbox token.
#
# PROD MUST NOT COPY THIS. A production plan role needs either a deploy-time
# apply-only credential, or secret versions kept out of Terraform entirely.
# Granting this against real customer credentials would turn "open a PR" into
# "read production secrets".
# --------------------------------------------------------------------------
resource "aws_iam_role_policy" "ci_plan_refresh_secrets" {
  name = "refresh-secret-versions"
  role = aws_iam_role.ci_plan.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadNeotingSecretsForRefreshOnly"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:/neoting/${local.env}/*"
      },
      {
        # Reading a CMK-encrypted secret needs the key as well as the secret.
        Sid      = "DecryptThoseSecrets"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.secrets.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ci_plan_guardrail" {
  role       = aws_iam_role.ci_plan.name
  policy_arn = aws_iam_policy.region_guardrail.arn
}

# --------------------------------------------------------------------------
output "kms_key_arn" { value = aws_kms_key.docs.arn }
output "bucket_names" { value = local.bucket_names }
output "ci_deploy_role_arn" { value = aws_iam_role.ci_deploy.arn }
output "ci_plan_role_arn" { value = aws_iam_role.ci_plan.arn }
output "app_role_arn" { value = aws_iam_role.app.arn }
