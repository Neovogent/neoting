# --------------------------------------------------------------------------
# ECR, ECS cluster, log groups, and the runtime IAM the application needs
# (Kickoff 3.6, D23). Task definitions and services land with the app in S4.
# --------------------------------------------------------------------------

locals {
  services = toset(["api", "web", "workers"])
}

resource "aws_ecr_repository" "this" {
  for_each = local.services

  name                 = "nt/${each.key}"
  image_tag_mutability = "IMMUTABLE" # a deployed tag can never silently change under you

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = module.storage.kms_key_arn
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = local.services
  repository = aws_ecr_repository.this[each.key].name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 30
      }
      action = { type = "expire" }
    }]
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
  retention_in_days = 30 # Governance §12.2

  # Created here rather than auto-created by ECS: auto-created groups have
  # infinite retention, which is both a cost leak and a compliance problem.
}

# --------------------------------------------------------------------------
# Execution role — what ECS itself needs to START a task (pull the image,
# write logs, read the secrets it injects). Distinct from the task role,
# which is what the running application may do. Never merge them.
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
        Sid    = "ReadServiceSecrets"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          module.data.redis_secret_arn,
          module.data.db_master_user_secret_arn,
          # The Meta webhook pair (services.tf `injected_secrets`). services.tf
          # warns that adding an entry there without its ARN here makes EVERY
          # task fail at start with ResourceInitializationError — which reads
          # like a broken image and is not. This is that ARN.
          aws_secretsmanager_secret.app["whatsapp"].arn,
        ]
      },
      {
        Sid    = "DecryptForImagePullAndSecrets"
        Effect = "Allow"
        Action = ["kms:Decrypt"]
        Resource = [
          module.storage.kms_key_arn,
          # ⚠ THE SECOND KEY IS NOT OPTIONAL AND IS EASY TO MISS. The vendor
          # secrets in secrets.tf are encrypted with a DEDICATED CMK
          # (`aws_kms_key.secrets`, alias/nt-staging-secrets), not the documents
          # key. Granting GetSecretValue without Decrypt on that key fails at
          # task start with an AccessDeniedException naming KMS, not Secrets
          # Manager, so the obvious next move is to widen the wrong policy.
          #
          # The redis and RDS-managed secrets above did not need this because
          # they sit under an AWS-managed key the execution role can already use
          # — which is exactly why the omission survived until the first
          # customer-managed secret was injected.
          aws_kms_key.secrets.arn,
        ]
      }
    ]
  })
}

# --------------------------------------------------------------------------
# Task role — what the application may do at runtime.
# --------------------------------------------------------------------------

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
        # businessId; that scoping is the application's job (RLS decides which
        # S3 key a caller may name at all) plus item-scoped presigned URLs.
        # What IAM can do, and from here does, is confine the role to the
        # workspace-prefixed namespace `w/<businessId>/…`. A bug that builds a
        # key outside `w/` now reads nothing, and a compromised task cannot
        # reach bootstrap objects, backups, or anything a future writer puts
        # outside that prefix.
        #
        # This statement exists because Governance §5.2 and SoT §15 both promise
        # "IAM prefix conditions on the task role" — and until it was written,
        # both documents described a control that was not built. The previous
        # version granted every action on `<bucket>/*` with no condition.
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
        # inbound message into the receipts bucket.
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
        # D30 enforced at the IAM layer, not by convention.
        #
        # Every ARN below is region-pinned to eu-west-2 and NO inference-profile
        # ARN is granted. The eu.* profiles route across EU regions, so omitting
        # them means a cross-region model call fails with AccessDenied rather
        # than silently processing UK client documents outside the UK.
        #
        # Production tiers (D28 as amended 13 Aug 2026 — see docs/adr/0001):
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
        # W2 calibration candidates only (D28 per-class tier flags: a flip is
        # blocked unless evals pass for that (class, model) pair). Remove the
        # losers from this list when W2 concludes — an unused model grant is
        # an unused door.
        Sid    = "BedrockEvalCandidates"
        Effect = "Allow"
        Action = ["bedrock:InvokeModel", "bedrock:Converse"]
        Resource = [
          "arn:aws:bedrock:${local.region}::foundation-model/deepseek.v3.2",
          "arn:aws:bedrock:${local.region}::foundation-model/google.gemma-3-12b-it",
          "arn:aws:bedrock:${local.region}::foundation-model/mistral.ministral-3-8b-instruct",
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
        Sid      = "OutboundEmail"
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = "*"
        Condition = {
          StringEquals = { "ses:FromAddress" = "doc@${local.domain}" }
        }
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
output "vpc_id" { value = module.network.vpc_id }
output "public_subnet_ids" { value = module.network.public_subnet_ids }
