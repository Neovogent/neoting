# ==========================================================================
# Task definitions and services (runbook §6.4).
#
# api     — HTTP, behind the ALB target group in alb.tf.
# workers — BullMQ consumers. A SEPARATE service on purpose: queue depth and
#           HTTP request rate are unrelated signals, and a worker that pins a
#           CPU chewing a 300-page bank statement must never be able to starve
#           the request path.
# web     — NOT here. The ECR repo and the /nt/prod/web log group exist unused
#           until web moves off Vercel (G6), which costs nothing and saves a
#           migration later.
#
# ⚠ THE NETWORK PLACEMENT IS THE REAL DIFFERENCE FROM STAGING. Every task
# below runs in PRIVATE subnets with `assign_public_ip = false`. In staging
# they sit in public subnets with a public IP because there is no NAT to reach
# ECR or Bedrock through. Here there is, so production tasks have no public
# address at all — not "an address with no inbound rules", no address.
#
# That also removes ~$3.60/task/month of public IPv4 charge, which is a real if
# small offset against the NAT's ~$33/month: at three tasks it is ~$11/month
# back.
# ==========================================================================

locals {
  # No image exists in ECR yet. This tag is a placeholder: the services below
  # run at desired_count = 0, and CI registers a new revision pinned to the git
  # SHA (ECR tags are IMMUTABLE — compute.tf — so a tag can never move under a
  # running task). Terraform never sees that revision because task_definition
  # is in ignore_changes on both services.
  image_tag = "bootstrap"

  # Sized larger than staging on both axes, and the axis that matters is
  # MEMORY, not CPU. A Node process holding a decoded multi-megapixel receipt
  # image plus a Prisma connection pool is memory-bound; the OOM kill is silent
  # from the application's point of view (the container simply vanishes and ECS
  # restarts it) and looks exactly like a crash loop.
  #
  # Per task, at eu-west-2 ARM64 rates ($0.03725/vCPU-hr, $0.00409/GB-hr):
  #   api      0.5 vCPU + 2 GB  ≈ $0.0268/hr ≈ $19.60/mo  × 2 tasks = ~$39/mo
  #   workers  1.0 vCPU + 4 GB  ≈ $0.0536/hr ≈ $39.10/mo  × 1 task  = ~$39/mo
  # ≈ $78/month once prod actually serves. $0 today, because both services are
  # at zero.
  #
  # Valid Fargate cpu/memory pairs are fixed: 512 CPU accepts 1024–4096 MB in
  # 1 GB steps; 1024 CPU accepts 2048–8192 MB.
  task_size = {
    api     = { cpu = 512, memory = 2048 }
    workers = { cpu = 1024, memory = 4096 }
  }

  # Non-secret runtime coordinates. Endpoints and bucket names are not
  # credentials — putting them in `environment` keeps them greppable in the
  # console and keeps the Secrets Manager call at task start to two requests.
  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "NEOTING_ENV", value = local.env },
    { name = "AWS_REGION", value = local.region },

    # Storage is UTC, full stop (CLAUDE.md invariant, Gov §12). Europe/London
    # is applied at render time by the app — never by the container clock, or a
    # BST-vs-GMT boundary silently rewrites every timestamp for an hour. In
    # prod that hour is somebody's VAT quarter.
    { name = "TZ", value = "UTC" },

    { name = "DATABASE_HOST", value = module.data.db_address },
    { name = "DATABASE_PORT", value = "5432" },
    { name = "DATABASE_NAME", value = module.data.db_name },

    { name = "REDIS_HOST", value = module.data.redis_primary_endpoint_address },
    { name = "REDIS_PORT", value = "6379" },
    { name = "REDIS_TLS", value = "true" }, # transit encryption is on; a non-TLS client just hangs

    # S3_BUCKET_DOCUMENTS is the name env.ts actually reads — the DOCS
    # spelling was a latent mismatch found when staging flipped OBJECT_STORE
    # (see envs/staging/services.tf for the full story).
    { name = "S3_BUCKET_DOCUMENTS", value = local.bucket_names["docs"] },
    { name = "S3_BUCKET_RECEIPTS", value = local.bucket_names["receipts"] },
    { name = "S3_BUCKET_EXPORTS", value = local.bucket_names["exports"] },
    { name = "KMS_KEY_ARN", value = module.storage.kms_key_arn },

    # ⚠ REQUIRED FOR BOOT since #84: env.ts refuses AUTH_MODE=fixture (the
    # default) under NODE_ENV=production — the fixture resolver trusts X-NT-*
    # headers for identity, which through CloudFront is an auth bypass.
    # `session` is the resolver S1 implements. Staging found this the hard way
    # (deploys #90–#107 silently rolled back); prod inherits the fix before
    # its first deploy can hit it.
    { name = "AUTH_MODE", value = "session" },

    # The real ingest lane, mirroring staging (which carries the reasoning):
    # BullMQ on Redis, sanitised bytes to S3 under `w/<businessId>/…`, real
    # EXIF/HEIC normalisation. EMAIL_SOURCE and DOCUMENT_GUARD stay on their
    # fixture defaults for the same reasons staging's file states.
    { name = "INGEST_QUEUE", value = "bullmq" },
    { name = "OBJECT_STORE", value = "s3" },
    { name = "IMAGE_NORMALISER", value = "sharp" },
  ]

  # ------------------------------------------------------------------------
  # Secrets — injected by the ECS agent at task start from Secrets Manager,
  # never as plaintext `environment` values (Gov §11.5, runbook §6.4). The
  # `:key::` suffix selects one field out of the secret's JSON. Format is
  # <arn>:<json-key>:<version-stage>:<version-id>; the trailing colons are
  # required even when empty.
  #
  # ⚠ ADDING AN ENTRY HERE WITHOUT ADDING ITS ARN TO THE EXECUTION ROLE
  # (compute.tf for these two, secrets.tf for the vendor groups) makes every
  # task fail at start with ResourceInitializationError — which reads like a
  # broken image and is not.
  #
  # ⚠ AND IN PROD THERE IS A SECOND TRAP: every vendor secret in secrets.tf
  # currently holds a PLACEHOLDER. Wiring one of them in here before a real
  # value has been written means the application boots, Zod-parses
  # "PLACEHOLDER_TWILIO_AUTH_TOKEN" as a perfectly valid string, and fails at
  # the first API call to a third party rather than at boot. Wire each group
  # in the same change that sets its real value.
  # ------------------------------------------------------------------------
  injected_secrets = [
    { name = "REDIS_AUTH_TOKEN", valueFrom = "${module.data.redis_secret_arn}:auth_token::" },

    # The second boot gate (#76): env.ts refuses an empty UPLOAD_URL_SECRET
    # under NODE_ENV=production. Terraform-generated real value (secrets.tf) —
    # exempt from the placeholder trap above by construction.
    { name = "UPLOAD_URL_SECRET", valueFrom = "${aws_secretsmanager_secret.upload_url.arn}:secret::" },
  ]

  # ⚠ THE RDS MASTER CREDENTIAL GOES TO THE MIGRATION TASK AND NOWHERE ELSE.
  #
  # The master user owns the schema and holds `rds_superuser`. A table owner is
  # subject to FORCE ROW LEVEL SECURITY; a superuser is NOT — so this
  # credential bypasses every tenancy policy in prisma/ outright (Gov §5.2).
  # Sitting in the environment of a service that runs for weeks, it is
  # available to anything that achieves code execution in that container, to
  # any dependency that dumps env on start, and to any crash handler that
  # serialises the process environment. "No code reads it" is not the property
  # that matters; "no code CAN read it" is.
  #
  # `prisma migrate deploy` is a one-off task in the deploy pipeline, so the
  # credential belongs on a task definition with no service attached — it
  # exists for the seconds a migration runs.
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
# anywhere except a developer laptop. `migrate dev` must never appear here —
# in production it would try to reset the database.
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
      #
      # ⚠ NOT `pnpm prisma migrate deploy` DIRECTLY — see the identical note in
      # envs/staging/services.tf. ECS cannot interpolate a `secrets` entry into
      # another environment variable, so the DATABASE_URL Prisma reads has to be
      # composed in-process from the injected parts. The wrapper execs the same
      # `prisma migrate deploy` underneath.
      command = ["node", "apps/api/dist/db/migrate.js"]

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
# Capacity providers.
#
# ⚠ FARGATE_SPOT IS REGISTERED ON THE CLUSTER AND USED BY NOTHING. That is
# deliberate: registering it costs nothing, and having it available means an
# experiment (a batch backfill, a one-off reprocessing job) can name it
# explicitly without a cluster change. FARGATE is the default strategy, so
# anything that forgets to declare one lands on on-demand and never on Spot by
# surprise — which in production is the only acceptable default.
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
# x86 and the data tier is already Graviton (db.m7g, cache.t4g), so this keeps
# one architecture story.
#
# ⚠ THE PRICE OF THAT: the Dockerfiles MUST produce linux/arm64 images
# (`docker buildx build --platform linux/arm64`). An x86 image on an ARM64 task
# definition dies instantly with "exec format error" and nothing else. Verify
# this on the FIRST prod deploy, not the first prod incident — and note that
# because staging runs the same architecture, an image that works in staging
# works here.
# --------------------------------------------------------------------------

resource "aws_ecs_task_definition" "api" {
  family                   = "nt-${local.env}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc" # mandatory on Fargate; it is what makes target_type = "ip" work
  cpu                      = local.task_size["api"].cpu
  memory                   = local.task_size["api"].memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn # pulls the image, writes logs, reads the injected secrets
  task_role_arn            = aws_iam_role.app.arn           # what the app itself may do (S3, KMS, Bedrock, Textract)

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
      # baked into the image purely to duplicate it.

      # PID 1 in a container reaps nothing. Without init, every child process
      # the app spawns (pdf tooling, image conversion) leaves a zombie until
      # the task runs out of process slots — days later, on a Friday.
      linuxParameters = {
        initProcessEnabled = true
      }

      # readonlyRootFilesystem is NOT set: extraction writes temp files to /tmp
      # and Fargate does not support tmpfs mounts, so a read-only root means an
      # EFS volume. ⚠ In PRODUCTION that trade deserves revisiting — a writable
      # root filesystem is a real hardening gap in an environment processing
      # untrusted uploads (Gov §11.x, and ClamAV is not built either). Not a
      # blocker for standing the environment up; is a blocker for the first
      # real upload.
      stopTimeout = 30 # ECS drains the target for deregistration_delay (30s) before SIGTERM

      logConfiguration = {
        logDriver = "awslogs"
        options = {
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

        # Modest concurrency per task. Queue-depth autoscaling (runbook §6.4,
        # Gov §13.2 alerts on queue age > 5 min) is a follow-up that cannot be
        # wired while desired_count is pinned at 0 and ignored below — and it
        # needs the alarm estate that is not built yet.
        { name = "WORKER_CONCURRENCY", value = "4" },
      ])

      secrets = local.injected_secrets

      # TODO: with no load balancer there is nothing probing this container.
      # Add a healthCheck once the image ships a `node dist/healthz.js` style
      # command that asserts Redis reachability — until then a worker that has
      # silently stopped consuming looks identical to an idle one, and in
      # production that is a queue backing up with nobody paged.

      linuxParameters = {
        initProcessEnabled = true
      }

      # 120s is the Fargate maximum. The worker must catch SIGTERM, stop
      # accepting new jobs, and let the in-flight one finish. A job killed
      # mid-flight is re-delivered by BullMQ, so this is about not doing
      # Textract/Bedrock work twice — i.e. about D28's < £0.02/document
      # guardrail, which is a real number at pilot volume.
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

# ==========================================================================
# Services.
#
# ⚠ BOTH RUN AT desired_count = 0 AND THAT IS DELIBERATE — the same reasoning
# as staging, and it applies harder here.
#
# There is no image in ECR yet (local.image_tag above, and prod's registry is
# brand new — see the promotion note in compute.tf). A service with
# desired_count > 0 would launch a task, fail the image pull, back off, and
# retry forever: burning Fargate minutes, filling a log group we pay to ingest,
# and firing the deployment circuit breaker on every apply. Deploying for the
# first time is therefore a COUNT change (CI, or `aws ecs update-service
# --desired-count 2`), not an infrastructure change.
#
# desired_count is in ignore_changes so that once CI or autoscaling owns the
# number, a `terraform apply` from anyone's laptop cannot quietly scale
# production back to whatever this file happens to say. task_definition is
# ignored for the same reason: CI registers a new revision per deploy, and
# without the ignore the next apply would roll production back to the
# placeholder revision below — the classic "who redeployed last week's build?"
# incident, in the environment where it costs the most.
# ==========================================================================

resource "aws_ecs_service" "api" {
  name            = "nt-${local.env}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 0

  # On-demand, never Spot, for anything serving HTTP — a Spot reclaim is a
  # two-minute warning and then a dead target.
  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }

  # Runbook §6.4 / Gov §14.9, §16: this IS the "auto-rollback on health
  # regression". A deployment whose tasks cannot pass the target-group check is
  # rolled back to the last good revision by ECS itself, without a human.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # 100/200: never drop below full capacity during a deploy. The extra tasks
  # exist for minutes and cost cents; a half-capacity production API during a
  # rollout does not.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # Node + Prisma needs a moment to connect before /healthz answers. Too low
  # and a cold start looks like a failed deploy to the circuit breaker.
  health_check_grace_period_seconds = 60

  network_configuration {
    # PRIVATE subnets. The NAT (network.tf) is what makes this possible, and
    # this is the line that spends it.
    subnets         = module.network.private_subnet_ids
    security_groups = [module.network.app_security_group_id]

    # No public address at all. Egress goes out through the NAT; ECR, Secrets
    # Manager, KMS, CloudWatch Logs, Bedrock and Textract go out through the
    # interface endpoints in endpoints.tf and never touch the internet.
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = local.app_port
  }

  # ECS-managed tags plus the provider's default_tags reach the tasks and ENIs
  # themselves, which is what makes per-service cost attribution (Gov §13.5)
  # possible in Cost Explorer rather than a guess — and in a shared account
  # (D36) tags are the ONLY thing separating Neoting's bill from three other
  # products'.
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  # ECS Exec stays OFF. The task role grants no ssmmessages:* permissions, and
  # enabling it without them produces a task running with a permanently STOPPED
  # managed agent — a broken debugging tool is worse than an absent one.
  #
  # ⚠ AND IN PRODUCTION IT IS ALSO A CONTROL, not just a missing feature: ECS
  # Exec is an interactive shell inside a container holding a live database
  # connection and decrypted secrets, and every keystroke of it is outside the
  # Review → Approve path (Gov §10). Turning it on is a task-role change plus a
  # decision about session logging, not a convenience flag.
  enable_execute_command = false

  # A target group must already be attached to a load balancer before ECS will
  # accept the service, and the attachment only happens via the origin-verified
  # rule (the listener's default action is a 403). The capacity-provider
  # association is not visible to Terraform through `cluster` alone.
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

  # ⚠ FARGATE, NOT FARGATE_SPOT — the one place this file deliberately spends
  # more than staging does for the same workload.
  #
  # staging runs workers on Spot (~70% cheaper, ~$5/mo instead of ~$16/mo) and
  # says why that must not be copied: "Never for the api, and never for prod
  # workers without a queue-lag SLO to check it against." There is no queue-lag
  # SLO, because observability.tf is not built. A Spot reclaim re-delivers the
  # in-flight BullMQ job — which is safe for correctness and NOT safe for the
  # £0.02/document guardrail (D28), since the re-delivered job pays for
  # Textract and Bedrock a second time.
  #
  # Cost of this decision: ~$27/month more than Spot at one task. Revisit when
  # there is an alarm that would notice the queue falling behind.
  capacity_provider_strategy {
    capacity_provider = "FARGATE"
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
    subnets          = module.network.private_subnet_ids
    security_groups  = [module.network.app_security_group_id]
    assign_public_ip = false
  }

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"
  enable_execute_command  = false

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
  description = "Both run at desired_count = 0 until an image exists in the nt-prod/* registry; deploying is a count change."
}

output "ecs_task_families" {
  value = {
    api     = aws_ecs_task_definition.api.family
    workers = aws_ecs_task_definition.workers.family
    migrate = aws_ecs_task_definition.migrate.family
  }
}
