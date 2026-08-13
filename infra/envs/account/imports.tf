# --------------------------------------------------------------------------
# ADOPTION — one-shot import blocks (Terraform >= 1.5, declarative form).
#
# Every resource in this directory already exists in AWS. All of it was
# created by console/CLI on 13 Aug 2026 and recorded as "Terraform TODO" in
# infra/README.md. These blocks make the first plan ADOPT the live resources
# instead of trying to create duplicates.
#
# Why the declarative form and not `terraform import` on the CLI: the CLI
# command mutates state immediately with no plan and no review, and it cannot
# run in CI. Import blocks are visible in the diff, dry-run under `plan`, and
# a reviewer can check every ID below against AWS before anything is written.
#
# IDs verified against the live account 13 Aug 2026 with read-only calls
# (describe-trails, list-detectors, describe-budgets). Every value is an
# identifier, not a secret.
#
# DELETE THIS FILE once the adoption apply has run. Import blocks are one-shot
# by design: after adoption they are inert, and leaving them behind gives the
# next reader the false impression that these resources are still unmanaged.
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# CloudTrail — `aws_cloudtrail` imports by trail NAME, not by ARN.
# --------------------------------------------------------------------------

import {
  to = aws_cloudtrail.audit
  id = "neoting-audit"
}

# The trail's destination bucket and its four sub-resources. In AWS provider
# 5.x each S3 bucket setting is its own resource, and each imports by the
# bucket name — the same ID five times over. That is correct, not a copy-paste
# error.
import {
  to = aws_s3_bucket.cloudtrail
  id = "neoting-cloudtrail-252959251643"
}

import {
  to = aws_s3_bucket_versioning.cloudtrail
  id = "neoting-cloudtrail-252959251643"
}

import {
  to = aws_s3_bucket_server_side_encryption_configuration.cloudtrail
  id = "neoting-cloudtrail-252959251643"
}

import {
  to = aws_s3_bucket_public_access_block.cloudtrail
  id = "neoting-cloudtrail-252959251643"
}

import {
  to = aws_s3_bucket_policy.cloudtrail
  id = "neoting-cloudtrail-252959251643"
}

# --------------------------------------------------------------------------
# GuardDuty — imports by DETECTOR ID, which is a per-region opaque hex string,
# not the account ID and not a name. There is exactly one detector per region
# per account, so these are stable for the life of the account: they change
# only if someone disables and re-enables GuardDuty, which would also throw
# away the finding history.
# --------------------------------------------------------------------------

import {
  to = aws_guardduty_detector.primary
  id = "d2cffdb00e5cf016d9bd974582ba8442" # eu-west-2, created 2026-08-13T13:46:48Z
}

# The eu-west-1 detector lives under the aliased provider, so the import block
# must name that provider too — otherwise Terraform looks for the detector in
# eu-west-2 and fails with "detector not found" on an ID that plainly exists.
import {
  to       = aws_guardduty_detector.dr
  id       = "5acffdb012d9315c77ebc64a84802cf9" # eu-west-1, created 2026-08-13T13:46:50Z
  provider = aws.dr
}

# --------------------------------------------------------------------------
# Budgets — the ID is "AccountID:BudgetName". Budget names are unique per
# account and cannot be changed after creation; renaming means delete and
# recreate, which resets the alert state and the notification history.
# --------------------------------------------------------------------------

import {
  to = aws_budgets_budget.monthly
  id = "252959251643:neoting-monthly-1300"
}

import {
  to = aws_budgets_budget.pot
  id = "252959251643:neoting-pot-8000"
}

# --------------------------------------------------------------------------
# DELIBERATELY NOT IMPORTED
#
# `Default-Services-Monitor` (Cost Explorer anomaly detection, arn
# .../anomalymonitor/f1c5fcf7-c8af-4830-ab0f-f7f9a13674f6) and its
# subscription `Default-Services-Subscription` exist in this account but were
# created 2023-11-28 — over two years before Neoting — and notify
# rraakkiibb0110@gmail.com, an address that belongs to another Neovogent
# product. They are shared-account furniture (D36), not ours.
#
# Adopting them into Neoting state would mean a Neoting `terraform destroy`
# deletes another product's cost alerting. Runbook Step 10 wants Neoting's own
# anomaly monitor; that is a create in a later PR, not an adoption here.
# --------------------------------------------------------------------------
