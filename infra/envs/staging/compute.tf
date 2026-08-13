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
    kms_key         = aws_kms_key.docs.arn
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
        Sid      = "ReadServiceSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [aws_secretsmanager_secret.redis.arn, aws_db_instance.main.master_user_secret[0].secret_arn]
      },
      {
        Sid      = "DecryptForImagePullAndSecrets"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.docs.arn
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
        Sid    = "DocumentStorage"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
        Resource = flatten([
          for name in values(local.bucket_names) : [
            "arn:aws:s3:::${name}",
            "arn:aws:s3:::${name}/*",
          ]
        ])
      },
      {
        Sid      = "EnvelopeEncryption"
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource = aws_kms_key.docs.arn
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
        Resource = [aws_secretsmanager_secret.redis.arn, aws_db_instance.main.master_user_secret[0].secret_arn]
      }
    ]
  })
}

output "ecr_repository_urls" { value = { for k, v in aws_ecr_repository.this : k => v.repository_url } }
output "ecs_cluster_name" { value = aws_ecs_cluster.main.name }
output "vpc_id" { value = aws_vpc.main.id }
output "public_subnet_ids" { value = aws_subnet.public[*].id }
