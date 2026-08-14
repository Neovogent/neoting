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

  # ⚠ THE OIDC SUBJECT GITHUB ACTUALLY SENDS, and it is not `repo:<owner>/<repo>`.
  #
  # Measured on 14 Aug 2026 by decoding a real Actions ID token:
  #
  #   "sub": "repo:Neovogent@316230831/neoting@1333088145:ref:refs/heads/..."
  #   "aud": "sts.amazonaws.com"
  #   "repository": "Neovogent/neoting"
  #
  # GitHub now embeds the immutable ORGANISATION ID and REPOSITORY ID in the
  # subject, so a rename cannot be used to impersonate a repo. Confirmable
  # without a workflow run:
  #   gh api repos/Neovogent/neoting/actions/oidc/customization/sub
  #   → "sub_claim_prefix": "repo:Neovogent@316230831/neoting@1333088145"
  #
  # Both trust policies below were written against the OLD format, so neither
  # role could ever be assumed. That is why terraform.yml's own comment says
  # they "have never been used" — they had never worked. The symptom is
  # `Not authorized to perform sts:AssumeRoleWithWebIdentity` after the
  # action's retry loop, which reads like a missing permission and is a string
  # mismatch.
  #
  # These IDs are stable for the life of the org and repo, and they are not
  # secret — they are readable from the public API by anyone who can see the
  # repo. Deleting and recreating the repository under the same name mints a
  # NEW id, and CI stops working until this line is updated. That is the
  # security property, not a bug: the old subject can never be replayed.
  github_sub_immutable = "repo:Neovogent@316230831/neoting@1333088145"
  domain               = "neoting.neovogent.com" # pre-launch domain (D5); neoting.com at cutover
  azs                  = ["eu-west-2a", "eu-west-2b", "eu-west-2c"]
  vpc_cidr             = "10.20.0.0/16" # staging; prod takes 10.30.0.0/16 — never overlap

  # Convenience alias so the twenty-odd references across compute.tf,
  # services.tf, clamav.tf and email.tf did not all have to change shape when
  # the buckets moved into a module. Names are still built by exactly one piece
  # of code — the module — and this is a read of its output, not a second copy
  # of the convention.
  bucket_names = module.storage.bucket_names

  # The deny-guard bucket policy template moved into modules/storage along with
  # the buckets it was written for — but it is not storage-module-private.
  # clamav.tf builds the quarantine and AV-definitions bucket policies on top of
  # the same shape (TLS-only + nothing outside role/nt-*), one of them by
  # jsondecode-ing it and appending a statement.
  #
  # Referenced by path rather than copied back into this directory on purpose:
  # two copies of a `role/nt-*` deny guard is precisely the drift that silently
  # opens a bucket, and it would be invisible in review because both files would
  # look correct on their own. One file, one edit, every bucket in the
  # environment moves together.
  shared_bucket_policy_template = "${path.module}/../../modules/storage/policies/bucket.json.tftpl"
}

# --------------------------------------------------------------------------
# Documents CMK + the three document buckets — infra/modules/storage.
#
# The KMS policy, the bucket policies and the templates that render them live
# in the module. Only the bucket MAP is an environment decision, which is what
# lets prod add a bucket without anyone editing shared code.
#
# The ops CMK (observability.tf) and the secrets CMK (secrets.tf) are
# deliberately NOT in here: they protect different data classes under
# deliberately different key policies, and folding three keys into one module
# would mean one variable per policy difference and no clarity gained.
#
# DataClass drives retention jobs (Governance §12.2) and cost attribution
# (§13.5).
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
#
# receipts is also the one bucket whose policy is not the default: SES needs an
# explicit Allow to deliver into inbound/, so it names the module's
# bucket-receipts template.
# --------------------------------------------------------------------------
module "storage" {
  source = "../../modules/storage"

  env        = local.env
  account_id = local.account_id
  region     = local.region

  buckets = {
    docs     = { data_class = "customer-document", sse = "aws:kms" }
    receipts = { data_class = "customer-document", sse = "AES256", policy_template = "bucket-receipts.json.tftpl" }
    exports  = { data_class = "customer-document", sse = "aws:kms" }
  }

  kms_deletion_window_in_days = 30
  kms_enable_key_rotation     = true
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
        # TWO forms, and the FIRST is the one that actually matches today (see
        # `github_sub_immutable` in locals): GitHub emits the immutable
        # org-id/repo-id subject. The legacy `owner/repo` spelling is retained
        # only so that a rollback of GitHub's format does not take CI down; it
        # can be deleted once the immutable form has been stable for a while.
        #
        # Still an EXACT match on `:ref:refs/heads/main`, not a wildcard. This
        # is the security boundary of the whole deploy path — a PR branch must
        # not be able to assume this role — and the `if:` on the workflow job is
        # only a convenience.
        StringEqualsIgnoreCase = {
          "token.actions.githubusercontent.com:sub" = [
            "${local.github_sub_immutable}:ref:refs/heads/main",
            "repo:${local.github_repo}:ref:refs/heads/main",
          ]
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
        # The FIRST entry is the one that matches today — GitHub emits the
        # immutable org-id/repo-id subject (see `github_sub_immutable` in
        # locals). The two legacy spellings are retained so a rollback of
        # GitHub's format does not take plan runs down.
        #
        # The wildcard is wider than the deploy role's on purpose: plan runs on
        # PR branches, so the ref cannot be pinned. It is bounded instead by
        # ReadOnlyAccess and by the workflow refusing to run for forks.
        StringLike = {
          "token.actions.githubusercontent.com:sub" = [
            "${local.github_sub_immutable}:*",
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
output "kms_key_arn" { value = module.storage.kms_key_arn }
output "bucket_names" { value = local.bucket_names }
output "ci_deploy_role_arn" { value = aws_iam_role.ci_deploy.arn }
output "ci_plan_role_arn" { value = aws_iam_role.ci_plan.arn }
output "app_role_arn" { value = aws_iam_role.app.arn }
