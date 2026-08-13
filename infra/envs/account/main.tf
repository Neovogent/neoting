# --------------------------------------------------------------------------
# envs/account — the account-scoped controls that belong to no environment.
#
# CloudTrail, GuardDuty and AWS Budgets are properties of AWS account
# 252959251643 itself, not of staging or prod. Putting them in envs/staging/
# would mean `terraform destroy` on a disposable environment (G1) takes the
# audit trail with it, and prod's config would have to either duplicate them
# or fight staging for ownership. Separate state, separate lifecycle.
#
# WHY THIS EXISTS AT ALL (D36): the shared-account compensating-control
# argument in infra/README.md rests on "everything is defined in Terraform so
# that moving to dedicated accounts is a variable change rather than a
# rebuild". Until 13 Aug 2026 that claim had a hole in exactly the place it
# could least afford one — the audit controls themselves were console
# artefacts. This directory closes it.
# --------------------------------------------------------------------------

terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # Credentials come from the environment: AWS_PROFILE=nt locally, OIDC in CI.
  # No `profile` here on purpose — hardcoding a local profile name breaks CI.
  #
  # Same bucket as staging, DIFFERENT key. Sharing one state file would couple
  # the audit baseline to an environment that is explicitly disposable, and
  # would put the trail inside the blast radius of any `-target`ed staging
  # apply. The bucket is shared only because it is bootstrap infrastructure
  # (see infra/README.md) and creating a second one buys nothing.
  backend "s3" {
    bucket = "nt-tfstate-staging-252959251643"
    key    = "account/core.tfstate"
    region = "eu-west-2"

    # S3-native state locking (Terraform >= 1.11). A distinct key means a
    # distinct lockfile, so account applies and staging applies never block
    # each other.
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = local.region

  # Guardrail: refuse to run against the wrong account (shared-account risk).
  # This matters more here than anywhere else in the repo — these resources
  # are account-wide by definition, so a wrong-account apply reconfigures
  # somebody else's audit trail.
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
# eu-west-1 — the ONLY non-eu-west-2 provider in this repo.
#
# Permitted because ADR 0007 names Ireland as the DR region (D30's single
# surviving named fallback, since the UK has one AWS region), and because
# GuardDuty is a DETECTIVE control: it reads CloudTrail management events,
# VPC flow logs and DNS logs and emits findings. It does not store or process
# customer documents, so enabling it in Dublin moves no personal data out of
# the UK and creates no residency exposure under D30.
#
# The reason it must exist: GuardDuty is regional, and an unmonitored region
# in an account we share with three other products (D36) is precisely where
# an attacker would prefer to operate. ADR 0007 §Options already records that
# eu-west-1 hosts Cedofinance, visa-processing and needz — so this region is
# live whether Neoting uses it or not, and it is where our DR copies will land.
#
# Nothing else may be added to this provider without amending ADR 0007.
# --------------------------------------------------------------------------
provider "aws" {
  alias  = "dr"
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
  account_id = "252959251643"
  env        = "account"
  region     = "eu-west-2"

  # ADR 0007: backup and replication targets only. Consequence 1 of that ADR
  # asks for this to be a named value rather than a literal so the choice
  # stays greppable and re-decidable.
  dr_region = "eu-west-1"

  # Adopted from the console, so it does NOT follow the nt-${env}-<thing>
  # convention the rest of the repo uses. Left as-is deliberately: renaming an
  # S3 bucket means creating a new one and recreating the trail, which breaks
  # the continuous log-file-validation digest chain that is the entire point
  # of the trail. A broken chain is worse than an off-convention name.
  cloudtrail_bucket = "neoting-cloudtrail-252959251643"
  trail_name        = "neoting-audit"

  # Budget alerts. This is a personal address, adopted from the console setup
  # of 13 Aug 2026 — runbook Step 10.1 wants eng@/ops@ plus an SNS topic.
  # A single human inbox is a single point of failure for the one alert that
  # tells us the pot is emptying. Tracked as a gap in README.md.
  #
  # Not a secret: an email address on a budget notification carries no
  # credential. Real secrets never enter Terraform (Governance §5.3).
  budget_alert_email = "migrateproperly@gmail.com"
}
