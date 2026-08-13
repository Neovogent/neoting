# --------------------------------------------------------------------------
# ClamAV scanning path (runbook Step 8 · Kickoff 3.8 · Governance §11.4 ·
# SoT Stage 1)
#
# THIS IS A SECURITY CONTROL, NOT A FEATURE. Governance §11.4 fixes the
# sanitisation order — magic-byte sniff → extension allowlist → size cap →
# **virus scan** → EXIF/HEIC normalisation → PDF safety → ZIP explode with caps
# — and every upload channel in the product (photo, email, WhatsApp, portal)
# funnels through it. SoT Stage 1: "failures quarantine with an operator alert
# and a plain-language message to the submitter."
#
# THE SHAPE (runbook Step 8, verbatim):
#   S3 docs/receipts PutObject → EventBridge → SQS → ECS Fargate scanner
#   service (container with clamd, kept warm) → tags the object
#   av-status=clean|infected → clean objects emit the domain event that starts
#   extraction; infected objects go to nt-<env>-quarantine-<acct> and raise an
#   operator alert.
#
# WHAT IS INERT TODAY AND WHY, read this before "fixing" anything:
#
#   * There is no application code and no image in ECR (13 Aug 2026). The
#     scanner is OUR code — it consumes SQS, drives clamd, writes the tag and
#     copies to quarantine — so no public ClamAV image can stand in for it. The
#     upstream `clamav/clamav` container is a virus scanner, not a scanner
#     *service*: it knows nothing about S3, our object tags, or this queue.
#     Substituting it would produce a task that starts, idles, and scans
#     nothing, which is worse than an obviously-absent one.
#   * Therefore: the ECR repo, the placeholder `bootstrap` tag, and
#     `desired_count = 0` are the same honest pattern services.tf uses. The
#     scanner service costs $0 until someone pushes an image and raises the
#     count.
#   * The freshclam schedule ships **DISABLED** for the same reason. An enabled
#     schedule against a missing image would RunTask every four hours forever,
#     each one dying on CannotPullContainerError — a stream of failed tasks
#     that teaches everyone to ignore the ECS console.
#
# EVERYTHING UPSTREAM OF THE SCANNER IS LIVE FROM THE APPLY. The bucket
# notifications, EventBridge rule, queues and alarms are real: objects landing
# in docs/ or receipts/ start queueing immediately. That is deliberate — the
# queue-age alarm below is what tells you the scanner is not running, and it is
# telling the truth when it does.
#
# THE OTHER HALF OF STEP 8 IS APPLICATION CODE, NOT INFRASTRUCTURE — see the
# WORKER-SIDE CONTRACT block near the foot of this file. Infrastructure that
# tags objects is worthless if the worker reads them anyway.
# --------------------------------------------------------------------------

locals {
  # No image exists in ECR. Same placeholder convention as services.tf: CI
  # registers revisions pinned to the git SHA, and `task_definition` is in
  # ignore_changes on the service so Terraform never rolls a deploy back.
  clamav_image_tag = "bootstrap"

  # Bucket names built by hand rather than added to main.tf's local.buckets,
  # because main.tf is another lane's file. Same
  # nt-<env>-<purpose>-<account-id> shape (runbook §0.2).
  quarantine_bucket = "nt-${local.env}-quarantine-${local.account_id}"
  avdefs_bucket     = "nt-${local.env}-avdefs-${local.account_id}"

  # The private prefix scanner tasks pull signatures from (runbook Step 8).
  av_signature_prefix = "signatures/"

  # VISIBILITY TIMEOUT — the number most likely to be wrong, so here is the
  # budget it comes from. If the message becomes visible again while a scan is
  # still running, a second task picks up the same object: double the Fargate
  # cost, double the S3 GET, and two racing PutObjectTagging calls on one
  # version.
  #
  #   S3 GET of a 100 MB upload (gateway endpoint, in-region)     ~10 s
  #   clamd scan of 100 MB incl. archive recursion, p99          ~120 s
  #   PutObjectTagging + CopyObject to quarantine on a hit        ~10 s
  #   ------------------------------------------------------------------
  #   worst case observed shape                                  ~140 s
  #
  # 600 s is ~4x that. It is NOT sized for "any file": if the per-channel size
  # cap (Gov §11.4) is ever raised above 100 MB, this number moves in the same
  # PR. For anything genuinely long the scanner must extend its own lease with
  # ChangeMessageVisibility — which is why that action is in the task role.
  av_visibility_timeout = 600

  # COST DECISION — memory is the binding constraint, not CPU, and it is the
  # whole reason this task is not cheap.
  #
  # clamd loads the entire signature database into resident memory at startup:
  # main.cvd + daily.cvd + bytecode is ~1.2–2.0 GB RSS with current
  # definitions, and it grows every year. ClamAV's own guidance is at least
  # 3 GB for a clamd host. 4096 MB is 3 GB plus headroom for the scan itself.
  #
  # ⚠ DO NOT TRIM THIS TO SAVE $4/MONTH. Below ~3 GB, clamd fails during
  # database load and the container is OOM-killed before it ever logs anything
  # useful — it presents as "the image is broken", and it is the single most
  # common way ClamAV-on-Fargate goes wrong.
  #
  # 0.5 vCPU is the deliberate other half of the trade: scanning is CPU-bound,
  # so half a core makes a 100 MB archive slower, and the queue is what absorbs
  # that. If scan p95 ever approaches the visibility timeout above, raise CPU
  # first — 1024 CPU is +$13/mo on-demand, +$4/mo on Spot.
  #
  # At eu-west-2 ARM64 rates ($0.03725/vCPU-hr, $0.00409/GB-hr):
  #   0.5 vCPU + 4 GB ≈ $0.0350/hr ≈ $25.50/mo on-demand, ≈ $7.70/mo on Spot.
  clamav_task_size = { cpu = 512, memory = 4096 }

  # freshclam downloads ~250 MB and writes it to S3. It never loads the
  # database, so it needs a fraction of the scanner's memory. Runs ~2 min,
  # 6 times a day: ~$0.08/month.
  freshclam_task_size = { cpu = 256, memory = 1024 }

  # ⚠ THE QUEUE NAME IS A LOCAL BECAUSE OF A TERRAFORM CYCLE, not for tidiness.
  # The scan queue's redrive_policy names the DLQ, and the DLQ's
  # redrive_allow_policy names the scan queue: referencing both as resource
  # attributes is a dependency cycle Terraform refuses to plan
  # ("Cycle: aws_sqs_queue.av_scan_dlq, aws_sqs_queue.av_scan"). One side has
  # to be a constructed ARN, and the DLQ is the right side to construct
  # because it is the one whose grant is a guard rather than a wiring.
  #
  # The cost of that: renaming the scan queue means changing it in TWO places.
  # Both are here.
  av_scan_queue_name = "nt-${local.env}-av-scan"
  av_scan_queue_arn  = "arn:aws:sqs:${local.region}:${local.account_id}:nt-${local.env}-av-scan"

  # The two buckets whose PutObjects must be scanned. exports is deliberately
  # absent: nothing external writes to it — the application generates its
  # contents from already-scanned documents (runbook §6.2 asks for exports to
  # be "virus-scanned before download link issue", which is a re-scan of our
  # own output and belongs with the export job, not on an upload trigger).
  av_scanned_buckets = toset(["docs", "receipts"])
}

# ==========================================================================
# 1. THE QUARANTINE BUCKET
#
# Runbook §6.2: "nt-<env>-quarantine-<acct> · ClamAV failures · Restricted
# read; alert on put."
#
# THE INVARIANT THAT MAKES THIS BUCKET USEFUL: every object in it is malware.
# Nothing else is ever written here — not logs, not signature databases, not
# scan reports. That is what lets "any object exists" and "an object was
# written" both be alarms rather than noise, and it is why the AV signature
# database lives in its own bucket below instead of sharing a prefix here.
# ==========================================================================

resource "aws_s3_bucket" "quarantine" {
  bucket = local.quarantine_bucket

  tags = {
    DataClass = "customer-document" # it arrived as a client's upload; being infected does not change that
    Component = "clamav"
  }
}

# Versioned like the document buckets, for a different reason: this is incident
# evidence. An overwrite that destroyed the sample would destroy the only copy
# of what was actually uploaded.
resource "aws_s3_bucket_versioning" "quarantine" {
  bucket = aws_s3_bucket.quarantine.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "quarantine" {
  bucket                  = aws_s3_bucket.quarantine.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "quarantine" {
  bucket = aws_s3_bucket.quarantine.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = module.storage.kms_key_id
    }
    # Same reasoning as main.tf: cuts KMS request charges by up to ~99%. The
    # volume here is tiny, so this is consistency rather than saving.
    bucket_key_enabled = true
  }
}

# --------------------------------------------------------------------------
# Bucket policy — the shared explicit-Deny shape, plus ONE statement.
#
# The first two statements are the shared bucket template (now
# ../../modules/storage/policies/bucket.json.tftpl — see
# local.shared_bucket_policy_template in main.tf) decoded verbatim, so
# this bucket inherits any future hardening of the shared shape instead of
# quietly drifting from it. That is why this is a jsondecode-and-append rather
# than a copied-out policy.
#
# The appended statement is what "restricted read" (runbook §6.2) actually
# means, and the shared template cannot express it: the template's floor is
# `role/nt-*`, which would let EVERY Neoting role — including the ingestion
# worker's — GetObject live malware back out of quarantine. Nothing automated
# has any reason to read this bucket. The scanner writes and never reads; a
# read is a human doing forensics, so a human is who the policy allows.
# --------------------------------------------------------------------------
resource "aws_s3_bucket_policy" "quarantine" {
  bucket = aws_s3_bucket.quarantine.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      jsondecode(templatefile(local.shared_bucket_policy_template, {
        bucket     = local.quarantine_bucket
        account_id = local.account_id
      })).Statement,
      [
        {
          Sid       = "DenyQuarantineReadsToEveryAutomatedPrincipal"
          Effect    = "Deny"
          Principal = "*"
          Action    = ["s3:GetObject", "s3:GetObjectVersion"]
          Resource  = "arn:aws:s3:::${local.quarantine_bucket}/*"
          Condition = {
            StringNotLike = {
              # Deliberately NOT role/nt-* and deliberately NOT the scanner
              # role: the scanner's IAM grant below is PutObject only, so
              # allowing it to read here would widen the role beyond its job.
              "aws:PrincipalArn" = [
                "arn:aws:iam::${local.account_id}:user/Mubashir",
                "arn:aws:iam::${local.account_id}:root",
              ]
            }
            # Same guard the shared template uses. Without it this Deny also
            # catches AWS service principals — a missing aws:PrincipalArn makes
            # StringNotLike true — and S3 replication or an AWS-side copy would
            # fail with an AccessDenied nobody could explain.
            BoolIfExists = { "aws:PrincipalIsAWSService" = "false" }
          }
        }
      ]
    )
  })
}

# --------------------------------------------------------------------------
# Lifecycle — infected objects are not kept forever.
#
# Governance §12.2's six-year retention covers CLIENT FINANCIAL DOCUMENTS.
# A file that failed the virus scan is not one: it is evidence of an incident,
# and the document it purported to be was never ingested. 90 days gives a full
# quarter to investigate, which outlasts any realistic triage.
#
# Retaining live malware indefinitely is a liability in its own right, not a
# conservative default — every day it sits there is another day it can be
# restored, mis-shared, or hit by a bucket-policy mistake.
# --------------------------------------------------------------------------
resource "aws_s3_bucket_lifecycle_configuration" "quarantine" {
  bucket = aws_s3_bucket.quarantine.id

  # Same rule every bucket in lifecycle.tf carries: an abandoned multipart
  # upload bills indefinitely and is invisible in the console object list.
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-quarantined-objects"
    status = "Enabled"

    filter {}

    expiration {
      days = 90
    }

    # Versioning is on for evidence integrity, not for history. A superseded
    # version of a quarantined sample is just a second copy of the same
    # malware.
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}

# ==========================================================================
# 2. THE SIGNATURE DISTRIBUTION BUCKET
#
# Runbook Step 8: "a scheduled freshclam job publishes the signature DB to a
# private S3 prefix; scanner tasks pull on start and refresh hourly. **Never
# let tasks hit the public mirrors on every start.**"
#
# WHY THAT WARNING IS LOAD-BEARING: ClamAV's update CDN rate-limits by source
# IP and blocklists abusive clients. Staging Fargate tasks share a small pool
# of public IPs (no NAT — network.tf), so a scanner that ran freshclam on every
# start would be one crash-loop away from getting our egress addresses blocked.
# The failure mode is the dangerous one: clamd keeps running with a stale
# database and keeps returning "clean". Scanning does not stop, it silently
# stops working.
#
# WHY ITS OWN BUCKET RATHER THAN A PREFIX IN AN EXISTING ONE — three
# rejected options, recorded so nobody re-litigates this:
#   docs/av/       docs has EventBridge notifications on (below), so every
#                  publish would enqueue a scan of our own signature database;
#                  and docs deliberately has NO noncurrent-version expiry
#                  (lifecycle.tf protects original evidence), so 6 publishes/day
#                  × 250 MB would accumulate ~45 GB/month of dead versions.
#   exports/av/    exports expires EVERY object at 30 days with an unfiltered
#                  rule (lifecycle.tf), and the data class is wrong.
#   quarantine/av/ breaks the "every object here is malware" invariant, which
#                  is what both quarantine alarms depend on.
# A dedicated bucket holding ~250 MB costs about $0.01/month. That is the
# cheapest of the four options and the only one that keeps every existing
# invariant intact.
# ==========================================================================

resource "aws_s3_bucket" "avdefs" {
  bucket = local.avdefs_bucket

  tags = {
    DataClass = "internal" # public virus signatures; no customer data ever touches this bucket
    Component = "clamav"
  }
}

# Versioned so a corrupt publish is recoverable. A truncated daily.cvd stops
# clamd from starting at all, and the fix at 2 a.m. is "restore the previous
# version", not "wait four hours for the next freshclam run".
resource "aws_s3_bucket_versioning" "avdefs" {
  bucket = aws_s3_bucket.avdefs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "avdefs" {
  bucket                  = aws_s3_bucket.avdefs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# AES256, NOT the docs CMK, and this is a deliberate cost decision rather than
# an oversight: the contents are ClamAV's public signature database, downloaded
# from clamav.net by anyone who asks. Encrypting a public artefact with a
# customer-managed key adds KMS request charges on every scanner start and
# hourly refresh to protect data that is already public. Access control here is
# the bucket policy and IAM; encryption at rest is S3's default, free tier.
resource "aws_s3_bucket_server_side_encryption_configuration" "avdefs" {
  bucket = aws_s3_bucket.avdefs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# The shared shape unmodified: TLS-only, and no principal outside role/nt-*
# (plus the named human and root) touches it. Note what this protects — not
# confidentiality of the signatures, but their INTEGRITY. An attacker who could
# write here would be handing every scanner task a database that declares their
# payload clean.
resource "aws_s3_bucket_policy" "avdefs" {
  bucket = aws_s3_bucket.avdefs.id

  policy = templatefile(local.shared_bucket_policy_template, {
    bucket     = local.avdefs_bucket
    account_id = local.account_id
  })
}

resource "aws_s3_bucket_lifecycle_configuration" "avdefs" {
  bucket = aws_s3_bucket.avdefs.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  # THE RULE THAT PAYS FOR THIS BUCKET. Six publishes a day of a ~250 MB
  # database over a versioned bucket is ~45 GB/month of noncurrent versions
  # (~$1/month, growing forever) if nothing expires them. Two days keeps a
  # rollback target for a bad publish and throws away the rest.
  rule {
    id     = "expire-superseded-signature-versions"
    status = "Enabled"

    filter {
      prefix = local.av_signature_prefix
    }

    noncurrent_version_expiration {
      noncurrent_days = 2
    }
  }
}

# ==========================================================================
# 3. S3 → EventBridge
#
# ⚠ ONE aws_s3_bucket_notification PER BUCKET, AND THAT IS AN AWS LIMIT, NOT A
# TERRAFORM ONE. The resource manages the bucket's ENTIRE notification
# configuration; a second resource for the same bucket does not merge, it
# overwrites, and the two fight on every apply.
#
# CHECKED 13 Aug 2026, RE-CHECKED at the module extraction: no
# aws_s3_bucket_notification exists anywhere in infra/envs/staging/ OR in
# infra/modules/storage/ — not in main.tf, not in email.tf (SES delivers to the
# receipts bucket through a receipt rule, which is not a bucket notification),
# not in lifecycle.tf. These three resources are the only ones. Note that the
# buckets themselves now live in module.storage, so a future notification added
# INSIDE that module would collide with these from outside the file you are
# reading. If you need an
# additional S3 event consumer, ADD IT TO THE RULE BELOW or add a second
# EventBridge rule — never a second notification resource.
#
# EventBridge rather than a direct S3 → SQS notification, per runbook Step 8:
# one bucket-side configuration can then fan out to any number of consumers
# (the scanner today, an audit sink tomorrow) with no further changes to the
# bucket, and the routing lives in a rule that can be read and tested on its
# own.
# ==========================================================================

resource "aws_s3_bucket_notification" "av_scanned" {
  for_each = local.av_scanned_buckets

  bucket      = module.storage.bucket_ids[each.key]
  eventbridge = true
}

# The quarantine bucket also publishes to EventBridge — that is how runbook
# §6.2's "alert on put" is delivered. See the alarms section.
resource "aws_s3_bucket_notification" "quarantine" {
  bucket      = aws_s3_bucket.quarantine.id
  eventbridge = true
}

# ==========================================================================
# 4. THE QUEUE
#
# Governance §7: "exhausted retries land in a dead-letter queue that pages
# on-call; poison messages auto-quarantine after 3 replays" — hence
# maxReceiveCount = 3 and an alarmed DLQ.
# ==========================================================================

resource "aws_sqs_queue" "av_scan_dlq" {
  name = "nt-${local.env}-av-scan-dlq"

  # 14 days, the maximum. A poison message discovered on Monday must still be
  # inspectable after a weekend plus a triage cycle; the default 4 days can
  # expire the evidence before anyone has looked at it.
  message_retention_seconds = 1209600

  kms_master_key_id = aws_kms_key.ops.arn

  # Only the scan queue may redrive into this one. Without this, any queue in
  # this SHARED account could name it as its DLQ and the alarm below would
  # start reporting another product's failures as ours.
  #
  # A constructed ARN rather than aws_sqs_queue.av_scan.arn — see the cycle
  # note on local.av_scan_queue_arn.
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [local.av_scan_queue_arn]
  })

  tags = { Component = "clamav" }
}

resource "aws_sqs_queue" "av_scan" {
  name = local.av_scan_queue_name

  visibility_timeout_seconds = local.av_visibility_timeout

  # 4 days (the default, stated explicitly because it is a real decision):
  # long enough to survive a weekend outage of the scanner service, short
  # enough that a document nobody noticed was unscanned does not reappear a
  # fortnight later and get published into a ledger.
  message_retention_seconds = 345600

  # LONG POLLING, and it is a cost line, not a nicety. A warm consumer
  # short-polling an empty queue once a second is ~2.6M requests/month
  # (~$0.65 after the 1M free tier) and burns CPU doing nothing. At 20 s waits
  # the same consumer makes ~130k requests/month and stays inside the free
  # tier. It also cuts empty-receive latency to zero when work does arrive.
  receive_wait_time_seconds = 20

  # SSE-KMS with the OPERATIONAL key, not the documents key. The message body
  # is an S3 event — bucket, key, size, etag. It is metadata about a customer
  # document, not the document, and observability.tf's key already grants
  # events.amazonaws.com the GenerateDataKey*/Decrypt it needs to deliver into
  # an encrypted queue. Pointing this at the documents CMK (module.storage)
  # would mean adding
  # EventBridge to the customer-document key's policy purely to encrypt a
  # filename.
  #
  # ⚠ THE SILENT-FAILURE TRAP THIS AVOIDS: if the delivering principal lacks
  # kms:GenerateDataKey* on the queue's key, EventBridge cannot enqueue and the
  # event is dropped. Nothing errors anywhere you would look. Both halves —
  # the key policy (observability.tf) and the queue policy (below) — must name
  # events.amazonaws.com, and neither is sufficient alone.
  kms_master_key_id = aws_kms_key.ops.arn

  # kms_data_key_reuse_period_seconds is left at the AWS default (300 s) on
  # purpose. Raising it to the 86400 maximum would cut KMS requests ~288x, but
  # at staging volume those requests round to zero dollars, and the trade is a
  # data key held in SQS memory for a day instead of five minutes. Free is not
  # worth paying for.

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.av_scan_dlq.arn
    # 3, per Governance §7. Two retries covers a transient S3 or clamd blip;
    # a third failure is a bad object or a bug, and re-scanning it forever
    # burns Fargate minutes while the document sits unscanned either way.
    maxReceiveCount = 3
  })

  tags = { Component = "clamav" }
}

# Both queue policies scope EventBridge to THIS rule's ARN, not to
# events.amazonaws.com generally. The account is shared with three unrelated
# Neovogent products; an unscoped grant would let any rule in the account
# inject work into the scanner.
resource "aws_sqs_queue_policy" "av_scan" {
  queue_url = aws_sqs_queue.av_scan.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowEventBridgeRuleToEnqueue"
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.av_scan.arn
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnEquals    = { "aws:SourceArn" = aws_cloudwatch_event_rule.av_scan.arn }
      }
    }]
  })
}

# The DLQ needs its own grant because the EventBridge TARGET writes here
# directly on a delivery failure (dead_letter_config below) — that path does
# not go through the main queue's redrive policy.
resource "aws_sqs_queue_policy" "av_scan_dlq" {
  queue_url = aws_sqs_queue.av_scan_dlq.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowEventBridgeRuleToDeadLetter"
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.av_scan_dlq.arn
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnEquals    = { "aws:SourceArn" = aws_cloudwatch_event_rule.av_scan.arn }
      }
    }]
  })
}

# --------------------------------------------------------------------------
# The rule.
#
# NO OBJECT-KEY PREFIX FILTER, DELIBERATELY. It would be easy to narrow this to
# `w/` on docs and `inbound/` on receipts, and it would be a mistake: a prefix
# filter FAILS OPEN. An object written to a path nobody anticipated would
# simply never be scanned, silently, and the first evidence would be a clean
# tag that was never written.
#
# The scanner's IAM grant IS prefix-bounded (w/ and inbound/ only), so the two
# together fail LOUD instead: an object outside a known prefix is enqueued,
# the scanner gets AccessDenied on the GET, the message exhausts its three
# receives, lands in the DLQ, and the DLQ alarm fires. That interlock is the
# design — do not "tidy it up" by adding a prefix filter here or by widening
# the IAM grant there. Changing either one alone converts a page into silence.
#
# NO `reason` FILTER EITHER. S3 reports "Object Created" with reasons
# PutObject, POST Object, CopyObject and CompleteMultipartUpload. Filtering on
# `reason: PutObject` — which reads perfectly reasonably, and matches how the
# runbook phrases it — would skip every multipart upload, i.e. exactly the
# large files most worth scanning (the SDK switches to multipart well below the
# 100 MB accountant-batch case).
# --------------------------------------------------------------------------
resource "aws_cloudwatch_event_rule" "av_scan" {
  name        = "nt-${local.env}-av-object-created"
  description = "Objects landing in docs/receipts, queued for virus scanning (runbook Step 8, Gov §11.4)"

  event_pattern = jsonencode({
    source        = ["aws.s3"]
    "detail-type" = ["Object Created"]
    detail = {
      bucket = {
        name = [
          local.bucket_names["docs"],
          local.bucket_names["receipts"],
        ]
      }
    }
  })

  tags = { Component = "clamav" }
}

resource "aws_cloudwatch_event_target" "av_scan" {
  rule      = aws_cloudwatch_event_rule.av_scan.name
  target_id = "sqs-av-scan"
  arn       = aws_sqs_queue.av_scan.arn

  # NO input_transformer, on purpose — the scanner needs the whole event.
  #
  # ⚠ detail.object.version-id is the field that matters most and the one an
  # input transformer would be most likely to drop. Both source buckets are
  # versioned, so between this event and the scan completing, a NEW version can
  # land. A PutObjectTagging call without a versionId tags the CURRENT version,
  # which would mean stamping av-status=clean on a version that was never
  # scanned. The scanner must read and tag the exact version named here, which
  # is why the task role carries the *VersionTagging actions.
  #
  # Delivery failures (an SQS or KMS problem) otherwise vanish with only the
  # AWS/Events FailedInvocations metric to show for it. Routing them to the DLQ
  # means the existing DLQ alarm covers this hole too, at no extra cost.
  # Messages arriving this way carry EventBridge's own ErrorCode/ErrorMessage
  # attributes, which is how you tell them apart from poison messages during
  # a redrive.
  dead_letter_config {
    arn = aws_sqs_queue.av_scan_dlq.arn
  }
}

# ==========================================================================
# 5. THE SCANNER SERVICE
# ==========================================================================

# One repository, and the freshclam publisher below uses the SAME image with a
# different command. That is the point: the code that WRITES the signature
# bundle and the code that READS it ship together and can never disagree about
# its layout.
#
# Encrypted with the docs CMK to match compute.tf's repos — not because a
# container image is a customer document, but because the ECS execution role's
# kms:Decrypt grant (compute.tf) names exactly that key. A different key here
# means every image pull fails with a KMS error at task start.
resource "aws_ecr_repository" "clamav" {
  name                 = "nt/clamav"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = module.storage.kms_key_arn
  }

  tags = { Component = "clamav" }
}

resource "aws_ecr_lifecycle_policy" "clamav" {
  repository = aws_ecr_repository.clamav.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      # 10, not compute.tf's 30. This image changes when clamd or the consumer
      # changes, which is rarely — and at ~500 MB an image it is the largest
      # per-image footprint in the account.
      description = "Keep the last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

# ONE log group for both the scanner and the freshclam publisher, separated by
# awslogs-stream-prefix. Two groups would double the fixed overhead and the
# number of places to look during an incident, and their retention requirement
# is identical (Gov §12.2, 30 days).
#
# Created here rather than auto-created by ECS: auto-created groups have
# infinite retention, which is both a cost leak and a compliance problem.
resource "aws_cloudwatch_log_group" "clamav" {
  name              = "/nt/${local.env}/clamav"
  retention_in_days = 30

  tags = { Component = "clamav" }
}

# A dedicated security group rather than reusing module.network's app group.
#
# The app SG carries an ingress rule from the ALB on 3000. The scanner listens
# on nothing and must never be addressable — putting it in the app SG would
# make it reachable from the load balancer's SG the moment anything in the
# image did bind a port. Egress-only, no ingress rule at all, and the absence
# is the security property.
resource "aws_security_group" "clamav" {
  name        = "nt-${local.env}-clamav"
  description = "ClamAV scanner and freshclam publisher. Egress only - nothing ever connects in."
  vpc_id      = module.network.vpc_id

  tags = { Name = "nt-${local.env}-clamav" }
}

# Outbound to SQS, ECR, CloudWatch and (freshclam only) database.clamav.net.
# S3 traffic takes the free gateway endpoint (network.tf); everything else goes
# over the task's public IP because staging has no NAT (Appendix B.3).
resource "aws_vpc_security_group_egress_rule" "clamav_all" {
  security_group_id = aws_security_group.clamav.id
  description       = "Outbound to AWS endpoints and the ClamAV signature CDN"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# --------------------------------------------------------------------------
# The scanner task role.
#
# ⚠ THE NAME IS PART OF THE SECURITY MODEL, NOT A LABEL. Every bucket policy in
# this environment and both the docs and ops KMS key policies key their allow
# off `arn:aws:iam::252959251643:role/nt-*` and explicitly Deny everything
# else. A role named anything other than nt-* gets AccessDenied from the
# RESOURCE side no matter how generous the policy below is — and because this
# is a shared account, that guard is the only thing standing between three
# unrelated products and our documents. Do not rename this role.
# --------------------------------------------------------------------------
resource "aws_iam_role" "clamav" {
  name        = "nt-${local.env}-clamav"
  description = "ClamAV scanner task role - read source object, tag it, quarantine on a hit"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })

  tags = { Component = "clamav" }
}

# D30 residency guardrail, same as the app role (main.tf).
resource "aws_iam_role_policy_attachment" "clamav_guardrail" {
  role       = aws_iam_role.clamav.name
  policy_arn = aws_iam_policy.region_guardrail.arn
}

resource "aws_iam_role_policy" "clamav_runtime" {
  name = "nt-clamav-runtime"
  role = aws_iam_role.clamav.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # READ THE SOURCE OBJECT, and only inside the two prefixes that exist.
        # The *Version variants are not optional: the scan is against the
        # version named in the event, not against "latest" (see the event
        # target above).
        #
        # There is deliberately NO s3:ListBucket here. The scanner is told
        # which key to fetch by the queue; a role that can enumerate the
        # document store has a capability its job does not need.
        Sid    = "ReadObjectsAwaitingScan"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:GetObjectTagging",
          "s3:GetObjectVersionTagging",
        ]
        Resource = [
          "arn:aws:s3:::${local.bucket_names["docs"]}/w/*",
          "arn:aws:s3:::${local.bucket_names["receipts"]}/inbound/*",
        ]
      },
      {
        # WRITE THE VERDICT — the tag, and nothing else. No s3:PutObject on the
        # source buckets, so a compromised scanner cannot alter, replace or
        # append to a client's document; the worst it can do is lie about the
        # verdict, which the DLQ and the quarantine alert both make noisy.
        #
        # GetObjectTagging above plus this makes the handler idempotent: SQS is
        # at-least-once, so a redelivery must be able to notice the object is
        # already tagged and delete the message rather than re-scan.
        Sid    = "WriteScanVerdictTag"
        Effect = "Allow"
        Action = ["s3:PutObjectTagging", "s3:PutObjectVersionTagging"]
        Resource = [
          "arn:aws:s3:::${local.bucket_names["docs"]}/w/*",
          "arn:aws:s3:::${local.bucket_names["receipts"]}/inbound/*",
        ]
      },
      {
        # PUT TO QUARANTINE. Write-only by design — the bucket policy denies
        # this role GetObject on the quarantine bucket, so malware moves in one
        # direction and the only way back out is a human.
        #
        # ⚠ Runbook Step 8 says infected objects "move" to quarantine. This is
        # implemented as COPY-AND-TAG, not move: there is no s3:DeleteObject on
        # the source anywhere in this policy, deliberately. Handing the virus
        # scanner delete rights over the immutable document store (SoT Stage
        # 8.4, Gov §12.2 "deletion only on explicit, audited client
        # instruction") is a larger risk than leaving an infected object in
        # place — and it does not need to be deleted, because it is tagged
        # av-status=infected and the worker refuses to read it. The audit trail
        # of what was actually uploaded also survives, which a move destroys.
        Sid      = "QuarantineInfectedObjects"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "arn:aws:s3:::${local.quarantine_bucket}/*"
      },
      {
        # PULL SIGNATURES. ListBucket IS granted here, unlike on the document
        # buckets, because the scanner has to discover which .cvd/.cld files
        # the publisher last wrote — and it is bounded to the signature prefix,
        # so it cannot enumerate anything else even in this bucket.
        Sid      = "ReadVirusSignatures"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "arn:aws:s3:::${local.avdefs_bucket}/${local.av_signature_prefix}*"
      },
      {
        Sid      = "ListVirusSignatures"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = "arn:aws:s3:::${local.avdefs_bucket}"
        Condition = {
          StringLike = { "s3:prefix" = ["${local.av_signature_prefix}*"] }
        }
      },
      {
        # CONSUME THE QUEUE. ChangeMessageVisibility is here because a scan
        # that outruns the 600 s lease must be able to extend it — without
        # this action the message silently reappears mid-scan and a second task
        # starts scanning the same object. GetQueueAttributes is what lets the
        # consumer read its own backlog; no SendMessage and no
        # PurgeQueue.
        Sid    = "ConsumeScanQueue"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:ChangeMessageVisibility",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
        ]
        Resource = aws_sqs_queue.av_scan.arn
      },
      {
        # Decrypt source objects (docs CMK — note the receipts bucket defaults
        # to AES256, but SES names the docs CMK on the receipt action itself,
        # so inbound mail objects are SSE-KMS under this key; see main.tf's
        # `sse` note), and generate a data key to write the quarantine copy.
        Sid      = "DocumentEnvelopeEncryption"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource = module.storage.kms_key_arn
      },
      {
        # Decrypt SQS message bodies. Decrypt only — the scanner never
        # publishes to an ops-key-encrypted resource, so it needs no
        # GenerateDataKey* here.
        Sid      = "DecryptQueueMessages"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.ops.arn
      }
    ]
  })
}

# --------------------------------------------------------------------------
# Scanner task definition.
#
# ARM64 to match services.tf — the Dockerfile MUST produce linux/arm64 or the
# task dies with "exec format error" and nothing else. ClamAV builds cleanly on
# arm64; the risk here is our build pipeline, not the software.
# --------------------------------------------------------------------------
resource "aws_ecs_task_definition" "clamav" {
  family                   = "nt-${local.env}-clamav"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.clamav_task_size.cpu
  memory                   = local.clamav_task_size.memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn # image pull + log write; no secrets to inject
  task_role_arn            = aws_iam_role.clamav.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  # ephemeral_storage unset: Fargate's free 20 GiB covers a 100 MB upload plus
  # its ZIP explode with room to spare, and every GiB above 20 bills. If ZIP
  # depth/size caps (Gov §11.4) are ever raised enough to need more than 20 GiB
  # of scratch, the caps are the thing to look at, not this line.

  container_definitions = jsonencode([
    {
      name      = "clamav"
      image     = "${aws_ecr_repository.clamav.repository_url}:${local.clamav_image_tag}"
      essential = true

      # No portMappings. The scanner pulls from SQS; nothing dials in, and the
      # security group above has no ingress rule that would let it.

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "NEOTING_ENV", value = local.env },
        { name = "SERVICE_NAME", value = "clamav" },
        { name = "AWS_REGION", value = local.region },
        { name = "TZ", value = "UTC" }, # storage is UTC, full stop (CLAUDE.md invariant)

        { name = "AV_QUEUE_URL", value = aws_sqs_queue.av_scan.url },

        # The handler must renew its lease before this expires, not after.
        { name = "AV_VISIBILITY_TIMEOUT_SECONDS", value = tostring(local.av_visibility_timeout) },

        { name = "AV_QUARANTINE_BUCKET", value = local.quarantine_bucket },
        { name = "AV_SIGNATURE_BUCKET", value = local.avdefs_bucket },
        { name = "AV_SIGNATURE_PREFIX", value = local.av_signature_prefix },

        # Runbook Step 8: "pull on start and refresh hourly". Hourly against
        # S3, NOT against clamav.net — the container must never run freshclam
        # against the public mirrors itself. See the signature bucket banner.
        { name = "AV_SIGNATURE_REFRESH_SECONDS", value = "3600" },

        { name = "KMS_KEY_ARN", value = module.storage.kms_key_arn },
      ]

      # No `secrets` block: the scanner holds no credentials. It reads S3,
      # writes a tag, and consumes a queue, all through the task role.

      # A REAL health check, unlike the api container's — and here it earns its
      # place, because there is no load balancer probing this task. clamd can
      # die or wedge while the container process stays up, and a scanner that
      # has silently stopped scanning is indistinguishable from an idle one
      # (the exact gap services.tf flags as a TODO for workers).
      #
      # startPeriod is 180 s because loading the signature database takes
      # 60–120 s. A shorter grace period fails the check during normal startup
      # and ECS kills the task in a loop that looks like a crashing image.
      healthCheck = {
        command     = ["CMD-SHELL", "clamdscan --ping 1 >/dev/null 2>&1 || exit 1"]
        interval    = 30
        timeout     = 10
        retries     = 3
        startPeriod = 180
      }

      # PID 1 reaps nothing. clamd forks per scan, so without init every scan
      # leaves a zombie until the task runs out of process slots.
      linuxParameters = {
        initProcessEnabled = true
      }

      # 120 s is the Fargate maximum and it is here for Spot (below): on an
      # interruption the consumer must stop receiving, finish the scan in
      # flight, and delete its message. A scan killed mid-flight is not lost —
      # SQS redelivers after the visibility timeout — so this is about not
      # paying to scan the same 100 MB archive twice.
      stopTimeout = 120

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.clamav.name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "scanner"
        }
      }
    }
  ])

  tags = { Component = "clamav" }
}

# --------------------------------------------------------------------------
# Scanner service.
#
# ⚠ desired_count = 0, SAME REASON AS services.tf: no image exists in ECR, so a
# non-zero count would launch a task, fail the pull, back off and retry
# forever — burning Fargate minutes, filling a log group we pay to ingest, and
# firing the circuit breaker on every apply. First deploy is a count change
# (`aws ecs update-service --desired-count 1`), not an infrastructure change.
#
# ⚠ AND THE HONEST CONSEQUENCE, WHICH IS A SECURITY ONE: until that count is
# raised, NOTHING IS BEING SCANNED. Every part of this file upstream of here is
# live, so objects queue and the queue-age alarm fires — that is the design.
# But do not read "the ClamAV path is built" as "uploads are scanned". The
# control is complete when an image exists, the count is ≥ 1, and the worker
# enforces the tag (see the contract block below). Gov §11.4 is satisfied by
# none of the three alone.
# --------------------------------------------------------------------------
resource "aws_ecs_service" "clamav" {
  name            = "nt-${local.env}-clamav"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.clamav.arn
  desired_count   = 0

  # COST DECISION: Fargate Spot takes this from ~$25.50/mo to ~$7.70/mo. A
  # reclaimed scanner costs a redelivered SQS message, not a failed request —
  # the object simply waits out the visibility timeout and is scanned by the
  # replacement task. Acceptable in staging (synthetic data only, G2) on the
  # same reasoning services.tf applies to workers.
  #
  # ⚠ NOT AUTOMATICALLY RIGHT FOR PROD. A reclaim adds up to 10 minutes of
  # scan latency, and scanning gates the whole ingestion pipeline — it is the
  # difference between "extraction p95 < 5 min" (SoT §4 Stage 2) and not. Prod
  # should run this on FARGATE with at least two tasks.
  #
  # ⚠ Verify at first deploy that Spot places ARM64 tasks in eu-west-2; the
  # same caveat services.tf records for workers applies here.
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
    base              = 0
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # 0/100, like workers and for the same reason: there is no availability to
  # protect, the queue simply waits. Running old and new scanners side by side
  # would double concurrent clamd processes against one queue for no benefit.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  # ECS must not judge the task dead while clamd is still loading its
  # database — see startPeriod above. 300 s is generous on purpose: a cold
  # start that gets killed at 120 s looks exactly like a broken image.
  health_check_grace_period_seconds = 300

  network_configuration {
    subnets         = module.network.public_subnet_ids
    security_groups = [aws_security_group.clamav.id]

    # No NAT in staging (network.tf, Appendix B.3). The public IP is how the
    # task reaches SQS, ECR and CloudWatch at all; S3 goes via the free gateway
    # endpoint. Nothing can reach in — the SG has no ingress rule.
    # ~$3.60/task/month.
    assign_public_ip = true
  }

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  # ECS Exec off: the task role grants no ssmmessages:*, and enabling it
  # without them yields a task with a permanently STOPPED managed agent.
  # Turning it on is a task-role change first (runbook §6.1: no bastion).
  enable_execute_command = false

  # FARGATE_SPOT must be associated with the cluster before a service may name
  # it, and that link is invisible to Terraform's graph through `cluster`
  # alone. The association lives in services.tf.
  depends_on = [aws_ecs_cluster_capacity_providers.main]

  tags = { Component = "clamav" }

  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }
}

# ==========================================================================
# 6. SIGNATURE DISTRIBUTION — the scheduled freshclam publisher
#
# Runs freshclam once, uploads the resulting database to the private S3 prefix,
# exits. Scanner tasks pull from S3 on start and hourly thereafter, so ClamAV's
# mirrors see ~6 requests a day from this environment instead of one per task
# start (see the bucket banner for why that distinction protects the control).
# ==========================================================================

resource "aws_iam_role" "clamav_freshclam" {
  name        = "nt-${local.env}-clamav-freshclam"
  description = "Publishes the ClamAV signature database to the private S3 prefix"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })

  tags = { Component = "clamav" }
}

resource "aws_iam_role_policy_attachment" "clamav_freshclam_guardrail" {
  role       = aws_iam_role.clamav_freshclam.name
  policy_arn = aws_iam_policy.region_guardrail.arn
}

# Separate from the scanner role, not shared. The publisher WRITES signatures
# and the scanner READS them; merging the roles would give every scanner task
# the ability to replace the database it scans with — which is the one write
# that turns the whole control off. Two roles is the cheapest possible
# separation of duties.
resource "aws_iam_role_policy" "clamav_freshclam" {
  name = "nt-clamav-publish-signatures"
  role = aws_iam_role.clamav_freshclam.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # GetObject as well as PutObject: freshclam applies incremental .cdiff
        # patches against the database it already has, so the publisher fetches
        # the current bundle before deciding what to write. Without the read it
        # re-downloads the full ~250 MB set from clamav.net every run — which
        # is precisely the mirror abuse this whole design exists to avoid.
        Sid    = "PublishVirusSignatures"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject"]
        Resource = [
          "arn:aws:s3:::${local.avdefs_bucket}/${local.av_signature_prefix}*",
        ]
      },
      {
        Sid      = "ListVirusSignatures"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = "arn:aws:s3:::${local.avdefs_bucket}"
        Condition = {
          StringLike = { "s3:prefix" = ["${local.av_signature_prefix}*"] }
        }
      }
      # No KMS statement: the signature bucket is AES256 (SSE-S3), so there is
      # no CMK in this path at all. See the bucket's encryption block.
    ]
  })
}

resource "aws_ecs_task_definition" "clamav_freshclam" {
  family                   = "nt-${local.env}-clamav-freshclam"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.freshclam_task_size.cpu
  memory                   = local.freshclam_task_size.memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.clamav_freshclam.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name = "freshclam"

      # THE SAME IMAGE as the scanner, with a different command. One artefact,
      # two entrypoints, so the bundle layout the publisher writes and the
      # layout the scanner expects cannot drift apart across two repos and two
      # release cadences.
      image     = "${aws_ecr_repository.clamav.repository_url}:${local.clamav_image_tag}"
      command   = ["freshclam-publish"]
      essential = true

      environment = [
        { name = "NEOTING_ENV", value = local.env },
        { name = "SERVICE_NAME", value = "clamav-freshclam" },
        { name = "AWS_REGION", value = local.region },
        { name = "TZ", value = "UTC" },
        { name = "AV_SIGNATURE_BUCKET", value = local.avdefs_bucket },
        { name = "AV_SIGNATURE_PREFIX", value = local.av_signature_prefix },
      ]

      # No healthCheck: this is a batch task. Its health signal is its exit
      # code, and a non-zero exit shows up as a stopped task with a reason.

      linuxParameters = {
        initProcessEnabled = true
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.clamav.name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "freshclam"
        }
      }
    }
  ])

  tags = { Component = "clamav" }
}

# --------------------------------------------------------------------------
# The scheduler's own role. EventBridge Scheduler assumes this to call
# ecs:RunTask; it is not the role the task itself runs as.
#
# nt-* named like everything else. It touches no S3 and no KMS, so the naming
# contract is not load-bearing here — but a non-conforming name in this set
# would be the one somebody copies next time it is.
# --------------------------------------------------------------------------
resource "aws_iam_role" "clamav_scheduler" {
  name        = "nt-${local.env}-clamav-scheduler"
  description = "EventBridge Scheduler - runs the freshclam publisher task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })

  tags = { Component = "clamav" }
}

resource "aws_iam_role_policy" "clamav_scheduler" {
  name = "nt-run-freshclam-task"
  role = aws_iam_role.clamav_scheduler.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # The `:*` suffix is REQUIRED, not lazy: every task-definition revision
        # has its own ARN, so a grant naming one revision stops working the
        # next time the definition is registered. The cluster condition is what
        # keeps this from being a "run anything anywhere" permission in a
        # shared account.
        Sid      = "RunFreshclamTask"
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = "arn:aws:ecs:${local.region}:${local.account_id}:task-definition/${aws_ecs_task_definition.clamav_freshclam.family}:*"
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn }
        }
      },
      {
        # RunTask hands two roles to the task; without PassRole it fails with
        # an error that names IAM rather than ECS and sends people hunting in
        # the wrong file.
        Sid    = "PassTaskRoles"
        Effect = "Allow"
        Action = ["iam:PassRole"]
        Resource = [
          aws_iam_role.clamav_freshclam.arn,
          aws_iam_role.ecs_execution.arn,
        ]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      },
      {
        # Required because the schedule below propagates tags and enables ECS
        # managed tags — that is what makes this task's cost attributable in
        # Cost Explorer (Gov §13.5). Scoped to tagging performed as part of a
        # RunTask on this cluster.
        Sid      = "TagTasksOnRun"
        Effect   = "Allow"
        Action   = ["ecs:TagResource"]
        Resource = "*"
        Condition = {
          ArnEquals    = { "ecs:cluster" = aws_ecs_cluster.main.arn }
          StringEquals = { "ecs:CreateAction" = "RunTask" }
        }
      }
    ]
  })
}

# --------------------------------------------------------------------------
# The schedule.
#
# ⚠ SHIPS DISABLED. There is no image, so every invocation would start a task
# that dies on CannotPullContainerError — six failed tasks a day, forever,
# training everyone to ignore stopped tasks in the ECS console. Enabling it is
# a one-word change (`state = "ENABLED"`) in the PR that pushes the first
# image; it is deliberately not gated on anything cleverer than that.
#
# CADENCE: every 4 hours, 6 times a day. The two ends of this are governed by
# different things and it matters that they are not the same number —
#   * the PUBLISH cadence (here) is bounded by ClamAV's policy. They publish
#     updates a few times a day and rate-limit/blocklist clients that poll
#     harder; 6/day sits comfortably inside every published guideline.
#   * the PULL cadence (AV_SIGNATURE_REFRESH_SECONDS, hourly) is bounded only
#     by our own S3 bill, which is why it can be more frequent.
# Worst case a scanner runs on definitions up to ~4 hours old. For a
# defence-in-depth control behind magic-byte sniffing, extension allowlists and
# SES's own verdict (Gov §11.4), that is the right trade against getting our
# egress IPs blocked.
#
# :15 past rather than :00, and a 15-minute flexible window, so we are not
# hitting the CDN in the same second as every other cron on the internet.
# --------------------------------------------------------------------------
resource "aws_scheduler_schedule" "clamav_freshclam" {
  name        = "nt-${local.env}-clamav-freshclam"
  description = "Publish the ClamAV signature database to S3 (runbook Step 8)"
  state       = "DISABLED"

  schedule_expression          = "cron(15 */4 * * ? *)"
  schedule_expression_timezone = "UTC" # explicit: storage and scheduling are UTC (Gov §12)

  flexible_time_window {
    mode                      = "FLEXIBLE"
    maximum_window_in_minutes = 15
  }

  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.clamav_scheduler.arn

    ecs_parameters {
      # A pinned revision ARN. Terraform owns this task definition — CI does
      # not deploy it — so the revision moves on apply and stays correct. If CI
      # ever starts registering revisions for this family, this schedule must
      # be updated in the same change or it will keep launching the old one.
      task_definition_arn = aws_ecs_task_definition.clamav_freshclam.arn
      launch_type         = "FARGATE"
      task_count          = 1

      enable_ecs_managed_tags = true
      propagate_tags          = "TASK_DEFINITION"

      network_configuration {
        subnets          = module.network.public_subnet_ids
        security_groups  = [aws_security_group.clamav.id]
        assign_public_ip = true # freshclam must reach database.clamav.net; no NAT in staging
      }
    }

    # Two retries over an hour. A failed publish is not urgent — scanners keep
    # using the database they already have — but a transient CDN failure
    # should not cost a whole 4-hour cycle.
    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 3600
    }
  }
}

# ==========================================================================
# 7. ALARMS
#
# Structured to match observability.tf: nt-<env>-<name>, alarm_actions AND
# ok_actions on aws_sns_topic.alerts (a channel that only ever carries bad news
# gets muted — Gov §13.2's "not a dead channel"), and its treat_missing_data
# policy applied unchanged. SQS and S3 storage metrics only publish when
# something happened, so `notBreaching` is correct here: no data genuinely does
# mean nothing is queued and nothing is quarantined.
#
# Tagged Component = "clamav" rather than observability.tf's
# Component = "observability" on purpose — these alarms exist because this
# component does, and Gov §13.5 cost attribution is the reason the tag exists.
#
# FOLLOW-UP for whoever owns observability.tf (not changed here — this lane
# does not edit another file): local.ecs_services in that file drives the
# task-shortfall and memory-high alarms and lists only api and workers, so the
# scanner service has neither. One line each once this service actually runs.
# ==========================================================================

# Governance §7: "exhausted retries land in a dead-letter queue that pages
# on-call".
#
# DELIBERATELY FASTER THAN observability.tf's pending_dlq_depth alarm, which
# waits four hours on the reasoning that "a job landing in the DLQ is a bug to
# triage in hours, not a 3 a.m. page". That reasoning does not transfer: a
# message in THIS queue's DLQ is a document that was never virus scanned, which
# is a failure of a mandatory control (Gov §11.4), not a slow job. One
# five-minute datapoint.
#
# Two distinct causes land here and the runbook entry should check both: a
# poison message (three failed scans — usually an object outside the granted
# prefixes, see the rule's fail-loud note), or an EventBridge delivery failure
# (messages carrying ErrorCode/ErrorMessage attributes, usually SQS or KMS).
resource "aws_cloudwatch_metric_alarm" "av_dlq_non_empty" {
  alarm_name          = "nt-${local.env}-av-dlq-non-empty"
  alarm_description   = "A document failed virus scanning three times or EventBridge could not enqueue it - a mandatory Gov §11.4 control did not run on that object"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  dimensions = { QueueName = aws_sqs_queue.av_scan_dlq.name }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "clamav" }
}

# Queue age, not queue depth. Depth spikes legitimately when an accountant
# uploads a batch; age only climbs when nothing is draining it.
#
# 15 minutes, sustained over two datapoints. SoT §4 Stage 2 targets extraction
# p95 under 5 minutes and scanning gates extraction, so a quarter-hour of
# unscanned backlog means the scanner is down, starved, or wedged on one
# object.
#
# ⚠ THIS IS THE ALARM THAT WILL FIRE FIRST, AND IT WILL BE RIGHT. With the
# service at desired_count = 0, the first upload to staging starts a backlog
# nothing is consuming. That is not a false positive and it is not a reason to
# suppress the alarm — it is the accurate statement that uploads are landing
# unscanned. Deploy the scanner or stop uploading.
resource "aws_cloudwatch_metric_alarm" "av_queue_age" {
  alarm_name          = "nt-${local.env}-av-queue-age"
  alarm_description   = "Oldest unscanned object waiting over 15 minutes - the scanner is down, starved, or the service is still at desired_count = 0"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 900
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  unit                = "Seconds"
  treat_missing_data  = "notBreaching"

  dimensions = { QueueName = aws_sqs_queue.av_scan.name }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "clamav" }
}

# --------------------------------------------------------------------------
# "Alert on put" (runbook §6.2) — an EventBridge rule, not a metric alarm.
#
# WHY NOT A METRIC ALARM: CloudWatch has no free per-bucket PutRequests metric.
# Getting one means enabling S3 request metrics, which bill as ~16 CloudWatch
# custom metrics per filter — roughly $4.80/month, or 3% of the entire staging
# envelope (Appendix B.2), to count events that EventBridge already delivers
# for nothing. The event route is also better information: it arrives in
# seconds rather than at the next 5-minute aggregation, and it carries the
# object key, so the alert says WHICH document was infected instead of "a put
# happened".
#
# Both halves of the encrypted-topic grant are already in place — SNS topic
# policy AllowEventBridgeRulesToPublish and the ops key's
# AllowAWSServicesToPublishToEncryptedTopic both name events.amazonaws.com
# (observability.tf). That file's warning applies: if either is ever narrowed,
# this alert is silently rejected at publish time, which is the worst failure
# mode an alerting system has.
# --------------------------------------------------------------------------
resource "aws_cloudwatch_event_rule" "av_quarantine_write" {
  name        = "nt-${local.env}-av-quarantine-write"
  description = "An object was written to the quarantine bucket - ClamAV found malware (runbook §6.2, SoT Stage 1)"

  event_pattern = jsonencode({
    source        = ["aws.s3"]
    "detail-type" = ["Object Created"]
    detail = {
      bucket = { name = [local.quarantine_bucket] }
    }
  })

  tags = { Component = "clamav" }
}

resource "aws_cloudwatch_event_target" "av_quarantine_write" {
  rule      = aws_cloudwatch_event_rule.av_quarantine_write.name
  target_id = "sns-alerts"
  arn       = aws_sns_topic.alerts.arn

  # Same treatment observability.tf gives GuardDuty findings: a raw S3 event
  # delivered unmodified to an email subscriber is unreadable, and an
  # unreadable alert is an ignored alert.
  input_transformer {
    input_paths = {
      bucket    = "$.detail.bucket.name"
      key       = "$.detail.object.key"
      size      = "$.detail.object.size"
      eventTime = "$.time"
    }

    input_template = "\"MALWARE QUARANTINED in <bucket>\\n\\nObject: <key>\\nSize:   <size> bytes\\nAt:     <eventTime> (UTC)\\n\\nClamAV rejected an upload and it has been copied here; the source object is tagged av-status=infected and the worker will refuse to read it.\\n\\nRunbook Step 8. SoT Stage 1 also requires a plain-language message to the submitter - check that it was sent. Do NOT download this object to 'have a look'.\""
  }
}

# The backstop the event alert cannot be: a BACKLOG signal rather than an
# EVENT one. The rule above fires once, when the object lands. If nobody acts,
# nothing fires again. This says "there is still malware sitting in quarantine"
# every day until someone deals with it.
#
# NumberOfObjects is a daily S3 storage metric and it is FREE — no request
# metrics, no custom metrics, $0.10/month for the alarm itself. Daily
# granularity is exactly right for the question it answers.
#
# It only works because of the invariant at the top of section 1: nothing but
# malware is ever written to this bucket, so "object count > 0" needs no
# interpretation.
resource "aws_cloudwatch_metric_alarm" "av_quarantine_non_empty" {
  alarm_name          = "nt-${local.env}-av-quarantine-non-empty"
  alarm_description   = "Quarantined malware is still sitting in the bucket - an infected upload has not been triaged"
  namespace           = "AWS/S3"
  metric_name         = "NumberOfObjects"
  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 86400
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  dimensions = {
    BucketName  = aws_s3_bucket.quarantine.id
    StorageType = "AllStorageTypes"
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn] # the OK is "quarantine is clear again", which is worth seeing

  tags = { Component = "clamav" }
}

# ==========================================================================
# 8. THE WORKER-SIDE CONTRACT — NOT INFRASTRUCTURE, AND NOT OPTIONAL
#
# Runbook Step 8, emphasis theirs: "**The extraction pipeline must not read an
# object that is not tagged clean.** Enforce it in the worker, and test it with
# the EICAR test file in CI."
#
# EVERYTHING IN THIS FILE IS WORTHLESS WITHOUT THAT. Tagging an object
# av-status=infected changes nothing on its own; it is a sticker. The control
# is the worker refusing to open the envelope. Until apps/workers implements
# it, this environment scans documents and then processes them regardless.
#
# WHAT THE APPLICATION LANE OWES (packages/, apps/workers/):
#   1. Every read path into a document object — extraction, thumbnailing,
#      export, the presigned-URL issuer, the portal download — checks
#      GetObjectTagging for av-status == "clean" first, and refuses on
#      "infected", on "pending", and on ABSENT. Absent is the important one:
#      an untagged object is an unscanned object, and "no tag" must fail
#      closed, not default to clean.
#   2. A CI test using the EICAR test string (the industry-standard harmless
#      68-byte test file, X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-...) that uploads
#      it, waits for the tag, and asserts the worker refuses it. That test is
#      the only thing that proves the path works end to end; a unit test with a
#      mocked tag proves the mock works.
#   3. SoT Stage 1's other half — the plain-language message to the submitter.
#      The operator alert is built above; the submitter notification is not,
#      and it is a product requirement, not a nicety.
#
# FOLLOW-UP for whoever owns compute.tf (not changed here — this lane does not
# edit another file): the IAM layer can enforce rule 1 as well, and should,
# because IAM cannot be forgotten by a new code path. Add to
# aws_iam_role_policy.app_runtime's DocumentObjectsWorkspacePrefixOnly
# statement, or as a companion Deny:
#
#     Condition = {
#       StringNotEquals = { "s3:ExistingObjectTag/av-status" = "clean" }
#     }
#
# on s3:GetObject / s3:GetObjectVersion. Two caveats before anyone applies it
# blindly: it must NOT be added to the PutObject actions (nothing could ever
# upload — the tag does not exist until after the scan), and it will break
# every read until the scanner is actually running, so it lands in the same PR
# that raises desired_count above zero. Sequenced that way it is the strongest
# form of this control available, because it holds even for code that has
# never heard of av-status.
# ==========================================================================

# ==========================================================================
# 9. COST (Appendix B.2 puts staging at ~$140–170/month total)
#
# TODAY, with the scanner at desired_count = 0 and the schedule DISABLED:
#
#   SQS (2 queues)                 $0.00  long polling keeps a warm consumer's
#                                         ~130k req/mo inside the 1M free tier
#   EventBridge (3 rules)          $0.00  AWS-source events on the default bus
#                                         are free; rules and targets are free
#   EventBridge Scheduler          $0.00  180 invocations/mo vs 14M free
#   S3 quarantine bucket           $0.00  empty until something is infected
#   S3 signature bucket            $0.01  ~250 MB + 2 days of versions
#   ECR repository                 $0.05  ~500 MB image at $0.10/GB
#   CloudWatch log group           ~$0.50 depends entirely on log volume
#   4 alarms                       $0.40  $0.10 each; all four are metric or
#                                         event based, none need request metrics
#   KMS                            $0.00  no new CMK - reuses docs and ops
#   ----------------------------------------
#   Total today                   ~$1.00/month
#
# WHEN THE SCANNER IS SWITCHED ON (desired_count = 1):
#
#   Fargate 0.5 vCPU + 4 GB ARM64  $7.70  on FARGATE_SPOT (~$25.50 on-demand)
#   Public IPv4                    $3.65  no NAT in staging (Appendix B.3)
#   freshclam, 6 × ~2 min/day      $0.10
#   ----------------------------------------
#   Added                         ~$11.45/month  (~$29 if moved off Spot)
#
# ~$11/month is about 8% of the staging envelope for a mandatory security
# control, which is proportionate. ~$29/month on-demand is 19% and is not, in
# staging — hence Spot, and hence the note on the service that prod should make
# the opposite choice.
#
# ⚠ THE HONEST RECOMMENDATION: do not raise desired_count until there is an
# ingestion pipeline to feed it. A warm scanner with an empty queue costs
# ~$11/month to scan nothing, and the 4 GB it holds is 4 GB of signature
# database, not of readiness. The queue is durable for 4 days; the moment the
# ingestion path exists, raising the count drains whatever accumulated.
#
# WHAT IS DELIBERATELY NOT HERE:
#   * Queue-depth autoscaling on this service (runbook §6.4 pattern). It cannot
#     be wired while desired_count is pinned at 0 and in ignore_changes, and an
#     autoscaling target that fights a manual count is worse than none.
#   * S3 request metrics on any bucket. See the quarantine alert note —
#     ~$4.80/month per filter to duplicate free EventBridge data.
#   * A scan-duration / scan-verdict custom metric (av.scan.duration,
#     av.verdict.infected in Neoting/Pipeline). The task role deliberately has
#     no cloudwatch:PutMetricData. Add both together when the scanner emits
#     them, and mind observability.tf's cardinality rule: never dimension by
#     document, user or workspace ID.
#   * Cross-region replication of quarantine. Malware is not something we want
#     a second copy of, in a second jurisdiction, under D30.
# ==========================================================================

output "av_scan_queue_url" {
  value       = aws_sqs_queue.av_scan.url
  description = "S3 object-created events awaiting a virus scan. Nothing consumes it until the scanner service leaves desired_count = 0."
}

output "av_scan_dlq_url" {
  value       = aws_sqs_queue.av_scan_dlq.url
  description = "Unscanned documents. Alarmed at any depth - a message here is a Gov §11.4 control that did not run."
}

output "quarantine_bucket_name" { value = aws_s3_bucket.quarantine.id }

output "av_signature_bucket_name" {
  value       = aws_s3_bucket.avdefs.id
  description = "Private signature distribution. Scanner tasks pull from here, NEVER from the public ClamAV mirrors."
}

output "clamav_repository_url" { value = aws_ecr_repository.clamav.repository_url }

output "clamav_service_name" {
  value       = aws_ecs_service.clamav.name
  description = "Runs at desired_count = 0 until an image exists; until then NOTHING IS BEING SCANNED."
}
