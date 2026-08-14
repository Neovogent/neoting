# --------------------------------------------------------------------------
# S3 lifecycle (runbook §6.2, Governance §12.2 retention schedule).
#
# Before this file, all three buckets had versioning Enabled and no lifecycle
# rule at all — so every object, every noncurrent version and every abandoned
# multipart upload accumulated forever. At document volume that is a cost leak
# that compounds, and abandoned multiparts are the version of it nobody ever
# looks at because they are invisible in the console object list.
#
# Retention differs per bucket because the DATA differs, not because of cost:
#
#   docs      Client financial documents. Governance §12.2 says SIX YEARS,
#             "deletion only on explicit, audited client instruction". So there
#             is deliberately NO expiration rule here — a lifecycle rule that
#             quietly deleted a client's evidence would be a compliance
#             incident, not a saving. Retention is enforced by the application's
#             scheduled jobs, which can honour a legal hold; S3 cannot.
#   receipts  Raw inbound email. Transient — once ingested, the Document row and
#             the docs bucket hold the evidence. Runbook §6.2: 30-day expiry.
#   exports   Generated ZIPs and CSVs. Fully regenerable from docs. 30 days.
# --------------------------------------------------------------------------

resource "aws_s3_bucket_lifecycle_configuration" "docs" {
  bucket = module.storage.bucket_ids["docs"]

  # Applies to every bucket below too: a multipart upload that never completes
  # is billed indefinitely and is invisible unless you go looking for it.
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # Cold storage for evidence nobody is actively reviewing. Documents are
  # written once and read rarely after the month they are published, which is
  # exactly the Standard-IA access pattern.
  #
  # CAVEAT worth knowing before reading the savings optimistically: objects
  # under 128 KB are billed at 128 KB in Standard-IA, so tiny receipts save
  # nothing and can cost slightly more. Client-side compression targets ~3 MB
  # photos (SoT §4 Stage 1), so the bulk of the corpus is comfortably above the
  # threshold — but re-measure against a real bill before assuming the win.
  rule {
    id     = "documents-to-infrequent-access"
    status = "Enabled"

    filter {
      prefix = "w/"
    }

    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }
  }

  # NOTE: no noncurrent-version expiration on this bucket, on purpose.
  # Originals are immutable and versioning is how that is enforced (SoT Stage
  # 8.4). If a bad write ever overwrites an original, the previous VERSION is
  # the original — expiring noncurrent versions on a schedule would destroy the
  # evidence in exactly the case the versioning exists to protect.
}

resource "aws_s3_bucket_lifecycle_configuration" "receipts" {
  bucket = module.storage.bucket_ids["receipts"]

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # 30 days is a deliberate over-provision on top of the p95 < 5 min extraction
  # target (SoT §4 Stage 2): it leaves a month to replay a failed ingest from
  # the raw message before the source disappears. If ingest is broken for
  # longer than a month, the missing raw email is not the biggest problem.
  rule {
    id     = "expire-raw-inbound-mail"
    status = "Enabled"

    filter {
      prefix = "inbound/"
    }

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }

  # DMARC aggregate reports (email.tf). Longer than raw inbound mail on purpose:
  # these exist to answer "are reports clean enough to move to p=quarantine",
  # and that judgement wants a run of weeks, not days. A prefix with no rule at
  # all would accumulate forever, which is how a transient bucket becomes a
  # permanent one.
  rule {
    id     = "expire-dmarc-reports"
    status = "Enabled"

    filter {
      prefix = "dmarc/"
    }

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "exports" {
  bucket = module.storage.bucket_ids["exports"]

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # Regenerable by definition, and the download-centre link is short-lived
  # anyway. 30 days per runbook §6.2.
  #
  # Deliberately NOT shorter: D32 makes whole-firm export a self-serve
  # offboarding right, and an export that expires before a departing customer
  # has collected it turns "offboarding is never hostage-taking" into exactly
  # that.
  rule {
    id     = "expire-generated-exports"
    status = "Enabled"

    filter {}

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}
