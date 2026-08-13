# ==========================================================================
# DISASTER RECOVERY — S3 cross-region replication to eu-west-1 (Dublin).
#
# Governance §17 requires cross-region backups at RPO ≤ 15 min and RTO ≤ 4 h,
# proven by a quarterly restore drill. ADR 0007 chooses the region and is the
# document that authorises this file to exist at all.
#
# ⚠ ADR 0007 AUTHORISES EXACTLY THIS AND NOTHING MORE. Read the decision
# sentence before adding a single resource under the eu_west_1 provider:
#
#   "eu-west-1 (Ireland), for backup and replication targets only. Nothing
#    PROCESSES there. No compute, no Bedrock, no Textract, no SES. The region
#    holds encrypted Postgres logical backups and replicated S3 objects, and is
#    the target of the quarterly restore drill."
#
# That distinction is the whole reason this stays a narrow exception rather
# than a hole in D30. The promise to accountants is that their clients'
# documents are PROCESSED in London; a cold encrypted copy in Dublin does not
# change where the work happens. A single Fargate task, Lambda or Textract call
# in eu-west-1 breaks that sentence and makes the DPIA wrong.
#
# It is enforced in three places, deliberately:
#   1. This comment (intent).
#   2. policies/region-guardrail.json.tftpl — `NothingProcessesInTheDrRegion`
#      denies every service except S3, KMS and STS in eu-west-1 (control).
#   3. The provider alias in main.tf carries `allowed_account_ids` and a loud
#      banner of its own (friction).
#
# ==========================================================================
# WHY THERE IS A SECOND KMS KEY, WHICH IS THE PART PEOPLE GET WRONG
#
# KMS keys are REGIONAL. The eu-west-2 documents CMK cannot encrypt an object
# stored in Dublin — not "should not", cannot; the API rejects it. So
# cross-region replication of SSE-KMS objects requires a destination key in the
# destination region, which is ADR 0007 consequence 3 verbatim: "That is a
# second key, with the same explicit-Deny policy shape as the primary (ADR
# 0008), and it must be created in the same Terraform run so it is never a
# console artefact."
#
# The practical consequence, which matters during a restore: the DR copy is
# encrypted under a DIFFERENT key from the primary. Restoring means decrypting
# with alias/nt-prod-dr, not alias/nt-prod-docs. Anyone who scripts a restore
# against the primary key's ARN will get an opaque KMS error at exactly the
# wrong moment.
#
# ==========================================================================
# COST — small today, permanent, and it grows with the corpus forever.
#
#   Replica storage (Standard-IA, eu-west-1)  ~$0.0125/GB-month
#   Inter-region transfer London → Dublin     ~$0.02/GB, once per object
#   Replication PUT requests                  ~$0.005/1,000
#   Replication Time Control (RTC)            ~$0.015/GB replicated
#   RTC CloudWatch metrics                    a few cents
#
# At pilot volume (single-digit GB) this is a few dollars a month. At 1 TB it
# is ~$13/month of storage plus a one-off ~$35 of transfer and RTC as the
# corpus lands. Cheap for what it is, and it is worth knowing that the transfer
# and RTC charges are per-object-once, not recurring.
#
# ⚠ RTC IS A DELIBERATE PURCHASE, not a default. Without it, S3 replication is
# best-effort with no published latency SLA — "usually seconds, sometimes
# hours". Governance §17's RPO ≤ 15 min is a number we have to be able to
# stand behind, and RTC is the only thing AWS sells that guarantees it (99.99%
# of objects within 15 minutes, backed by an SLA). Paying $0.015/GB to turn an
# assertion into a contractual commitment is the right trade for the one
# control that exists to survive losing a region. If it is ever removed to save
# money, Governance §17's RPO claim has to be removed with it.
# ==========================================================================

locals {
  # nt-<env>-<key>-<account_id>, the same convention modules/storage uses, with
  # `docs-dr` as the key. Written here rather than derived from the module
  # because this bucket is NOT one of the module's — it lives in another region
  # under another provider — and main.tf's region-guardrail policy needs the
  # name at render time.
  dr_bucket_name = "nt-${local.env}-docs-dr-${local.account_id}"
}

# --------------------------------------------------------------------------
# The destination CMK, in eu-west-1.
#
# Same explicit-Deny shape as every other Neoting key: root administers,
# `role/nt-*` may use, everyone else is denied outright. The one addition
# against the secrets key is the AWS-service exemption
# (`aws:PrincipalIsAWSService`), which S3 replication needs in some code paths
# even though the replication role is the principal on the wire.
# --------------------------------------------------------------------------
resource "aws_kms_key" "dr" {
  provider = aws.eu_west_1

  description              = "Neoting production - DR replica encryption (ADR 0007, ${local.dr_region} backup target only)"
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation      = true

  # 30 days, the maximum. Deleting this key does not delete the replica — it
  # makes the entire disaster-recovery copy permanently unreadable, silently,
  # while the objects still appear in the bucket listing. The window is the
  # only undo.
  deletion_window_in_days = 30

  policy = templatefile("${path.module}/policies/kms-dr.json.tftpl", {
    account_id = local.account_id
    env        = local.env
  })

  tags = { DataClass = "customer-document" }
}

resource "aws_kms_alias" "dr" {
  provider = aws.eu_west_1

  name          = "alias/nt-${local.env}-dr"
  target_key_id = aws_kms_key.dr.key_id
}

# --------------------------------------------------------------------------
# The destination bucket.
#
# Versioning is not optional: S3 replication requires it on BOTH ends, and
# without it the replication configuration is rejected at apply.
#
# The bucket policy is rendered from the SHARED template
# (modules/storage/policies/bucket.json.tftpl), by path, so the replica in
# Dublin carries byte-identical TLS-only and nothing-outside-`role/nt-*` rules
# as the primary in London. Copying the JSON here instead would be the exact
# drift the storage module's own comment warns about: "two copies of a
# role/nt-* deny guard is precisely the drift that silently opens a bucket, and
# it would be invisible in review because both files would look correct on
# their own."
#
# No cross-account statement is needed — source and destination are the same
# account (D36), which is one of the very few things the shared account makes
# simpler. When the dedicated accounts land, THIS is the resource that grows a
# cross-account policy and an ownership override.
# --------------------------------------------------------------------------
resource "aws_s3_bucket" "dr" {
  provider = aws.eu_west_1

  bucket = local.dr_bucket_name

  tags = {
    DataClass = "customer-document"
    Component = "dr"
  }
}

resource "aws_s3_bucket_versioning" "dr" {
  provider = aws.eu_west_1

  bucket = aws_s3_bucket.dr.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "dr" {
  provider = aws.eu_west_1

  bucket                  = aws_s3_bucket.dr.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "dr" {
  provider = aws.eu_west_1

  bucket = aws_s3_bucket.dr.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.dr.key_id
    }
    # Cuts KMS request charges by up to ~99%. Replication writes one object per
    # source object, so without this the KMS request bill scales with document
    # count rather than with data volume.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_policy" "dr" {
  provider = aws.eu_west_1

  bucket = aws_s3_bucket.dr.id

  policy = templatefile(local.shared_bucket_policy_template, {
    bucket     = local.dr_bucket_name
    account_id = local.account_id
  })
}

# --------------------------------------------------------------------------
# DR bucket lifecycle — deliberately NOT the same as the source.
#
# The source transitions to Standard-IA at 90 days (lifecycle.tf). The replica
# is written directly into Standard-IA by the replication rule below, because
# it is never read except during a drill or a disaster — there is no "hot"
# period to wait out.
#
# NO EXPIRATION, matching the source: Governance §12.2's six-year retention
# applies to the copy as much as to the original, and a DR copy that ages out
# before the primary is a DR copy that cannot restore the primary.
#
# GLACIER_IR would be ~50% cheaper again than Standard-IA with millisecond
# retrieval, which fits RTO ≤ 4 h comfortably. It is NOT used yet because its
# 90-day minimum storage duration and per-GB retrieval charge want measuring
# against a real corpus first, and because Replication Time Control's
# interaction with it should be verified rather than assumed. Revisit at the
# first quarterly drill, when there is both a real corpus and a real restore to
# measure.
# --------------------------------------------------------------------------
resource "aws_s3_bucket_lifecycle_configuration" "dr" {
  provider = aws.eu_west_1

  bucket = aws_s3_bucket.dr.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ==========================================================================
# The replication role.
#
# ⚠ NAMED nt-prod-s3-replication, AND THE `nt-` PREFIX IS LOAD-BEARING. Both
# bucket policies and both key policies deny every principal whose ARN does not
# match `arn:aws:iam::<account>:role/nt-*`. A replication role named anything
# else is not "slightly less privileged" — it is silently denied at the
# resource layer, replication fails with no error surfaced anywhere the team
# looks, and the first symptom is an empty DR bucket discovered during a drill.
# ==========================================================================
resource "aws_iam_role" "replication" {
  name        = "nt-${local.env}-s3-replication"
  description = "S3 cross-region replication, docs bucket -> ${local.dr_region} (ADR 0007, Gov §17)"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
      Action    = "sts:AssumeRole"

      # Confused-deputy guard: only S3 acting on behalf of THIS account may
      # assume it. Without it, S3 in any account could in principle be induced
      # to use this role.
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

# --------------------------------------------------------------------------
# ⚠ THE REGION GUARDRAIL IS DELIBERATELY *NOT* ATTACHED TO THIS ROLE, which is
# the opposite of what nt-prod-app and nt-prod-ci-deploy get. The reasoning,
# because "you forgot the guardrail" is the obvious review comment:
#
# The guardrail is a broad Deny whose job is to stop a principal with WIDE
# permissions (PowerUser, or an application role) creating or touching things
# outside eu-west-2. This role's inline policy below is already narrower than
# the guardrail could ever be: five statements, resource-scoped to exactly two
# buckets and two keys, with kms:ViaService and encryption-context conditions.
# There is nothing for the guardrail to subtract.
#
# What attaching it WOULD add is a silent-failure mode. An explicit Deny sits
# above every Allow, so any imprecision in the ADR 0007 carve-out — a missing
# action, a resource ARN that does not match — stops replication dead, and S3
# replication fails QUIETLY: objects simply stay in the FAILED state and
# nothing pages anyone (observability.tf, which would alarm on
# OperationsFailedReplication, is not built).
#
# Trading a guarantee we already have for a new way to lose the DR copy is a
# bad trade. Revisit if this role ever grows a broad grant.
# --------------------------------------------------------------------------
resource "aws_iam_role_policy" "replication" {
  name = "replicate-docs-to-dr"
  role = aws_iam_role.replication.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadSourceBucketConfiguration"
        Effect   = "Allow"
        Action   = ["s3:GetReplicationConfiguration", "s3:ListBucket"]
        Resource = "arn:aws:s3:::${local.bucket_names["docs"]}"
      },
      {
        # GetObjectVersionForReplication is a distinct action from GetObject
        # and is the one replication actually calls. Granting GetObject instead
        # is the classic mistake — it looks right and replicates nothing.
        Sid    = "ReadSourceObjectVersions"
        Effect = "Allow"
        Action = [
          "s3:GetObjectVersionForReplication",
          "s3:GetObjectVersionAcl",
          "s3:GetObjectVersionTagging",
        ]
        Resource = "arn:aws:s3:::${local.bucket_names["docs"]}/*"
      },
      {
        Sid    = "WriteReplicas"
        Effect = "Allow"
        Action = [
          "s3:ReplicateObject",
          "s3:ReplicateDelete",
          "s3:ReplicateTags",
        ]
        Resource = "${aws_s3_bucket.dr.arn}/*"
      },
      {
        # Decrypt in LONDON, under the documents CMK.
        #
        # kms:ViaService pins this to S3 — the role cannot use the documents
        # key for anything else even if it were compromised. The encryption
        # context, which S3 sets itself, pins it to THIS bucket: the same CMK
        # also protects `exports`, and without the context condition this grant
        # would decrypt those too.
        #
        # ⚠ BOTH ARN FORMS ARE LISTED AND THE SECOND ONE IS THE ONE THAT
        # ACTUALLY MATCHES TODAY. S3 normally sets the encryption context to
        # the OBJECT ARN (`…:::bucket/key`) — but when S3 Bucket Keys are
        # enabled it sets the BUCKET ARN (`…:::bucket`) instead, because the
        # data key is derived once per bucket rather than once per object. The
        # storage module turns Bucket Keys on for every aws:kms bucket (it cuts
        # KMS request charges by up to ~99%), so the docs bucket is in the
        # second case.
        #
        # A policy listing only the `/…` form looks obviously correct, passes
        # review, and denies every replication decrypt — and S3 replication
        # fails SILENTLY, so the symptom is an empty DR bucket discovered at a
        # drill months later. StringLike ORs the list, so listing both is
        # correct now and stays correct if Bucket Keys are ever turned off.
        Sid      = "DecryptSourceObjects"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = module.storage.kms_key_arn
        Condition = {
          StringLike = {
            "kms:ViaService" = "s3.${local.region}.amazonaws.com"
            "kms:EncryptionContext:aws:s3:arn" = [
              "arn:aws:s3:::${local.bucket_names["docs"]}",
              "arn:aws:s3:::${local.bucket_names["docs"]}/*",
            ]
          }
        }
      },
      {
        # Encrypt in DUBLIN, under the DR CMK. Different key, different region,
        # different ViaService value — this pair of statements is the whole
        # "KMS keys are regional" consequence expressed in IAM.
        #
        # Both ARN forms again, for the same S3-Bucket-Keys reason as above:
        # the DR bucket also has bucket_key_enabled = true, so the context on
        # the GenerateDataKey call is the bucket ARN.
        Sid      = "EncryptReplicas"
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.dr.arn
        Condition = {
          StringLike = {
            "kms:ViaService" = "s3.${local.dr_region}.amazonaws.com"
            "kms:EncryptionContext:aws:s3:arn" = [
              aws_s3_bucket.dr.arn,
              "${aws_s3_bucket.dr.arn}/*",
            ]
          }
        }
      },
    ]
  })
}

# ==========================================================================
# The replication rule itself.
#
# ⚠ THREE THINGS ABOUT THIS THAT SURPRISE PEOPLE, ALL OF THEM OPERATIONAL:
#
# 1. REPLICATION IS NOT RETROACTIVE. Only object versions written AFTER this
#    configuration exists are replicated. Anything already in the docs bucket
#    stays only in London until an S3 Batch Replication job copies it — a
#    separate, manually-launched job that Terraform cannot express. Prod is
#    empty today, so applying this NOW rather than after the first upload is
#    what makes that a non-issue. If prod ever holds documents before this
#    lands, a batch job is mandatory and its completion is the acceptance test.
#
# 2. DELETE MARKERS ARE NOT REPLICATED, ON PURPOSE. With
#    delete_marker_replication disabled, deleting an object in London does NOT
#    delete it in Dublin. That is the correct behaviour for this data:
#    Governance §12.2 keeps client documents six years with "deletion only on
#    explicit, audited client instruction", and the failure mode DR exists to
#    survive includes a bug or an operator that deletes things. A DR copy that
#    faithfully mirrors your mistakes is not a DR copy.
#    The cost: a genuine, audited deletion has to be applied to Dublin
#    separately, or the "deleted" document still exists. That is a GDPR
#    erasure-request obligation with a manual step in it — record it in the
#    retention runbook rather than discovering it during a subject request.
#
# 3. IT ONLY REPLICATES THE DOCS BUCKET. `receipts` is transient (30-day
#    expiry, AES256) and `exports` is regenerable from docs, so neither earns
#    the transfer cost. If that changes, add a second rule — not a second
#    bucket-wide configuration; S3 allows exactly one replication
#    configuration per bucket and a second resource silently replaces the
#    first.
# ==========================================================================
resource "aws_s3_bucket_replication_configuration" "docs" {
  role   = aws_iam_role.replication.arn
  bucket = module.storage.bucket_ids["docs"]

  rule {
    id       = "docs-to-${local.dr_region}"
    status   = "Enabled"
    priority = 0

    # Whole bucket. A prefix filter here would be a residency decision in
    # disguise — "these documents are protected against a region failure and
    # those are not" — and nobody has made that decision.
    filter {}

    delete_marker_replication {
      status = "Disabled" # see note 2 above; this is not a default, it is a choice
    }

    # Without this, SSE-KMS objects are SKIPPED SILENTLY. The docs bucket's
    # default encryption is aws:kms (main.tf), so every object in it is
    # SSE-KMS, so omitting this block replicates precisely nothing while the
    # configuration reports itself as Enabled. This is the single most common
    # way a cross-region replication setup looks correct and does nothing.
    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }

    destination {
      bucket = aws_s3_bucket.dr.arn

      # Written straight into Standard-IA — the replica is never read outside a
      # drill or a disaster, so there is no hot period to pay Standard rates
      # for. See the lifecycle note above for why not GLACIER_IR yet.
      storage_class = "STANDARD_IA"

      # The regional key. This is the line that makes the whole second-key
      # exercise necessary.
      encryption_configuration {
        replica_kms_key_id = aws_kms_key.dr.arn
      }

      # Replication Time Control: 99.99% of objects replicated within 15
      # minutes, with an SLA. This is what makes Governance §17's "RPO ≤ 15
      # min" a commitment rather than a hope. ~$0.015/GB — see the cost banner.
      replication_time {
        status = "Enabled"

        time {
          minutes = 15
        }
      }

      # RTC REQUIRES metrics to be enabled; S3 rejects the configuration
      # otherwise. It is also the only way anyone finds out replication has
      # stalled: the OperationsFailedReplication and
      # ReplicationLatency metrics are what an alarm would watch.
      # ⚠ NO ALARM EXISTS YET (observability.tf is not built). Until it does,
      # "is DR working?" is a question someone has to go and ask a dashboard,
      # which means the honest answer is "we would find out at the drill".
      metrics {
        status = "Enabled"

        event_threshold {
          minutes = 15
        }
      }
    }
  }

  # The source bucket must have versioning enabled before a replication
  # configuration is accepted, and the module owns that resource. Terraform
  # infers the bucket dependency from bucket_ids but not the VERSIONING one, so
  # without this the first apply fails intermittently with
  # InvalidRequest: Versioning must be 'Enabled' on the bucket.
  depends_on = [module.storage]
}

# --------------------------------------------------------------------------
output "dr_region" {
  value       = local.dr_region
  description = "ADR 0007. The only non-UK location in the product — if a second one ever appears, that is a versioned amendment to D30, not a config change."
}

output "dr_bucket_name" { value = aws_s3_bucket.dr.id }

output "dr_kms_key_arn" {
  value       = aws_kms_key.dr.arn
  description = "The DR replica is encrypted under THIS key, not the primary documents key. A restore script that names the primary key will fail."
}

output "replication_role_arn" { value = aws_iam_role.replication.arn }
