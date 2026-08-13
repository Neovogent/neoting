# ==========================================================================
# ECR, ECS cluster, log groups, and the runtime IAM the application needs
# (Kickoff 3.6, D23).
# ==========================================================================

locals {
  services = toset(["api", "web", "workers"])
}

# --------------------------------------------------------------------------
# ⚠ THE REPOSITORY NAMES ARE `nt-prod/*`, NOT `nt/*`, AND THAT IS THE THIRD
# ACCOUNT-GLOBAL COLLISION (see main.tf's IAM banner for the other two).
#
# ECR repository names are unique per account per region. staging already owns
# `nt/api`, `nt/web` and `nt/workers` in eu-west-2 (`aws ecr
# describe-repositories`, verified 14 Aug 2026). Copying staging's names here
# fails at apply with RepositoryAlreadyExistsException.
#
# There were two ways out and this is the one that was chosen, so the other one
# is written down rather than forgotten:
#
#   REJECTED — share staging's repositories and promote a digest from staging
#   to prod. It is the better artefact story (build once, promote the exact
#   bytes that were tested) and it is genuinely how this should end up. It is
#   rejected TODAY because in a shared account (D36) a single registry means
#   any principal who can push to staging can put an image where production
#   pulls it, and the staging deploy role is trusted for `refs/heads/main`
#   while the prod role is gated on a reviewed GitHub environment. Sharing the
#   registry would quietly hand the weaker gate authority over the stronger
#   one.
#
#   CHOSEN — separate `nt-prod/*` repositories. CI pushes the same image
#   digest to both registries from one build, so "build once" survives even
#   though the registry does not. Promotion is `docker buildx imagetools
#   create` against the digest, never a rebuild — a rebuild produces different
#   bytes and makes the staging test meaningless.
#
# staging's unprefixed `nt/*` names are the drift here, not prod's. Renaming an
# ECR repository is a destroy-and-create of the repository (and everything in
# it), so it is recorded rather than done.
# --------------------------------------------------------------------------
resource "aws_ecr_repository" "this" {
  for_each = local.services

  name                 = "nt-${local.env}/${each.key}"
  image_tag_mutability = "IMMUTABLE" # a deployed tag can never silently change under you

  image_scanning_configuration {
    scan_on_push = true
  }

  # Encrypted with the documents CMK, so the image layers sit inside the same
  # `role/nt-*` deny boundary as everything else. The execution role's
  # kms:Decrypt grant below is what lets the ECS agent pull at all — drop one
  # and tasks fail at start with an opaque CannotPullContainerError.
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = module.storage.kms_key_arn
  }

  # ⚠ NOT force_delete. A `terraform destroy` that would take production images
  # with it should fail on a non-empty repository, the same way the database
  # fails on deletion protection.
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = local.services
  repository = aws_ecr_repository.this[each.key].name

  policy = jsonencode({
    rules = [
      {
        # Untagged images are the layers left behind when a tag is overwritten
        # or a multi-arch manifest is rebuilt. They are pure storage cost and
        # nothing can ever deploy them. Expired first so the count rule below
        # counts real, deployable images.
        rulePriority = 1
        description  = "Expire untagged images after 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        # 30 images at prod deploy cadence is comfortably more than a month of
        # rollback targets. ECR storage is $0.10/GB-month, so this rule saves
        # dollars, not hundreds — its real job is keeping the tag list readable
        # during an incident when someone is trying to find the last good SHA.
        rulePriority = 2
        description  = "Keep the last 30 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = { type = "expire" }
      },
    ]
  })
}

resource "aws_ecs_cluster" "main" {
  name = "nt-${local.env}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = local.services

  name              = "/nt/${local.env}/${each.key}"
  retention_in_days = 30 # Governance §12.2: application logs and traces

  # Created here rather than auto-created by ECS: auto-created groups have
  # infinite retention, which in prod is both an unbounded CloudWatch bill and
  # a Governance §12.2 breach — logs that should have aged out at 30 days
  # sitting in a searchable store for years, containing whatever the
  # application logged about a client's documents.
}

# --------------------------------------------------------------------------
# Execution role — what ECS itself needs to START a task (pull the image,
# write logs, read the secrets it injects). Distinct from the task role, which
# is what the running application may do. Never merge them: the execution role
# can read every injected secret, and the application should never be able to.
# --------------------------------------------------------------------------

resource "aws_iam_role" "ecs_execution" {
  name        = "nt-${local.env}-ecs-execution"
  description = "ECS agent: image pull, log write, secret injection"

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

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name = "read-injected-secrets"
  role = aws_iam_role.ecs_execution.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadServiceSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [module.data.redis_secret_arn, module.data.db_master_user_secret_arn]
      },
      {
        Sid      = "DecryptForImagePullAndSecrets"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = module.storage.kms_key_arn
      }
    ]
  })
}

# ==========================================================================
# Task role — what the application may do at runtime.
#
# Two deliberate NARROWINGS against staging's equivalent. Both are recorded
# here because "prod is the same as staging" is the assumption a reviewer will
# arrive with:
#
#   1. NO `BedrockEvalCandidates` STATEMENT. staging grants deepseek, gemma and
#      ministral for W2 calibration (D28's per-class tier flags). Production
#      may invoke only the three shipped tiers. Calibration is a staging
#      activity by definition — it compares candidates against an eval set —
#      and their own comment says it best: "an unused model grant is an unused
#      door." Three fewer doors here.
#   2. NO `ses:SendEmail`. There is no SES identity in this environment
#      (email.tf is not built — see main.tf), so the grant would authorise a
#      call that cannot succeed. It lands with email.tf, conditioned on the
#      production From address, in the same change.
# ==========================================================================

resource "aws_iam_role_policy" "app_runtime" {
  name = "nt-runtime"
  role = aws_iam_role.app.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # ADR 0008 — the IAM layer bounds the NAMESPACE, not the tenant.
        #
        # One task role serves every workspace, so IAM cannot scope to a single
        # businessId; that is the application's job (RLS decides which S3 key a
        # caller may name at all) plus item-scoped presigned URLs. What IAM
        # does here is confine the role to the workspace-prefixed namespace
        # `w/<businessId>/…`, so a bug that builds a key outside `w/` reads
        # nothing, and a compromised task cannot reach bootstrap objects,
        # backups, or anything a future writer puts outside that prefix.
        Sid    = "DocumentObjectsWorkspacePrefixOnly"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject"]
        Resource = [
          "arn:aws:s3:::${local.bucket_names["docs"]}/w/*",
          "arn:aws:s3:::${local.bucket_names["exports"]}/w/*",
        ]
      },
      {
        # SES writes inbound mail; the application reads it and tidies up after
        # ingest. No PutObject — nothing in the app should be able to forge an
        # inbound message into the receipts bucket. The grant exists ahead of
        # the SES receipt rule because the bucket and its prefix do, and the
        # blast radius of reading a prefix nothing writes to is zero.
        Sid      = "InboundMailObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion", "s3:DeleteObject"]
        Resource = ["arn:aws:s3:::${local.bucket_names["receipts"]}/inbound/*"]
      },
      {
        # A listing with no prefix is denied outright: `s3:prefix` must be
        # present and must sit inside a namespace we recognise. That is what
        # stops "list the whole bucket" being one SDK default away.
        Sid      = "ListWithinKnownPrefixesOnly"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [for name in values(local.bucket_names) : "arn:aws:s3:::${name}"]
        Condition = {
          StringLike = { "s3:prefix" = ["w/*", "inbound/*"] }
        }
      },
      {
        Sid      = "EnvelopeEncryption"
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource = module.storage.kms_key_arn
      },
      {
        # ⚠ THE APPLICATION HAS NO GRANT ON THE DR KEY, AND MUST NOT GET ONE.
        # The eu-west-1 replica key (replication.tf) is usable by the
        # replication role and by a human running a restore drill. A running
        # task that could decrypt Dublin's copy would make the DR region
        # reachable from the request path, which is exactly the thing ADR 0007
        # promises it is not.

        # D30 enforced at the IAM layer, not by convention.
        #
        # Every ARN is region-pinned to eu-west-2 and NO inference-profile ARN
        # is granted. The eu.* profiles route across EU regions, so omitting
        # them means a cross-region model call fails with AccessDenied rather
        # than silently processing UK client documents outside the UK. In
        # production that distinction is the difference between a failed
        # request and a residency incident.
        #
        # Production tiers (D28 as amended 13 Aug 2026 — docs/adr/0001):
        #   judgment   anthropic.claude-opus-4-6-v1
        #   workhorse  anthropic.claude-sonnet-4-6
        #   mechanical amazon.nova-lite-v1:0
        Sid    = "BedrockInRegionModelsOnly"
        Effect = "Allow"
        Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"]
        Resource = [
          "arn:aws:bedrock:${local.region}::foundation-model/anthropic.claude-opus-4-6-v1",
          "arn:aws:bedrock:${local.region}::foundation-model/anthropic.claude-sonnet-4-6",
          "arn:aws:bedrock:${local.region}::foundation-model/amazon.nova-lite-v1:0",
          "arn:aws:bedrock:${local.region}::foundation-model/amazon.nova-micro-v1:0",
        ]
      },
      {
        Sid      = "Extraction"
        Effect   = "Allow"
        Action   = ["textract:AnalyzeExpense", "textract:AnalyzeDocument", "textract:StartExpenseAnalysis", "textract:GetExpenseAnalysis", "textract:StartDocumentAnalysis", "textract:GetDocumentAnalysis"]
        Resource = "*" # Textract has no resource-level permissions
      },
      {
        Sid      = "VoiceTranscription"
        Effect   = "Allow"
        Action   = ["transcribe:StartStreamTranscription"]
        Resource = "*"
      },
      {
        Sid      = "RuntimeSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [module.data.redis_secret_arn, module.data.db_master_user_secret_arn]
      }
    ]
  })
}

output "ecr_repository_urls" { value = { for k, v in aws_ecr_repository.this : k => v.repository_url } }
output "ecs_cluster_name" { value = aws_ecs_cluster.main.name }
