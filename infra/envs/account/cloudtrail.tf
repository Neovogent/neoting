# --------------------------------------------------------------------------
# CloudTrail — the account's audit baseline (runbook Step 1.8, Step 10 line
# item 10 "Org CloudTrail + GuardDuty + Access Analyzer: audit baseline").
#
# This account had NO CloudTrail at all before 13 Aug 2026. That is load
# bearing for the shared-account argument in infra/README.md: six other IAM
# principals hold admin here, and the compensation offered for that is
# "a determined admin can still rewrite those policies — but that act is now
# recorded by CloudTrail". Without this trail, that sentence is false.
#
# NOT an organization trail. The org is CONSOLIDATED_BILLING (see D36 and the
# region-guardrail note in envs/staging/main.tf), which means we are not the
# payer/management account and `IsOrganizationTrail = true` is not available
# to us. Runbook Step 1.8 describes the org trail that lands when the
# dedicated member accounts arrive; this is the single-account stand-in.
# --------------------------------------------------------------------------

resource "aws_cloudtrail" "audit" {
  name           = local.trail_name
  s3_bucket_name = aws_s3_bucket.cloudtrail.id

  # Multi-region on purpose, and it is free. A single-region trail records
  # nothing about activity in the 20+ regions we do not use — which is exactly
  # where an attacker with stolen credentials would mine crypto or stage data.
  # D30 keeps our WORKLOADS in London; it does not stop anyone else's API
  # calls from landing elsewhere, and we need to see those.
  is_multi_region_trail = true

  # IAM, STS, CloudFront, Route53 and Organizations are global services whose
  # events are emitted only in us-east-1. Without this, every IAM change in
  # the account — the single most security-relevant event class we have — is
  # invisible. Also free.
  include_global_service_events = true

  # Digest files every hour, hash-chained, signed with an AWS private key.
  # This is what turns "the log says X" into "the log has not been edited to
  # say X", which is the whole point of an audit trail in an account where
  # other people hold admin (D36). Costs nothing.
  enable_log_file_validation = true

  is_organization_trail = false
  enable_logging        = true

  # --------------------------------------------------------------------------
  # DELIBERATELY ABSENT, and each absence is a decision, not an oversight:
  #
  # * event_selector / advanced_event_selector — management events only. S3
  #   and Lambda DATA events cost $0.10 per 100,000 events, and a document
  #   pipeline that writes every page, thumbnail and export to S3 generates
  #   them by the million. Runbook §4 asks for "access logging OR CloudTrail
  #   data events" on the document buckets; that is a per-bucket decision for
  #   envs/staging, priced against S3 server access logs, not a blanket
  #   account-wide switch. Turning data events on here would bill for every
  #   object in every bucket of all four products sharing this account (D36).
  #
  # * insight_selector — CloudTrail Insights is $0.35 per 100,000 write
  #   management events analysed, and it needs ~7 days of baseline before it
  #   says anything useful. Not worth it at pre-pilot volume. Revisit when
  #   prod carries real traffic.
  #
  # * kms_key_id — logs inherit the bucket's SSE-S3 default (see below). A
  #   CMK here would be a genuine improvement in a shared account, because the
  #   key policy could deny the other five admins; it is tracked as a gap in
  #   README.md rather than smuggled into an adoption PR.
  #
  # * cloud_watch_logs_group_arn — CloudWatch Logs ingestion is $0.57/GB in
  #   eu-west-2 versus $0.023/GB-month for S3. Real-time alerting on trail
  #   events belongs on EventBridge rules, which read the event stream
  #   directly and cost nothing.
  # --------------------------------------------------------------------------

  # CloudTrail test-writes to the bucket when the trail is created or updated
  # and fails hard if it cannot. Same ordering hazard as the SES receipt rule
  # in envs/staging/email.tf.
  depends_on = [aws_s3_bucket_policy.cloudtrail]
}

# --------------------------------------------------------------------------
# The trail's destination bucket.
#
# Adopted, not created — see local.cloudtrail_bucket for why the name does not
# match the nt-* convention.
# --------------------------------------------------------------------------

resource "aws_s3_bucket" "cloudtrail" {
  bucket = local.cloudtrail_bucket

  # Audit logs, not customer content: no personal data from client documents
  # ever lands here, only AWS API metadata. Tagged distinctly so the
  # Governance §12.2 retention job does not treat it as a document bucket and
  # so D36 per-tag cost attribution can see it.
  tags = {
    DataClass = "audit-log"
    Component = "audit"
  }
}

# Versioning on an audit bucket is not about rollback — it is about making
# "delete the evidence" a two-step operation that CloudTrail itself records,
# rather than a one-line DeleteObject.
resource "aws_s3_bucket_versioning" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  bucket                  = aws_s3_bucket.cloudtrail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3 (AES256), not SSE-KMS. CloudTrail writes a log file every ~5 minutes
# per region across 20+ regions plus an hourly digest; on SSE-KMS every one of
# those is a billable KMS request, and each read for an investigation is
# another. Bucket keys cut that by ~99% but SSE-S3 cuts it to zero, and the
# threat this bucket faces is deletion and tampering, not disk theft from an
# AWS datacentre. Log-file validation is the real integrity control here.
#
# ⚠ The live bucket ALSO blocks SSE-C uploads (BlockedEncryptionTypes). AWS
# provider 5.60 has no schema for that field, so Terraform neither reads nor
# writes it — harmless on a no-op plan, but any apply that rewrites this
# resource will silently drop the SSE-C block. Re-check with
# `aws s3api get-bucket-encryption` after the first apply.
resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# --------------------------------------------------------------------------
# Bucket policy.
#
# The two AWSCloudTrail* statements are the shape AWS requires; both are
# constrained by aws:SourceArn to THIS trail. Without that condition any
# CloudTrail in any AWS account could be pointed at this bucket — the
# confused-deputy problem, and a real one in a shared account.
#
# DenyInsecureTransport is ours, matching the TLS-only policy runbook §4
# requires on every bucket.
# --------------------------------------------------------------------------
resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSCloudTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = "arn:aws:s3:::${local.cloudtrail_bucket}"
        Condition = {
          StringEquals = {
            "aws:SourceArn" = "arn:aws:cloudtrail:${local.region}:${local.account_id}:trail/${local.trail_name}"
          }
        }
      },
      {
        Sid       = "AWSCloudTrailWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        # Pinned to our own AWSLogs/<account>/ prefix: another account's trail
        # cannot write here even if it somehow satisfied the condition above.
        Resource = "arn:aws:s3:::${local.cloudtrail_bucket}/AWSLogs/${local.account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"  = "bucket-owner-full-control"
            "aws:SourceArn" = "arn:aws:cloudtrail:${local.region}:${local.account_id}:trail/${local.trail_name}"
          }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          "arn:aws:s3:::${local.cloudtrail_bucket}",
          "arn:aws:s3:::${local.cloudtrail_bucket}/*",
        ]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
    ]
  })
}

output "cloudtrail_arn" { value = aws_cloudtrail.audit.arn }
output "cloudtrail_bucket" { value = aws_s3_bucket.cloudtrail.id }
