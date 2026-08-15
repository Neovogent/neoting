# --------------------------------------------------------------------------
# IAM Access Analyzer — external access, both regions.
#
# README.md carried this as a gap: "IAM Access Analyzer is not enabled
# (`list-analyzers` returns `[]`). In a shared account with seven users it is
# the cheapest way to find unintended cross-principal access." Verified still
# empty in both regions on 15 Aug 2026 immediately before this file was added.
#
# WHY IT IS THE RIGHT CONTROL FOR *THIS* ACCOUNT SPECIFICALLY (D36):
#
# Every other guard in this repo is an assertion we wrote and then trusted.
# The `role/nt-*` deny in the bucket and KMS policies, the region guardrail,
# the ci-plan/ci-apply split — each is a policy document that a reviewer read
# once and pronounced correct. Access Analyzer is the only thing in the repo
# that answers the different and harder question: *given everything actually
# attached in this account right now, who can reach Neoting's data?* It uses
# automated reasoning over the resolved policy set, so it catches the case a
# reviewer cannot — an allow granted somewhere else, by someone else, in an
# account where six other principals hold admin and three unrelated products
# run alongside us.
#
# It reports on S3 buckets, KMS keys, IAM roles, Secrets Manager secrets, SQS
# queues and ECR repositories — which is very nearly the exact inventory the
# D36 compensating-control argument depends on.
#
# COST: nothing. External access analysis carries no charge.
# --------------------------------------------------------------------------

resource "aws_accessanalyzer_analyzer" "external" {
  analyzer_name = "nt-account-external-access"

  # ACCOUNT, not ORGANIZATION. An organization-scoped analyzer must be created
  # from the org management account and reports across every member — we are
  # not the payer (Cloudvisor is), so this is the only type we can create, and
  # it is also the only one we should: our zone of responsibility is this
  # account, not the org's.
  type = "ACCOUNT"

  tags = { Component = "audit" }
}

# --------------------------------------------------------------------------
# eu-west-1 — same argument as the GuardDuty twin in guardduty.tf, and it
# needs no separate ADR amendment: Access Analyzer is detective-only and reads
# IAM and resource policy metadata. It processes no customer documents, so it
# moves no personal data out of the UK under D30.
#
# ADR 0007 makes Ireland the DR region, prod replicates documents there under
# a second CMK (envs/prod/replication.tf), and eu-west-1 already carries this
# account's three other products. An analyzer there is the difference between
# knowing and assuming that the replica bucket and its key are unreachable
# from outside `role/nt-*`.
# --------------------------------------------------------------------------
resource "aws_accessanalyzer_analyzer" "external_dr" {
  provider = aws.dr

  analyzer_name = "nt-account-external-access-dr"
  type          = "ACCOUNT"

  tags = { Component = "audit" }
}

# --------------------------------------------------------------------------
# ⚠ WHAT IS DELIBERATELY NOT ENABLED, AND THE NUMBER THAT DECIDES IT
#
# `ACCOUNT_UNUSED_ACCESS` — the analyzer that flags roles, users and access
# keys nobody has used. It is genuinely useful and it is NOT free: it bills
# per IAM role and user analysed, every month, across the WHOLE account.
#
# This account holds seven IAM users and dozens of roles, and all but nine of
# those roles belong to Cedofinance, visa-processing and needz. Enabling
# unused-access analysis here would put another team's IAM inventory on
# Neoting's bill and produce findings about principals we have no authority
# to delete. That is a recurring charge for a report nobody in this repo can
# action.
#
# It becomes correct the moment the dedicated `neoting-*` accounts land (D36)
# and the inventory in scope is entirely ours. Until then this is a decision,
# not an omission.
#
# Findings are not routed anywhere yet. They surface in the console and via
# EventBridge; wiring them to the SNS topic that runbook §10.1 wants belongs
# with the alerting work, not here, and pretending otherwise would be the
# "alert nobody receives" failure the budget notification gap already has.
# --------------------------------------------------------------------------

output "access_analyzer_arn" { value = aws_accessanalyzer_analyzer.external.arn }
output "access_analyzer_dr_arn" { value = aws_accessanalyzer_analyzer.external_dr.arn }
