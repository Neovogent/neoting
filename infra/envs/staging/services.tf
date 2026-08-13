# --------------------------------------------------------------------------
# Task definitions and services — the "S4" half of compute.tf (runbook §6.4).
#
# api     — HTTP, behind the ALB target group in alb.tf.
# workers — BullMQ consumers. A SEPARATE service on purpose (§6.4): queue depth
#           and HTTP request rate are unrelated signals, and a worker that
#           pins a CPU chewing a 300-page statement must never be able to
#           starve the request path.
# web     — NOT here. Vercel covers apps/web for the sprint (G6/§6.4); the ECR
#           repo and the /nt/staging/web log group in compute.tf sit unused
#           until Infra Week, which costs nothing and saves a migration later.
# --------------------------------------------------------------------------

locals {
  # No image exists in ECR yet. This tag is a placeholder: the services below
  # run at desired_count = 0, and CI registers a new revision pinned to the
  # git SHA (ECR tags are IMMUTABLE — compute.tf — so a tag can never move
  # under a running task). Terraform never sees that revision because
  # task_definition is in ignore_changes on both services.
  image_tag = "bootstrap"

  # COST DECISION (Appendix B.2 budgets Fargate at $30–40/mo for this shape).
  # Sized down from the runbook's 0.5 vCPU api because a Node process serving
  # staging smoke traffic is memory-bound, not CPU-bound; 0.25 vCPU is the
  # smallest Fargate step and burst is handled by the second task.
  #
  # Per task, at eu-west-2 ARM64 rates ($0.03725/vCPU-hr, $0.00409/GB-hr):
  #   api      0.25 vCPU + 1 GB  ≈ $0.0134/hr ≈ $9.80/mo  × 2 tasks
  #   workers  0.5  vCPU + 1 GB  ≈ $0.0227/hr ≈ $16.60/mo × 1 task (Spot: ~$5)
  # Plus ~$3.60/mo of public IPv4 per task — see the assign_public_ip note on
  # the services. Valid Fargate cpu/memory pairs are fixed; 256 CPU accepts
  # only 512/1024/2048 MB.
  task_size = {
    api     = { cpu = 256, memory = 1024 }
    workers = { cpu = 512, memory = 1024 }
  }

  # Non-secret runtime coordinates. Endpoints and bucket names are not
  # credentials — putting them in `environment` keeps them greppable in the
  # console and keeps the Secrets Manager GetSecretValue call at task start to
  # exactly two requests.
  common_environment = [
    # NODE_ENV=production because staging runs the production build (G1
    # parity). The environment's identity travels separately, so nothing keys
    # behaviour off NODE_ENV and accidentally behaves differently in prod.
    { name = "NODE_ENV", value = "production" },
    { name = "NEOTING_ENV", value = local.env },
    { name = "AWS_REGION", value = local.region },

    # Storage is UTC, full stop (CLAUDE.md invariant, Gov §12). Europe/London
    # is applied at render time by the app — never by the container clock, or
    # a BST-vs-GMT boundary silently rewrites every timestamp for an hour.
    { name = "TZ", value = "UTC" },

    { name = "DATABASE_HOST", value = module.data.db_address },
    { name = "DATABASE_PORT", value = "5432" },
    { name = "DATABASE_NAME", value = module.data.db_name },

    { name = "REDIS_HOST", value = module.data.redis_primary_endpoint_address },
    { name = "REDIS_PORT", value = "6379" },
    { name = "REDIS_TLS", value = "true" }, # transit encryption is on (data.tf); a non-TLS client just hangs

    { name = "S3_BUCKET_DOCS", value = local.bucket_names["docs"] },
    { name = "S3_BUCKET_RECEIPTS", value = local.bucket_names["receipts"] },
    { name = "S3_BUCKET_EXPORTS", value = local.bucket_names["exports"] },
    { name = "KMS_KEY_ARN", value = module.storage.kms_key_arn },
  ]

  # ------------------------------------------------------------------------
  # Secrets — injected by the ECS agent at task start from Secrets Manager,
  # never as plaintext `environment` values (Gov §11.5, runbook §6.4). The
  # `:key::` suffix selects one field out of the secret's JSON, so the app
  # gets the field it needs and nothing else. Format is
  # <arn>:<json-key>:<version-stage>:<version-id>; the trailing colons are
  # required even when empty.
  #
  # ⚠ ONLY the two secrets that exist today are wired. Adding an entry here
  # WITHOUT adding its ARN to `aws_iam_role_policy.ecs_execution_secrets`
  # (compute.tf) makes every task fail at start with
  # ResourceInitializationError — which reads like a broken image and is not.
  #
  # TODO when secrets.tf lands (/neoting/${local.env}/<group>), add:
  #   app        DATABASE_URL for the nt_app role (see below), SESSION_SECRET,
  #              the OTP pepper (Gov §11.8)
  #   twilio     SMS sending — Gov: chase templates are a stop-and-ask change
  #   meta       WhatsApp Business
  #   xero/qbo   PLATFORM client id + secret only. Per-tenant OAuth tokens
  #              live encrypted in the DB vault table (SoT §18), NOT here.
  #   truelayer  bank feed credentials
  # and extend the execution-role policy in the same PR.
  # ------------------------------------------------------------------------
  injected_secrets = [
    { name = "REDIS_AUTH_TOKEN", valueFrom = "${module.data.redis_secret_arn}:auth_token::" },
  ]

  # ⚠ THE RDS MASTER CREDENTIAL GOES TO THE MIGRATION TASK AND NOWHERE ELSE.
  #
  # An earlier revision put these in `injected_secrets` — the list injected
  # into BOTH long-running services — defended by the comment that naming them
  # MIGRATOR rather than DATABASE_* stopped application code picking them up by
  # accident. That defence is a naming convention, and a naming convention is
  # not a control.
  #
  # The master user owns the schema and holds `rds_superuser`. A table owner is
  # subject to FORCE ROW LEVEL SECURITY, but a superuser is NOT — so this
  # credential bypasses every tenancy policy in prisma/ outright (Gov §5.2).
  # Sitting in the environment of a service that runs for weeks, it is
  # available to anything that achieves code execution in that container, to
  # any dependency that dumps env on start, and to any crash handler that
  # serialises the process environment. "No code reads it" is not the property
  # that matters; "no code CAN read it" is, and only the second one survives a
  # dependency you did not write.
  #
  # `prisma migrate deploy` is a one-off task in the deploy pipeline (runbook
  # §6.4), so the credential belongs on a task definition with no service
  # attached — it exists only for the seconds a migration runs.
  migration_secrets = [
    { name = "DB_MIGRATOR_USER", valueFrom = "${module.data.db_master_user_secret_arn}:username::" },
    { name = "DB_MIGRATOR_PASSWORD", valueFrom = "${module.data.db_master_user_secret_arn}:password::" },

    # The non-owning role the application itself connects as. The migration
    # needs it to CREATE ROLE / ALTER ROLE with the right password — see
    # db-app-role.tf, which owns the credential and documents the SQL half.
    { name = "DB_APP_ROLE_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db_app_role.arn}:password::" },
  ]
}

# --------------------------------------------------------------------------
# Migration task — `pnpm prisma migrate deploy`, run once per deploy.
#
# No aws_ecs_service: this is a task definition the pipeline invokes with
# `ecs run-task` and waits on. That is the whole point — it is the only place
# the master credential exists, and it exists for the duration of a migration
# rather than the duration of an environment.
#
# Governance §1.3: `migrate deploy` is the ONLY migration command that runs
# anywhere except a developer laptop. `migrate dev` must never appear here.
# --------------------------------------------------------------------------
resource "aws_ecs_task_definition" "migrate" {
  family                   = "nt-${local.env}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.app.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "migrate"
      image     = "${aws_ecr_repository.this["api"].repository_url}:${local.image_tag}"
      essential = true

      # Overridden by the pipeline if a different entrypoint is wanted; stated
      # here so the task is runnable by hand during an incident without anyone
      # having to remember the command.
      command = ["pnpm", "prisma", "migrate", "deploy"]

      environment = concat(local.common_environment, [
        { name = "SERVICE_NAME", value = "migrate" },
      ])

      secrets = local.migration_secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.migrate.name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "migrate"
        }
      }
    }
  ])
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/nt/${local.env}/migrate"
  retention_in_days = 30 # Governance §12.2

  tags = { Component = "migrate" }
}

# --------------------------------------------------------------------------
# Capacity providers on the existing cluster.
#
# Registered here so the Spot/on-demand split below is a one-line strategy
# change rather than a cluster edit. FARGATE is the default so anything that
# forgets to declare a strategy lands on on-demand, never on Spot by surprise.
# --------------------------------------------------------------------------

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }
}

# --------------------------------------------------------------------------
# Task definitions.
#
# ARM64 (Graviton) on both: Fargate ARM64 is ~20% cheaper per vCPU-hour than
# x86, which is ~$7/mo here and scales with every task prod ever runs. The
# data tier is already Graviton (db.t4g, cache.t4g), so this keeps one
# architecture story.
#
# ⚠ THE PRICE OF THAT: the Dockerfiles MUST produce linux/arm64 images
# (`docker buildx build --platform linux/arm64`). An x86 image on an ARM64
# task definition dies instantly with "exec format error" and nothing else.
# If CI cannot build arm64 yet, flip cpu_architecture to X86_64 here — the
# cost of that flip is a few dollars a month, which is cheaper than a day
# lost to a confusing deploy.
# --------------------------------------------------------------------------

resource "aws_ecs_task_definition" "api" {
  family                   = "nt-${local.env}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc" # mandatory on Fargate; it is what makes target_type = "ip" work
  cpu                      = local.task_size["api"].cpu
  memory                   = local.task_size["api"].memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn # pulls the image, writes logs, reads the secrets above
  task_role_arn            = aws_iam_role.app.arn           # what the app itself may do (S3, KMS, Bedrock, Textract, SES)

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  # ephemeral_storage is deliberately unset: Fargate gives 20 GiB free and
  # bills every GiB above it. Document temp files fit; anything that does not
  # belongs in S3 anyway.

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = "${aws_ecr_repository.this["api"].repository_url}:${local.image_tag}"
      essential = true

      portMappings = [
        {
          containerPort = local.app_port
          protocol      = "tcp"
        }
      ]

      environment = concat(local.common_environment, [
        { name = "SERVICE_NAME", value = "api" },
        { name = "PORT", value = tostring(local.app_port) },
      ])

      secrets = local.injected_secrets

      # No container-level healthCheck: the ALB target group already probes
      # /healthz from outside the task, and a container check would need curl
      # baked into the image purely to duplicate it. workers, which has no
      # load balancer, is the case where one is actually needed — see below.

      # PID 1 in a container reaps nothing. Without init, every child process
      # the app spawns (pdf tooling, image conversion) leaves a zombie until
      # the task runs out of process slots — days later, in staging, on a
      # Friday.
      linuxParameters = {
        initProcessEnabled = true
      }

      # readonlyRootFilesystem is NOT set: extraction writes temp files to
      # /tmp and Fargate does not support tmpfs mounts, so a read-only root
      # would mean an EFS volume — cost and complexity for a staging
      # environment that holds synthetic data only (G2).

      # ECS drains the target for deregistration_delay (30s) before the SIGTERM
      # lands, so 30s here is enough to finish in-flight requests.
      stopTimeout = 30

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          # The pre-created group (compute.tf) — 30-day retention, Gov §12.2.
          # Never let ECS auto-create this: auto-created groups keep logs
          # forever, and CloudWatch ingest is Appendix B.2's sleeper line item.
          "awslogs-group"         = aws_cloudwatch_log_group.service["api"].name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = { Component = "api" }
}

resource "aws_ecs_task_definition" "workers" {
  family                   = "nt-${local.env}-workers"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.task_size["workers"].cpu
  memory                   = local.task_size["workers"].memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.app.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "workers"
      image     = "${aws_ecr_repository.this["workers"].repository_url}:${local.image_tag}"
      essential = true

      # No portMappings: BullMQ consumers pull from Redis. Nothing dials in,
      # and the app security group has no inbound rule that would let it.

      environment = concat(local.common_environment, [
        { name = "SERVICE_NAME", value = "workers" },

        # One task, modest concurrency. Queue-depth autoscaling (runbook §6.4,
        # Gov §13.2 alerts on queue age > 5 min) is a follow-up: it cannot be
        # wired while desired_count is pinned at 0 and ignored below.
        { name = "WORKER_CONCURRENCY", value = "4" },
      ])

      secrets = local.injected_secrets

      # TODO: with no load balancer there is nothing probing this container.
      # Add a healthCheck once the image ships a `node dist/healthz.js` style
      # command that asserts Redis reachability — until then a worker that has
      # silently stopped consuming looks identical to an idle one.

      linuxParameters = {
        initProcessEnabled = true
      }

      # 120s is the Fargate maximum and it is here for Spot: an interruption
      # gives a two-minute warning, so the worker must catch SIGTERM, stop
      # accepting new jobs, and let the in-flight one finish. A job killed
      # mid-flight is re-delivered by BullMQ, so this is about not doing
      # Textract/Bedrock work twice — i.e. about the bill (D28's
      # < £0.02/document guardrail).
      stopTimeout = 120

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service["workers"].name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = { Component = "workers" }
}

# --------------------------------------------------------------------------
# Services.
#
# ⚠ BOTH RUN AT desired_count = 0 AND THAT IS DELIBERATE.
#
# There is no image in ECR yet (local.image_tag above). A service with
# desired_count > 0 would launch a task, fail the image pull, back off, and
# retry forever — burning Fargate minutes, filling the log group we pay to
# ingest, and firing the circuit breaker on every apply. Deploying for the
# first time is therefore a count change (CI, or `aws ecs update-service
# --desired-count 2`), not an infrastructure change. That is also why
# desired_count is in ignore_changes: once CI or autoscaling owns the number,
# a `terraform apply` from anyone's laptop must never quietly scale staging
# back to whatever this file happens to say.
#
# task_definition is ignored for the same reason: CI registers a new revision
# per deploy and points the service at it. Without the ignore, the next apply
# would roll staging back to the placeholder revision below — the classic
# "who redeployed last week's build?" incident.
# --------------------------------------------------------------------------

resource "aws_ecs_service" "api" {
  name            = "nt-${local.env}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 0

  # On-demand, never Spot, for anything serving HTTP — a Spot reclaim is a
  # two-minute warning and then a dead target. Appendix B.2 allows Spot for
  # workers only, and staging keeps the same shape as prod so the shape is
  # what gets tested.
  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }

  # Runbook §6.4 / Gov §14.9, §16: this IS the "auto-rollback on health
  # regression". A deployment whose tasks cannot pass the target-group check
  # is rolled back to the last good revision by ECS itself, without a human.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # 100/200: never drop below full capacity during a deploy. With only two
  # tasks, allowing 50% would leave a single task serving everything for the
  # length of a rollout. The extra task exists for minutes and costs cents.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # Node + Prisma needs a moment to connect before /healthz answers. Too low
  # and a cold start looks like a failed deploy to the circuit breaker.
  health_check_grace_period_seconds = 60

  network_configuration {
    subnets         = module.network.public_subnet_ids
    security_groups = [module.network.app_security_group_id]

    # There is NO NAT gateway in staging by design (network.tf, Appendix
    # B.3): a public IP is how the task reaches ECR, Secrets Manager, Bedrock
    # and Textract at all. Nothing can reach IN — the app SG's only ingress is
    # from the ALB SG on 3000. Public IPv4 is ~$3.60/task/mo, so three tasks
    # is ~$11/mo against a NAT's ~$36/mo + data processing. That trade stops
    # paying at roughly ten tasks; prod gets the NAT.
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = local.app_port
  }

  # ECS-managed tags plus the provider's default_tags reach the tasks and ENIs
  # themselves, which is what makes per-service cost attribution (Gov §13.5)
  # possible in Cost Explorer rather than a guess.
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  # ECS Exec stays OFF: the task role (compute.tf) grants no
  # ssmmessages:* permissions, and enabling it without them produces a task
  # that runs with a permanently STOPPED managed agent — a broken debugging
  # tool is worse than an absent one. Turning it on is a task-role change
  # first (runbook §6.1: no bastion, no SSH).
  enable_execute_command = false

  # A target group must already be attached to a load balancer before ECS will
  # accept the service. The HTTPS listener's default action is a 403, so the
  # attachment only happens via the origin-verified rule. The capacity
  # provider association is not visible to Terraform through `cluster` alone,
  # and creating a service that names FARGATE before the cluster lists it
  # fails with "capacity provider not associated".
  depends_on = [
    aws_lb_listener.https,
    aws_lb_listener_rule.api_origin_verified,
    aws_ecs_cluster_capacity_providers.main,
  ]

  tags = { Component = "api" }

  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }
}

resource "aws_ecs_service" "workers" {
  name            = "nt-${local.env}-workers"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.workers.arn
  desired_count   = 0

  # COST DECISION (Appendix B.2: "Spot for workers"): Fargate Spot is ~70%
  # cheaper, taking this task from ~$16.60/mo to ~$5/mo. Acceptable because a
  # reclaimed worker costs a re-delivered BullMQ job, not a failed user
  # request — and staging is synthetic-data-only (G2). Never for the api, and
  # never for prod workers without a queue-lag SLO to check it against.
  #
  # ⚠ Verify at first deploy that Fargate Spot places ARM64 tasks in
  # eu-west-2. If placement is rejected, either move this strategy to FARGATE
  # (+~$11/mo) or set this task definition to X86_64.
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
    base              = 0
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # 0/100, the opposite of api, on purpose: replace in place rather than
  # running old and new consumers side by side. Doubling consumers mid-deploy
  # doubles concurrent Textract/Bedrock calls against the same queue for no
  # benefit, and there is no availability to protect — the queue simply waits.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  network_configuration {
    subnets          = module.network.public_subnet_ids
    security_groups  = [module.network.app_security_group_id]
    assign_public_ip = true # no NAT — see the api service above
  }

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"
  enable_execute_command  = false

  # FARGATE_SPOT must be associated with the cluster before a service may name
  # it; that link is invisible to Terraform's graph through `cluster` alone.
  depends_on = [aws_ecs_cluster_capacity_providers.main]

  tags = { Component = "workers" }

  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }
}

# --------------------------------------------------------------------------
output "ecs_service_names" {
  value = {
    api     = aws_ecs_service.api.name
    workers = aws_ecs_service.workers.name
  }
  description = "Both run at desired_count = 0 until an image exists; deploying is a count change."
}

output "ecs_task_families" {
  value = {
    api     = aws_ecs_task_definition.api.family
    workers = aws_ecs_task_definition.workers.family
  }
}
