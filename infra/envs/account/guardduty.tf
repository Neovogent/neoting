# --------------------------------------------------------------------------
# GuardDuty — threat detection in the two regions that matter to us
# (runbook Step 1.8, Step 10 line item 10; Appendix B prices it at $5–10/mo
# and calls it "the cheapest insurance you will buy").
#
# WHY IT EARNS ITS PLACE HERE SPECIFICALLY: D36 says six other IAM principals
# hold admin in this account and three unrelated products run alongside us.
# Our compensating controls (the region-guardrail policy, the explicit-Deny
# key and bucket policies) all constrain principals we created. GuardDuty is
# the only control in the repo that watches principals we did NOT create —
# it reads the CloudTrail management event stream, VPC flow logs and Route53
# DNS query logs and flags credential exfiltration, unusual API callers and
# access from anonymising infrastructure regardless of whose IAM user it is.
#
# It consumes CloudTrail's event stream directly, not our S3 bucket, so it
# costs nothing extra on top of cloudtrail.tf and works even if someone
# deletes the trail.
# --------------------------------------------------------------------------

resource "aws_guardduty_detector" "primary" {
  enable = true

  # SIX_HOURS, not FIFTEEN_MINUTES. Publishing frequency is free either way —
  # it changes only how long a non-critical finding waits before it appears in
  # EventBridge. HIGH-severity findings are published immediately regardless
  # of this setting, so the security-relevant latency is unaffected and the
  # noise floor for a pre-pilot account stays low. Move to FIFTEEN_MINUTES
  # when there is an on-call rota to receive the findings (Governance §13.2).
  finding_publishing_frequency = "SIX_HOURS"

  tags = { Component = "audit" }

  # Feature toggles (S3 Data Events, EKS Audit Logs, EBS Malware Protection,
  # RDS Login Events, Lambda Network Logs, Runtime Monitoring) are NOT declared
  # here. In provider 5.60 the inline `datasources` block is deprecated in
  # favour of separate aws_guardduty_detector_feature resources, and those do
  # not support import blocks — declaring them would put creates in the
  # adoption plan for settings that are already correct. Live state as of
  # 13 Aug 2026 is recorded in README.md; codifying it is a follow-up PR.
}

# --------------------------------------------------------------------------
# eu-west-1 — see the long-form justification on the `aws.dr` provider in
# main.tf. Short version: ADR 0007 names Ireland as the DR region, GuardDuty
# is detective-only and processes no customer documents, and eu-west-1 already
# carries this account's other workloads (D36) whether we watch it or not.
#
# The asymmetric risk is the argument. Monitoring an unused region costs a few
# dollars a month because there is almost nothing to analyse. NOT monitoring it
# means the one region where our DR copies will land, and where three other
# products already run, is the obvious place to operate unseen.
# --------------------------------------------------------------------------
resource "aws_guardduty_detector" "dr" {
  provider = aws.dr

  enable                       = true
  finding_publishing_frequency = "SIX_HOURS"

  tags = { Component = "audit" }
}

output "guardduty_detector_id" { value = aws_guardduty_detector.primary.id }
output "guardduty_dr_detector_id" { value = aws_guardduty_detector.dr.id }
