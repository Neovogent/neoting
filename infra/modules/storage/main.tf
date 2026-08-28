# --------------------------------------------------------------------------
# Document storage: one customer-managed KMS key and the buckets it protects.
#
# The two are in one module on purpose. A bucket whose default encryption
# points at a key with a different policy is the failure mode this pairing
# prevents: the deny guard in the key policy and the deny guard in the bucket
# policy must agree on who "we" are, and they only reliably agree if they are
# rendered from the same account_id in the same place.
# --------------------------------------------------------------------------

locals {
  bucket_names = { for k, v in var.buckets : k => "nt-${var.env}-${k}-${var.account_id}" }

  kms_key_description = coalesce(
    var.kms_key_description,
    "Neoting ${var.env} - documents, receipts, exports (D30 ${var.region})",
  )
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
  description              = local.kms_key_description
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation      = var.kms_enable_key_rotation
  deletion_window_in_days  = var.kms_deletion_window_in_days

  policy = templatefile("${path.module}/policies/kms-docs.json.tftpl", {
    account_id = var.account_id
    env        = var.env
  })
}

resource "aws_kms_alias" "docs" {
  name          = "alias/nt-${var.env}-${var.kms_alias_suffix}"
  target_key_id = aws_kms_key.docs.key_id
}

# --------------------------------------------------------------------------
# S3 — originals are immutable (versioned); isolation by explicit deny.
#
# sse is per-bucket rather than a module-wide default because of a real
# constraint, not a preference: the receipts bucket must be AES256, NOT
# aws:kms. SES validates a receipt rule by test-writing to the bucket, and that
# write fails against a customer-managed-key default ("InvalidS3Configuration:
# Kms key is not available") no matter how the key policy is written — verified
# empirically 13 Aug 2026.
#
# ⚠ AND NAMING THE KEY ON THE SES ACTION DOES NOT RESCUE IT. That makes SES
# encrypt CLIENT-side with the S3 encryption client — envelope ciphertext only
# the Java and Ruby SDKs can decrypt, and this repo is TypeScript. Objects in
# inbound/ therefore land under the bucket's AES256 default. They are
# transient (the caller's lifecycle rules expire them at 30 days) and the
# extracted document lands in the docs bucket under the CMK. ADR 0002 records
# the trade.
# --------------------------------------------------------------------------
resource "aws_s3_bucket" "this" {
  for_each = var.buckets
  bucket   = local.bucket_names[each.key]

  tags = { DataClass = each.value.data_class }
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = var.buckets
  bucket   = aws_s3_bucket.this[each.key].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = var.buckets
  bucket                  = aws_s3_bucket.this[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = var.buckets
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

# --------------------------------------------------------------------------
# CORS — what makes a presigned browser upload possible at all.
#
# ⚠ THE DOCS BUCKET HAD NONE, AND SO NO BROWSER UPLOAD ON STAGING HAD EVER
# WORKED. The journey is: the API mints a presigned PUT, the browser sends it
# to S3 directly (the bytes must never transit our API), and a cross-origin PUT
# with a `Content-Type` header is NOT a simple request — the browser first
# sends an `OPTIONS` preflight. A bucket with no CORS configuration answers
# that preflight `403`, so the PUT is never attempted.
#
# What made it invisible for so long: every LOCAL environment uploads to MinIO,
# which allows any origin by default, so the whole path works on a developer
# machine and fails only where it is deployed. And the failure surfaces in the
# browser as `TypeError: Failed to fetch` with no status and nothing in the
# API's logs, because the request never reached us — it reads exactly like a
# dropped connection.
#
# The grant is deliberately narrow:
#   PUT   the presigned upload, the only write a browser makes;
#   GET   the presigned read behind "open the original".
# No POST, no DELETE, no HEAD. `content-type` is the ONLY header allowed
# because it is the only one the API signs into the intent
# (`s3-document-store.ts`), and a preflight fails closed on anything else.
#
# `allowed_origins` never contains `*`: these are presigned URLs for a client's
# financial records, and a wildcard would let any page a user has open drive an
# upload with a URL it had somehow obtained.
# --------------------------------------------------------------------------
resource "aws_s3_bucket_cors_configuration" "this" {
  for_each = { for name, cfg in var.buckets : name => cfg if length(cfg.cors_origins) > 0 }
  bucket   = aws_s3_bucket.this[each.key].id

  cors_rule {
    allowed_methods = ["PUT", "GET"]
    allowed_origins = each.value.cors_origins
    allowed_headers = ["content-type"]
    # So a caller can read the object's ETag off its own upload response. The
    # completion call sends a SHA-256 it computed itself, so nothing depends on
    # this — it is here to make a failed upload diagnosable.
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_policy" "this" {
  for_each = var.buckets
  bucket   = aws_s3_bucket.this[each.key].id

  # Default: deny insecure transport, deny every principal outside role/nt-*.
  # A bucket that additionally grants a service principal (receipts, where SES
  # delivers inbound mail into inbound/) names its own template.
  policy = templatefile("${path.module}/policies/${each.value.policy_template}", {
    bucket     = local.bucket_names[each.key]
    account_id = var.account_id
  })
}
