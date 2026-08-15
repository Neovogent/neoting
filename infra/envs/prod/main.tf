# ==========================================================================
# NEOTING PRODUCTION — and it is NOT in a production AWS account.
#
# ⚠ READ THIS BEFORE ANYTHING ELSE IN THIS DIRECTORY.
#
# D36: the dedicated `neoting-prod` account DOES NOT EXIST. It has been
# requested from the reseller (Cloudvisor) and has not been delivered. Until it
# lands, production runs in account 252959251643 — the SAME account as staging,
# and the same account as three unrelated Neovogent products (Cedofinance,
# visa-processing, needz) with six other IAM principals holding admin.
#
# What that costs us, stated plainly rather than buried:
#
#   * NO blast-radius separation between staging and prod. A credential
#     compromise, an IAM misconfiguration or a console mistake reaches both.
#   * NO account-level spend separation. Appendix B.1's per-environment
#     envelopes are an accounting fiction enforced by tags, not by a billing
#     boundary (envs/account/budgets.tf holds ONE $1,300 budget for exactly
#     this reason).
#   * The compensating controls are the `role/nt-*` explicit-Deny bucket and
#     KMS policies, CloudTrail and GuardDuty (envs/account/). They are real,
#     and they are weaker than an account boundary. ADR 0007 §"counter-argument"
#     says the same thing about the DR region and it is worth reading.
#   * The DPIA must NOT claim administrative separation between environments.
#     There is none.
#
# THE MIGRATION, WHEN THE ACCOUNT ARRIVES, IS ONE LINE. `local.account_id`.
# Everything downstream — bucket names, the role/nt-* guards in the bucket and
# key policies, the `allowed_account_ids` provider guardrail, the confused-
# deputy conditions, the CI trust policies — is derived from it. Nothing else
# in this directory should need to change. That is the whole reason bucket
# names are built from a local rather than typed, and it is worth protecting:
# if you find yourself hardcoding 252959251643 anywhere below, don't.
#
# The one thing that is NOT a one-line move: state. This root's backend points
# at the state bucket in the current account, and moving accounts means
# `terraform state pull` / push into a new bucket, or a re-import. Plan an hour.
#
# ==========================================================================
# WHAT THIS ROOT IS, AND WHAT IT DELIBERATELY IS NOT
#
# It is the production PLATFORM: network with a real NAT and interface
# endpoints, RDS Multi-AZ, ElastiCache with a replica, the document buckets and
# their CMK, cross-region replication to the ADR 0007 DR region, secrets, the
# ECS cluster, the ALB, and both services at desired_count = 0.
#
# It is NOT the whole of what staging has. CloudFront + WAF (edge.tf), SES
# (email.tf), the CloudWatch alarm estate (observability.tf), AMP/AMG
# (monitoring-backend.tf), Unleash and ClamAV are NOT here yet. Each is
# recorded at the foot of this file with the reason. None of them is an
# oversight and none of them is load-bearing for standing prod up in October
# with no image deployed.
# ==========================================================================

terraform {
  # ⚠ >= 1.11, NOT staging's >= 1.7. `use_lockfile` below is a 1.11 feature,
  # and on 1.7–1.10 it does not error — it is silently ignored, so two
  # concurrent applies get no lock at all and the second one clobbers the
  # first's state. Staging carries the same latent hole (ADR 0006 consequence
  # 5, follow-up still open); a new root has no reason to inherit it.
  required_version = ">= 1.11"

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
    # SAME BUCKET as staging and account, DIFFERENT KEY (ADR 0006, Decision 1:
    # split by lifetime). The bucket name reads "staging" because it was
    # created during the staging bootstrap and the name is now load-bearing —
    # renaming an S3 bucket is a copy-and-repoint of every state file in it,
    # which is a worse afternoon than an awkward name.
    #
    # ⚠ THE KEY IS THE WHOLE ISOLATION. prod/core.tfstate must never be shared
    # with staging/core.tfstate or account/core.tfstate. A shared key means one
    # `terraform destroy` in the wrong directory takes production with it.
    bucket = "nt-tfstate-staging-252959251643"
    key    = "prod/core.tfstate"
    region = "eu-west-2"

    # S3-native state locking (Terraform >= 1.11). Replaces the DynamoDB lock
    # table, which is deprecated.
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = local.region

  # Guardrail: refuse to run against the wrong account. In a shared account
  # (D36) this is the cheapest control there is, and it is the one that will
  # catch the day someone points prod at the new neoting-prod account without
  # migrating state.
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

# --------------------------------------------------------------------------
# The DR provider. ADR 0007 authorises this region for backup and replication
# targets and NOTHING ELSE.
#
# Read the ADR before adding a resource under this provider. "eu-west-1 holds
# encrypted Postgres logical backups and replicated S3 objects, and is the
# target of the quarterly restore drill. Nothing PROCESSES there." That
# sentence is the D30 residency promise to accountants — their clients'
# documents are processed in London — and a compute resource under this alias
# breaks it silently, because Terraform will happily create it.
#
# The guardrail policy (policies/region-guardrail.json) enforces the same rule
# at the IAM layer, so a mistake here fails at apply rather than shipping. That
# is deliberate belt-and-braces: the comment is the intent, the policy is the
# control.
#
# default_tags is set here where staging's us_east_1 alias omits it. An
# untagged replica bucket is invisible to the Governance §13.5 cost split, and
# DR storage is a line item that only ever grows.
# --------------------------------------------------------------------------
provider "aws" {
  alias  = "eu_west_1"
  region = local.dr_region

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
  # ⚠ THE ONE LINE THAT MOVES WHEN THE DEDICATED ACCOUNT LANDS (D36).
  account_id = "252959251643"

  env    = "prod"
  region = "eu-west-2"

  # ADR 0007. A variable, not a literal scattered through the files, so the
  # choice stays re-decidable and greppable — that is consequence 1 of the ADR
  # verbatim.
  dr_region = "eu-west-1"

  github_repo = "neovogent/neoting"

  # See the long note on the same local in envs/staging/main.tf. Short version,
  # measured 14 Aug 2026 by decoding a real Actions ID token: GitHub emits
  # `repo:<org>@<org-id>/<repo>@<repo-id>:...`, not `repo:<org>/<repo>:...`,
  # so a trust policy written against the documented-looking format matches
  # nothing and the role can never be assumed.
  #
  # Fixing it here as well as in staging, even though prod is authored-but-
  # unapplied (ADR 0005), precisely because it is unapplied: this is the class
  # of bug that is free to fix now and costs an afternoon of a production
  # deploy window later.
  github_sub_immutable = "repo:Neovogent@316230831/neoting@1333088145"

  # D5: neoting.neovogent.com is the pre-launch domain; neoting.com at cutover.
  #
  # ⚠ PROD TAKES A SUBDOMAIN OF IT, AND THAT IS NOT COSMETIC. There is exactly
  # ONE hosted zone in this account (`aws route53 list-hosted-zones`, verified
  # 14 Aug 2026) and staging has already claimed the un-prefixed names in it:
  # `api.neoting.neovogent.com` and `origin-api.neoting.neovogent.com`. Two
  # environments cannot own one record. So prod lives under `prod.` until the
  # neoting.com cutover, at which point this local becomes "neoting.com", a new
  # zone is delegated, and the certificate and the ALB alias follow it.
  #
  # Records for prod.<parent> live in the PARENT zone — no delegation, no
  # second hosted zone, no $0.50/month. If prod ever needs its own NS
  # delegation (it does not today), that is a change here plus a zone resource.
  parent_zone = "neoting.neovogent.com"
  domain      = "prod.neoting.neovogent.com"

  azs = ["eu-west-2a", "eu-west-2b", "eu-west-2c"]

  # 10.30.0.0/16 — reserved for prod by the comment on staging's
  # local.vpc_cidr ("staging; prod takes 10.30.0.0/16 — never overlap"). The
  # two MUST NOT overlap: a VPC peering or a Transit Gateway between them later
  # is impossible if they do, and "later" is when someone wants to run a data
  # migration or a restore drill across the boundary.
  vpc_cidr = "10.30.0.0/16"

  # Convenience alias, same shape as staging: names are still built by exactly
  # one piece of code (the storage module) and this is a read of its output.
  bucket_names = module.storage.bucket_names

  # The shared deny-guard template, referenced by path rather than copied.
  # replication.tf renders it for the DR bucket, so the replica in Dublin
  # carries byte-identical TLS-only + nothing-outside-role/nt-* rules as the
  # primary in London. Two copies of a deny guard is the drift that silently
  # opens a bucket.
  shared_bucket_policy_template = "${path.module}/../../modules/storage/policies/bucket.json.tftpl"
}

# --------------------------------------------------------------------------
# Documents CMK + the three document buckets — infra/modules/storage.
#
# Same module, same three buckets, same encryption topology as staging. The
# only differences are the names (nt-prod-*) and the key alias
# (alias/nt-prod-docs) — both derived from local.env, so there is nothing to
# get wrong here.
#
# ⚠ THE RECEIPTS BUCKET IS AES256 AND MUST STAY AES256. This is not a staging
# shortcut carried over by copy-paste. SES validates a receipt rule by
# test-writing to the bucket, and that write fails against a
# customer-managed-key default ("InvalidS3Configuration: Kms key is not
# available") no matter how the key policy is written — verified empirically
# 13 Aug 2026 against this account.
#
# And naming the key on the SES s3_action does NOT rescue it: that makes SES
# encrypt CLIENT-side with the S3 encryption client, producing envelope
# ciphertext only the Java and Ruby SDKs can decrypt. This repo is TypeScript.
# ADR 0002 records the trade. Objects in `inbound/` land under the bucket's
# AES256 default, are transient (lifecycle.tf expires them at 30 days), and the
# extracted document lands in the docs bucket under the CMK.
#
# The consequence to hold in your head for PROD specifically: for up to 30 days
# there is real client mail in a bucket encrypted with an S3-managed key rather
# than ours, so the `role/nt-*` KMS deny does not protect it — only the bucket
# policy does. That is the price of inbound email working at all, and it is
# why the receipts lifecycle rule is 30 days and not 90.
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

# ==========================================================================
# IAM — and the three account-global collisions that would have failed at
# apply if this file had been a copy of staging's.
#
# ⚠ IAM IS ACCOUNT-SCOPED, NOT ENVIRONMENT-SCOPED, AND WE SHARE THE ACCOUNT.
# Three of staging's IAM resources cannot simply be duplicated here:
#
#   1. `aws_iam_openid_connect_provider.github` — one provider per URL per
#      ACCOUNT. It already exists (`aws iam list-open-id-connect-providers`,
#      verified 14 Aug 2026). Creating it again fails with
#      EntityAlreadyExists. Read it, do not create it.
#   2. `aws_iam_policy.region_guardrail` named "nt-region-guardrail" — already
#      exists (`aws iam list-policies --scope Local`). Prod needs a DIFFERENT
#      policy anyway (the ADR 0007 DR carve-out), so it gets its own name.
#   3. The ECR repositories `nt/api`, `nt/web`, `nt/workers` — see compute.tf.
#
# None of these three shows up in `terraform validate`. All three fail at
# apply, individually, minutes apart, on the run where prod stands up.
# ==========================================================================

# Read, never create. See collision 1 above.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

# --------------------------------------------------------------------------
# The region guardrail — prod's own copy, and it is NOT the same policy.
#
# staging attaches `nt-region-guardrail`, which permits eu-west-2 plus the
# global-service exemption in us-east-1 and denies everything else. Prod cannot
# use it: cross-region replication to eu-west-1 (Governance §17, ADR 0007) is
# denied by that policy, and correctly so.
#
# ADR 0007 consequence 2 is explicit about what the fix may and may not be:
# "It needs a narrow carve-out for the backup and replication paths in
# eu-west-1 — scoped to those specific actions and resources, not a blanket
# region allow. A broad `eu-west-1: *` would silently reopen everything D30
# closed." policies/region-guardrail.json implements exactly that and the file
# itself explains each statement. Read it before editing it.
#
# The drift warning that used to live here is DISCHARGED as of 15 Aug 2026.
# There is no longer a second copy: both environments render
# modules/iam-policies, and the shared part — the eu-west-2 pin, the
# global-service NotAction list, the NoDataServicesInUsEast1 deny — now exists
# once. What made prod different is expressed as INPUT rather than as a
# separate file: setting `dr_region` adds the region to the permitted set AND
# denies every service there except S3, KMS and STS AND confines S3 to
# `dr_buckets`. One variable drives all three because ADR 0007 consequence 2
# forbids the first without the other two — "a broad eu-west-1: * would
# silently reopen everything D30 closed."
# --------------------------------------------------------------------------
resource "aws_iam_policy" "region_guardrail" {
  name        = "nt-${local.env}-region-guardrail"
  description = "D30 UK-first residency guardrail with the ADR 0007 eu-west-1 backup carve-out - SCP substitute (org is consolidated-billing, SCPs unavailable)"

  policy = module.iam_policies.region_guardrail_policy
}

# --------------------------------------------------------------------------
# The shared policy documents. See the long note above for what prod changes
# and why it is an input rather than a file.
#
# ⚠ WHEN THE NIGHTLY LOGICAL-POSTGRES-BACKUP BUCKET LANDS (Governance §17
# wants dumps in the DR region as well as replicated objects), ADD IT TO
# `dr_buckets` IN THE SAME CHANGE. Miss it and the backup job is denied by
# DrRegionS3IsTheBackupBucketsOnly, and the failure looks like an S3 outage
# rather than a policy error. `dr_buckets` is a list for exactly this reason —
# it makes that a one-line call-site edit instead of a policy-file edit.
# --------------------------------------------------------------------------
module "iam_policies" {
  source = "../../modules/iam-policies"

  env            = local.env
  account_id     = local.account_id
  tfstate_bucket = "nt-tfstate-staging-${local.account_id}"

  region_guardrail_policy_id = "nt-${local.env}-region-guardrail"

  # Prod's one hardening over staging's copy, preserved exactly: the state
  # grant is scoped to production's own object and its lockfile, so the prod
  # deploy role cannot read or overwrite staging/core.tfstate or
  # account/core.tfstate. In a shared account that is the difference between a
  # misconfigured -backend-config corrupting one environment and three.
  state_key_prefix = "prod/core.tfstate"

  dr_region  = local.dr_region
  dr_buckets = [local.dr_bucket_name]
}

# --------------------------------------------------------------------------
# The application task role.
#
# Named nt-prod-app, and the `nt-` prefix is the load-bearing part: every
# bucket policy and every key policy in this environment denies principals
# whose ARN does not match arn:aws:iam::<account>:role/nt-*. A role named
# anything else is not "less privileged", it is SILENTLY DENIED at the resource
# layer, and the failure reads as a mysterious AccessDenied from S3 rather than
# as a naming mistake.
# --------------------------------------------------------------------------
resource "aws_iam_role" "app" {
  name        = "nt-${local.env}-app"
  description = "Neoting production ECS task role"

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

# ==========================================================================
# CI — ONE role, gated on a GitHub environment. This is the biggest
# deliberate divergence from staging in the whole root, and staging's own
# comment demanded it.
#
# envs/staging/main.tf, on `nt-staging-ci-plan`, says:
#
#   "⚠ THE TRADE-OFF, STATED RATHER THAN BURIED. nt-staging-ci-plan is trusted
#    for ANY ref in the repository (that is what makes plan-on-PR work), so
#    this grant means a pull request can run Terraform with credentials that
#    can read staging secrets, before any human reviews the PR. That is
#    acceptable HERE and only here [...] PROD MUST NOT COPY THIS. A production
#    plan role needs either a deploy-time apply-only credential, or secret
#    versions kept out of Terraform entirely."
#
# So prod has NO ci-plan role. There is no principal a pull request can assume
# against production, at all.
#
# THE PROBLEM THAT FORCES THE CHOICE. `terraform plan` refreshes every
# `aws_secretsmanager_secret_version` in state by calling GetSecretValue.
# ReadOnlyAccess does not grant it (measured against ReadOnlyAccess v188: the
# only Secrets Manager action it carries is GetResourcePolicy). This root owns
# secret versions it cannot avoid owning — module.data generates the Redis auth
# token, and db-app-role.tf generates the credential the whole RLS guarantee
# depends on. So a prod plan role MUST be able to read production database
# credentials, or it cannot plan.
#
# "A PR can read the production database password" is not a trade this
# environment gets to make. Therefore:
#
#   * plan and apply for prod BOTH run as nt-prod-ci-deploy;
#   * that role is trusted only for `environment:prod`, which GitHub will not
#     issue a token for until the environment's required reviewers approve;
#   * a human therefore approves before any production credential is minted,
#     which is the same shape as the Review → Approve rule the product itself
#     enforces (Governance §10), applied to the infrastructure.
#
# Cost of this, stated: no plan output on a PR that touches prod. Review sees
# the diff, not the plan, until someone approves the environment. That is the
# right way round for production, and it is worse developer experience — say so
# rather than pretending otherwise.
# ==========================================================================
resource "aws_iam_role" "ci_deploy" {
  name        = "nt-${local.env}-ci-deploy"
  description = "GitHub Actions plan+apply role for production - ${local.github_repo}, `prod` environment only (requires reviewer approval)"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }

        # `environment:prod`, not `ref:refs/heads/main`.
        #
        # A ref condition says "this came from trunk". An environment condition
        # says "a human with the reviewer role approved this specific run".
        # GitHub does not mint a token with `environment:prod` in the `sub`
        # claim until the deployment protection rule has been satisfied, so the
        # approval gate is enforced at the IAM layer — where a workflow edit
        # cannot reach it — rather than by an `if:` in a YAML file that the
        # same PR could change.
        #
        # ⚠ THE PRECONDITION, WHICH TERRAFORM CANNOT CREATE: a GitHub
        # environment named exactly `prod` must exist on the repository with
        # required reviewers configured. Without it this role is simply
        # unassumable and every prod deploy fails at the credential step. It is
        # a repository setting, not AWS.
        #
        # IgnoreCase for the same reason as staging: IAM string conditions are
        # case-SENSITIVE, the org's canonical casing is `Neovogent` while this
        # config carries `neovogent`, and GitHub does not permit two orgs
        # differing only by case — so it costs nothing in strength.
        # First entry is the one GitHub actually sends; the legacy spelling is
        # kept only as a rollback cushion. Both stay pinned to
        # `:environment:prod`, which is what makes the GitHub Environment's
        # required reviewers the "one-click promote" gate of §14.9 — a subject
        # carrying that suffix is only ever minted after the approval.
        StringEqualsIgnoreCase = {
          "token.actions.githubusercontent.com:sub" = [
            "${local.github_sub_immutable}:environment:prod",
            "repo:${local.github_repo}:environment:prod",
          ]
        }
      }
    }]
  })
}

# PowerUserAccess, same as staging: it grants everything except IAM, and the
# IAM it needs is added below, scoped to nt-* only.
resource "aws_iam_role_policy_attachment" "ci_deploy_power" {
  role       = aws_iam_role.ci_deploy.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

# The guardrail is attached to the DEPLOY role too, not just the app role. It
# is the only thing standing between a `terraform apply` and a resource in
# ap-southeast-1, and PowerUserAccess on its own would happily create one.
resource "aws_iam_role_policy_attachment" "ci_deploy_guardrail" {
  role       = aws_iam_role.ci_deploy.name
  policy_arn = aws_iam_policy.region_guardrail.arn
}

resource "aws_iam_role_policy" "ci_deploy_scoped_iam" {
  name = "nt-terraform-scoped-iam"
  role = aws_iam_role.ci_deploy.name

  policy = module.iam_policies.ci_deploy_inline_policy
}

# ==========================================================================
# WHAT IS NOT IN THIS ROOT, AND WHY. Keep this list honest — an undocumented
# gap in production reads as an oversight to whoever finds it at 2am.
#
#  edge.tf (CloudFront + WAF, us-east-1)
#      NOT BUILT. Two reasons, one of them a blocker. (a) The public hostname
#      is undecided: D5 puts the product on neoting.com at cutover, and
#      building a distribution + certificate on prod.neoting.neovogent.com
#      means building it twice. (b) ~$11.50/mo for a distribution serving
#      desired_count = 0.
#      ⚠ CONSEQUENCE, AND IT IS THE RIGHT ONE: the prod ALB's security group
#      admits :443 from the CloudFront origin-facing prefix list ONLY, so with
#      no distribution the prod ALB is unreachable from anywhere. Production is
#      dark by construction until the edge lands, which is exactly what you
#      want of an environment with no image and no pen test.
#
#  email.tf (SES inbound + outbound identity)
#      NOT BUILT. SES production access is a support-ticket flow, still open
#      and pending our reply on case 178662887400793 (see staging's email.tf).
#      The inbound MX also has to sit on a name, and prod's name is the same
#      cutover decision as the edge. The receipts bucket and its AES256 default
#      ARE built, so landing SES later is a receipt-rule change, not a storage
#      migration. The task role deliberately carries no ses:SendEmail grant
#      until then.
#
#  observability.tf / monitoring-backend.tf (alarms, dashboards, SNS, AMP/AMG)
#      NOT BUILT. This is the most uncomfortable omission on the list and it is
#      a HARD BLOCKER on carrying pilot traffic: Governance §13.2 wants alerts
#      on queue age > 5 min, and Appendix B.1's November pilot has no meaning
#      without them. It is not here because the alarm estate is sized against
#      the services it watches and both services are at zero. ⚠ Prod must not
#      take a single real document until this lands. Budget ~$15–25/mo.
#
#  unleash.tf / clamav.tf
#      NOT BUILT. Both are Fargate services with their own load balancers and
#      security groups; both are pointless while the application is at zero.
#      ClamAV in particular is a Governance §11.x requirement for the upload
#      path and must land with the first real upload, not after it.
#
#  A restore drill
#      NOT AUTOMATED, and Governance §17 is explicit that an untested backup is
#      a hope. PITR at 35 days and cross-region replication are configured
#      (data.tf, replication.tf); nothing has ever been restored FROM them.
#      ADR 0007 consequence 4 wants the first drill scheduled the moment
#      staging holds seed data, with the measured RTO recorded in the ADR.
# ==========================================================================

output "account_id" {
  value       = local.account_id
  description = "D36: shared with staging and three unrelated products until the dedicated account lands."
}

output "kms_key_arn" { value = module.storage.kms_key_arn }
output "bucket_names" { value = local.bucket_names }
output "ci_deploy_role_arn" { value = aws_iam_role.ci_deploy.arn }
output "app_role_arn" { value = aws_iam_role.app.arn }

output "region_guardrail_policy_arn" {
  value       = aws_iam_policy.region_guardrail.arn
  description = "Prod's own guardrail, with the ADR 0007 eu-west-1 carve-out. NOT the same policy staging attaches."
}
