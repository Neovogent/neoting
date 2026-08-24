# --------------------------------------------------------------------------
# Observability — SNS alerting, CloudWatch alarms, the Kickoff §7.6 dashboard
# (Kickoff 3.7 and §7.6 · Governance §13.2 · runbook Step 7)
#
# WHY CLOUDWATCH AND NOT PROMETHEUS/GRAFANA
# Runbook Step 7.2 defers Amazon Managed Prometheus + Managed Grafana to Infra
# Week: ~$40–70/month against an $8,000 / 6-month envelope (Appendix B) while
# exactly one staging environment exists. CloudWatch dashboards plus metric
# alarms satisfy the §7.6 gate now for ~$5/month (itemised at the foot of this
# file). When AMP/AMG land it is the OTel instrumentation that carries over —
# none of this file does, and that is the point of spending $5 instead of $70.
#
# WHAT IS HONESTLY BUILDABLE TODAY (13 Aug 2026)
# Governance §13.2 names nine alerts and most of them measure behaviour nothing
# emits yet: the ECS services exist but sit at `desired_count = 0` (services.tf)
# because no image has been pushed. An alarm on a metric with no datapoints
# parks in INSUFFICIENT_DATA forever and teaches people to ignore the console,
# so the alarms below are split into three tiers and each one says which it is.
#
#   TIER 1 — LIVE NOW. RDS, ElastiCache, SES, SNS, and log metric filters.
#     Real datapoints from the minute of apply. Nothing has to happen first.
#
#   TIER 2 — LIVE ON DEPLOY. ALB and ECS. AWS emits these itself; they need a
#     pushed image and a non-zero desired_count, no application code and no
#     Terraform change. treat_missing_data = notBreaching, so they are correct
#     and silent at zero scale. This tier is why §13.2's error-rate and p95
#     alerts do NOT have to wait for OTel — the load balancer counts 5xx and
#     measures latency whether or not the app is instrumented.
#
#   TIER 3 — PENDING INSTRUMENTATION. The Neoting/Pipeline namespace. Needs
#     code. These alarms are created anyway and sit in INSUFFICIENT_DATA, which
#     is truthful — we do not know the queue age, so the alarm must not claim
#     OK. They are SILENT while grey: no alarm in this file sets
#     insufficient_data_actions, so nobody is paged by absence. $0.10/month
#     each buys the guarantee that they light up on their own instead of
#     becoming a "wire up the §13.2 alarms" ticket that outlives the sprint.
#
# The dashboard says all of this, in a text widget, at the top. A panel reading
# "No data" next to a banner explaining why is honest. The same panel without
# the banner reads as "healthy" and is a lie.
#
# TREAT_MISSING_DATA POLICY — one rule, applied consistently:
#   `missing`      metrics that publish unconditionally every 60 s (RDS,
#                  ElastiCache). A gap means the telemetry broke, not that the
#                  box is fine; holding the last state is the least-wrong read.
#                  Also used for the not-yet-emitted app metrics, so they show
#                  INSUFFICIENT_DATA (truthful) rather than OK (a lie).
#   `notBreaching` metrics that only exist when something happened (SES
#                  reputation, log-derived counters). Zero events genuinely is
#                  the healthy state, so absence must not go red.
#   `breaching`    used nowhere. Staging is disposable by design (G1); a
#                  deliberately deleted database must not page anyone.
# --------------------------------------------------------------------------

locals {
  # Two custom namespaces, not one. Neoting/Pipeline is what the application
  # emits deliberately; Neoting/Logs is what CloudWatch derives from log lines.
  # Keeping them apart means a log-format change can never silently move a
  # business metric — it just makes a Neoting/Logs panel go flat.
  ns_pipeline = "Neoting/Pipeline"
  ns_logs     = "Neoting/Logs"

  # `one()` rather than `[0]`: data.tf runs a single-node replication group on
  # purpose (BullMQ + cluster mode disabled). If someone scales it, this fails
  # at plan time and forces a revisit, instead of silently alarming on one node
  # out of three and calling that monitoring.
  redis_node = one(module.data.redis_member_clusters)
}

# --------------------------------------------------------------------------
# KMS — a separate CMK for operational telemetry.
#
# Two reasons this is not the docs key:
#   1. An SNS topic encrypted with the AWS-managed `alias/aws/sns` key CANNOT
#      receive messages from CloudWatch, EventBridge or Budgets — those service
#      principals need kms:GenerateDataKey* on the key, and an AWS-managed key
#      policy cannot be edited. A customer-managed key is the only working
#      option for a service-published encrypted topic.
#   2. Alarm bodies are operational data, not customer documents. Granting
#      cloudwatch/events/budgets decrypt rights on the customer-document CMK to
#      deliver a "CPU is high" email widens that key's blast radius for nothing.
#
# COST: $1/month for the key plus a few cents of requests. Appendix B.2 already
# budgets four CMKs in staging; this is one of them.
# --------------------------------------------------------------------------
resource "aws_kms_key" "ops" {
  description              = "Neoting staging - operational telemetry: alerts, alarm notifications, log encryption"
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation      = true
  deletion_window_in_days  = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "nt-${local.env}-ops-key-policy"
    Statement = [
      {
        Sid       = "AllowKeyAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
        Action = [
          "kms:Create*", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*",
          "kms:Update*", "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:Delete*",
          "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion",
          "kms:CancelKeyDeletion", "kms:CreateGrant", "kms:RetireGrant"
        ]
        Resource = "*"
      },
      {
        # The application publishes its own operational events to the topic.
        Sid       = "AllowNeotingPrincipalsToUseKey"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource  = "*"
        Condition = {
          StringLike = { "aws:PrincipalArn" = "arn:aws:iam::${local.account_id}:role/nt-*" }
        }
      },
      {
        # Every publisher to an SSE-enabled SNS topic needs GenerateDataKey* and
        # Decrypt on the CMK. Miss one of these principals and the alarm fires,
        # SNS rejects the publish, and nobody is told — the worst failure mode
        # an alerting system has. Add the principal here AND in the topic policy
        # below, never one without the other.
        Sid    = "AllowAWSServicesToPublishToEncryptedTopic"
        Effect = "Allow"
        Principal = { Service = [
          "cloudwatch.amazonaws.com", # metric alarms
          "events.amazonaws.com",     # EventBridge rules (GuardDuty, RDS events)
          "budgets.amazonaws.com",    # AWS Budgets thresholds (Gov §13.5)
          "ses.amazonaws.com",        # bounce/complaint events (email.tf)
        ] }
        Action    = ["kms:GenerateDataKey*", "kms:Decrypt", "kms:DescribeKey"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
      },
      {
        # Granted ahead of use. Runbook Step 7.1 requires log groups encrypted
        # with nt-<env>-logs; the existing groups in network.tf and compute.tf
        # are not yet (KNOWN DRIFT — tracked, not forgotten). With this grant in
        # place, closing that gap is a one-line `kms_key_id` addition per group
        # rather than a key-policy change under time pressure.
        Sid       = "AllowCloudWatchLogsToUseKey"
        Effect    = "Allow"
        Principal = { Service = "logs.${local.region}.amazonaws.com" }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
        Condition = {
          ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${local.region}:${local.account_id}:log-group:*" }
        }
      }
    ]
  })

  tags = { Component = "observability" }
}

resource "aws_kms_alias" "ops" {
  name          = "alias/nt-${local.env}-ops"
  target_key_id = aws_kms_key.ops.key_id
}

# --------------------------------------------------------------------------
# SNS — one alert topic.
#
# NO SUBSCRIPTIONS ARE DECLARED HERE, ON PURPOSE. An `aws_sns_topic_subscription`
# with protocol "email" is created in state as PendingConfirmation and stays
# that way until a human clicks the link in the confirmation mail. Terraform
# reports it as created and the console shows a subscriber, so the alerting path
# looks wired when nothing is being delivered — precisely the "dead channel"
# Governance §13.2 exists to prevent. Subscriptions are added out of band
# (console or CLI) and the confirmation is the proof. Verify with:
#   aws sns list-subscriptions-by-topic --topic-arn <arn> --region eu-west-2
# and check that no SubscriptionArn reads "PendingConfirmation".
#
# ONE topic is correct for staging and WRONG for prod. Governance §13.2 wants a
# channel on-call actually watches; mixing "a slow query happened" with "the
# database is down" in one feed is how that channel gets muted. Prod splits at
# minimum page/ vs ticket/ topics.
# --------------------------------------------------------------------------
resource "aws_sns_topic" "alerts" {
  name              = "nt-${local.env}-alerts"
  display_name      = "Neoting ${local.env} alerts"
  kms_master_key_id = aws_kms_key.ops.id

  tags = { Component = "observability" }
}

resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "nt-${local.env}-alerts-policy"
    Statement = [
      {
        # The default owner statement. Without it, a topic policy that lists only
        # service principals can leave the account unable to manage its own topic
        # from the console.
        Sid       = "AllowAccountOwnerToManageTopic"
        Effect    = "Allow"
        Principal = { AWS = "*" }
        Action = [
          "SNS:Subscribe", "SNS:Publish", "SNS:GetTopicAttributes", "SNS:SetTopicAttributes",
          "SNS:ListSubscriptionsByTopic", "SNS:AddPermission", "SNS:RemovePermission", "SNS:DeleteTopic"
        ]
        Resource  = aws_sns_topic.alerts.arn
        Condition = { StringEquals = { "AWS:SourceOwner" = local.account_id } }
      },
      {
        Sid       = "AllowCloudWatchAlarmsToPublish"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.alerts.arn
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.account_id }
          ArnLike      = { "aws:SourceArn" = "arn:aws:cloudwatch:${local.region}:${local.account_id}:alarm:*" }
        }
      },
      {
        # Covers both EventBridge rules in this file (GuardDuty findings and RDS
        # events). Scoped to rules in this account and region so a rule in
        # another product's stack in this SHARED account cannot publish here.
        Sid       = "AllowEventBridgeRulesToPublish"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.alerts.arn
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.account_id }
          ArnLike      = { "aws:SourceArn" = "arn:aws:events:${local.region}:${local.account_id}:rule/*" }
        }
      },
      {
        # AWS Budgets lives in envs/account/ (another agent, separate state) and
        # cannot reference this topic as a Terraform resource. This statement is
        # the whole cross-state contract: the budget notification targets the
        # literal ARN
        #   arn:aws:sns:${local.region}:${local.account_id}:nt-${local.env}-alerts
        # and this policy is what lets it land. Do not rename the topic without
        # changing envs/account/ in the same PR.
        #
        # Budgets is a global service, hence the region-less SourceArn form.
        # Governance §13.5: "a surprising bill is an alerting failure".
        Sid       = "AllowAWSBudgetsToPublish"
        Effect    = "Allow"
        Principal = { Service = "budgets.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.alerts.arn
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.account_id }
          ArnLike      = { "aws:SourceArn" = "arn:aws:budgets::${local.account_id}:*" }
        }
      }
    ]
  })
}

# --------------------------------------------------------------------------
# LIVE ALARMS — RDS. Real metrics, real datapoints, from the moment of apply.
#
# Thresholds are sized for db.t4g.small (2 vCPU burstable, 2 GiB RAM, 50 GB gp3
# autoscaling to 200 GB — data.tf), not copied from a blog post.
# --------------------------------------------------------------------------
locals {
  rds_alarms = {
    cpu-high = {
      metric      = "CPUUtilization"
      statistic   = "Average"
      comparison  = "GreaterThanThreshold"
      threshold   = 80
      period      = 300
      evaluations = 3
      datapoints  = 2
      unit        = "Percent"
      # 80% sustained for 10 of 15 minutes. Below that on a burstable instance is
      # normal during a migration or a seed run and pages nobody usefully.
      description = "RDS CPU above 80% for 10 minutes - check for a missing index or a runaway job before resizing"
    }
    storage-low = {
      metric      = "FreeStorageSpace"
      statistic   = "Average"
      comparison  = "LessThanThreshold"
      threshold   = 10737418240 # 10 GiB
      period      = 300
      evaluations = 2
      datapoints  = 2
      unit        = "Bytes"
      # Storage autoscaling (max 200 GB) should absorb this first. If this fires,
      # autoscaling is either throttled by its 6-hour cooldown or has hit the cap,
      # and both need a human. A full RDS volume takes the database read-only.
      description = "RDS free storage below 10 GiB - storage autoscaling is not keeping up"
    }
    memory-low = {
      metric      = "FreeableMemory"
      statistic   = "Average"
      comparison  = "LessThanThreshold"
      threshold   = 268435456 # 256 MiB of 2 GiB
      period      = 300
      evaluations = 3
      datapoints  = 3
      unit        = "Bytes"
      description = "RDS freeable memory below 256 MiB - the instance is about to start swapping"
    }
    connections-high = {
      metric      = "DatabaseConnections"
      statistic   = "Maximum"
      comparison  = "GreaterThanThreshold"
      threshold   = 150
      period      = 300
      evaluations = 2
      datapoints  = 2
      unit        = "Count"
      # max_connections on a 2 GiB instance resolves to roughly 225. 150 leaves
      # headroom to react. In practice this fires because a Fargate task is
      # cycling and leaking pool connections, not because of load.
      description = "RDS connections above 150 of ~225 - suspect a leaked connection pool, not real load"
    }
    cpu-credits-low = {
      metric      = "CPUCreditBalance"
      statistic   = "Average"
      comparison  = "LessThanThreshold"
      threshold   = 60
      period      = 300
      evaluations = 3
      datapoints  = 3
      unit        = "Count"
      # COST ALARM, not a performance one. RDS T-class instances default to
      # `unlimited` mode: exhausted credits do not throttle, they bill as surplus
      # credits (see CPUSurplusCreditsCharged). On a $250/month staging budget
      # (runbook Step 10) that is a leak worth $0.10/month to catch.
      description = "RDS CPU credit balance below 60 - t4g unlimited mode is now billing surplus credits"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "rds" {
  for_each = local.rds_alarms

  alarm_name          = "nt-${local.env}-rds-${each.key}"
  alarm_description   = each.value.description
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  comparison_operator = each.value.comparison
  threshold           = each.value.threshold
  period              = each.value.period
  evaluation_periods  = each.value.evaluations
  datapoints_to_alarm = each.value.datapoints
  unit                = each.value.unit

  dimensions = { DBInstanceIdentifier = module.data.db_instance_identifier }

  treat_missing_data = "missing"

  # OK notifications are on deliberately. A channel that only ever carries bad
  # news gets muted; seeing the recovery is what keeps people reading it
  # (Gov §13.2, "not a dead channel").
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# --------------------------------------------------------------------------
# LIVE ALARMS — ElastiCache.
#
# cache.t4g.micro: 2 vCPU, ~0.5 GiB usable. Redis is not just a cache here — it
# is the BullMQ job store (data.tf), so memory pressure is data loss, not a
# slower page.
# --------------------------------------------------------------------------
locals {
  redis_alarms = {
    engine-cpu-high = {
      metric      = "EngineCPUUtilization"
      statistic   = "Average"
      comparison  = "GreaterThanThreshold"
      threshold   = 90
      period      = 300
      evaluations = 3
      datapoints  = 2
      unit        = "Percent"
      # EngineCPUUtilization, NOT CPUUtilization. Redis is single-threaded, so on
      # a 2-vCPU node a saturated engine shows as ~50% CPUUtilization and looks
      # healthy. This is the metric that tells the truth.
      description = "Redis engine thread above 90% - the single Redis thread is saturated regardless of what CPUUtilization says"
    }
    memory-high = {
      metric      = "DatabaseMemoryUsagePercentage"
      statistic   = "Average"
      comparison  = "GreaterThanThreshold"
      threshold   = 80
      period      = 300
      evaluations = 2
      datapoints  = 2
      unit        = "Percent"
      description = "Redis memory above 80% - BullMQ job data is at risk of eviction on a 0.5 GiB node"
    }
    evictions = {
      metric      = "Evictions"
      statistic   = "Sum"
      comparison  = "GreaterThanThreshold"
      threshold   = 0
      period      = 300
      evaluations = 1
      datapoints  = 1
      unit        = "Count"
      # Zero tolerance and no apology for it. An evicted key in a pure cache is a
      # miss; an evicted key in the BullMQ keyspace is a job that silently never
      # runs — a document that never gets extracted and a client who is never
      # chased. There is no acceptable non-zero value here.
      description = "Redis evicted a key - in the BullMQ keyspace that is a lost job, not a cache miss"
    }
    swap-high = {
      metric      = "SwapUsage"
      statistic   = "Average"
      comparison  = "GreaterThanThreshold"
      threshold   = 52428800 # 50 MiB
      period      = 300
      evaluations = 2
      datapoints  = 2
      unit        = "Bytes"
      description = "Redis swap above 50 MiB - memory pressure, latency is about to fall off a cliff"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "redis" {
  for_each = local.redis_alarms

  alarm_name          = "nt-${local.env}-redis-${each.key}"
  alarm_description   = each.value.description
  namespace           = "AWS/ElastiCache"
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  comparison_operator = each.value.comparison
  threshold           = each.value.threshold
  period              = each.value.period
  evaluation_periods  = each.value.evaluations
  datapoints_to_alarm = each.value.datapoints
  unit                = each.value.unit

  dimensions = { CacheClusterId = local.redis_node }

  treat_missing_data = "missing"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# ==========================================================================
# TIER 2 — ALARMS THAT GO LIVE ON THE FIRST DEPLOY.
#
# The ALB (alb.tf) and the ECS services (services.tf) exist, but both services
# sit at `desired_count = 0` until an image is pushed, so there are no targets,
# no requests and no running tasks. The metrics below are AWS-emitted: they need
# a deploy, not a line of application code and not a Terraform change.
#
# THIS IS THE IMPORTANT TIER. Governance §13.2's first two alerts — error rate
# > 2% over 5 min and p95 > 1 s over 10 min — do NOT have to wait for OTel. The
# load balancer counts 5xx responses and measures response time whether or not
# the application is instrumented, and it sees the failures an in-process metric
# structurally cannot: connection resets, tasks that died mid-request, and 5xx
# generated by the ALB itself when there is no healthy target to route to.
#
# All of these use treat_missing_data = "notBreaching" (except the task-count
# math, which is arithmetically silent at zero — see its note). At zero scale
# "no requests" genuinely means "no failing requests", so green is not a lie
# here in the way it would be for a Tier 3 metric.
# ==========================================================================

# Gov §13.2 alert 1 of 9 — error rate > 2% over 5 minutes. Live on deploy.
#
# Counts BOTH 5xx sources. HTTPCode_Target_5XX_Count is the app returning 500;
# HTTPCode_ELB_5XX_Count is the load balancer failing to get an answer at all
# (503 no healthy target, 502 bad gateway, 504 timeout). Alarming on only the
# target series is the classic mistake: a completely dead service produces zero
# target 5xx, because nothing ever reaches the target.
resource "aws_cloudwatch_metric_alarm" "alb_error_rate" {
  alarm_name          = "nt-${local.env}-alb-error-rate"
  alarm_description   = "5xx above 2% of requests over 5 minutes at the load balancer (Gov §13.2)"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 2
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "rate"
    expression  = "IF(req > 0, 100 * (elb5 + tgt5) / req, 0)"
    label       = "5xx rate %"
    return_data = true
  }

  metric_query {
    id = "req"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix }
    }
  }

  metric_query {
    id = "elb5"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix }
    }
  }

  metric_query {
    id = "tgt5"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix }
    }
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# Gov §13.2 alert 2 of 9 — p95 > 1 s over 10 minutes. Live on deploy.
#
# ⚠ UNIT TRAP: AWS/ApplicationELB TargetResponseTime is in SECONDS. The
# threshold is therefore 1, not 1000. The Tier 3 in-process alarm below measures
# the same SLO in MILLISECONDS with a threshold of 1000. Two alarms, one number,
# two units — check which one you are editing before you change a digit.
#
# ⚠ §13.2 says "non-LLM" and the ALB cannot tell the difference. While staging
# serves only REST routes this is exactly right. The moment chat streaming ships
# (SoT §13.3: first-token < 2 s p95) this alarm starts firing on a route that is
# behaving correctly. The fix is a dedicated target group or listener rule for
# the LLM lane, or handing the SLO to the Tier 3 in-process alarm which can
# exclude those routes by dimension. The fix is NOT quietly raising this
# threshold to 2 s — that would mute a real regression on every other route.
resource "aws_cloudwatch_metric_alarm" "alb_target_p95" {
  alarm_name          = "nt-${local.env}-alb-target-p95"
  alarm_description   = "ALB target p95 above 1 second over 10 minutes (Gov §13.2; SLO §13.3 is 500 ms)"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 1 # SECONDS
  period              = 600
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  dimensions = { LoadBalancer = aws_lb.main.arn_suffix }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# UnHealthyHostCount > 0, deliberately NOT HealthyHostCount < 1.
#
# With desired_count = 0 there are no registered targets, so a "fewer than one
# healthy host" alarm would fire on the first apply and stay red until someone
# deploys — a permanently-red alarm that everyone learns to scroll past, which
# is the precise failure this file is written to avoid. UnHealthyHostCount only
# becomes non-zero when a target is registered AND failing its health check,
# which is the condition actually worth waking up for. It is silent at zero
# scale and correct at every other scale.
resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_targets" {
  alarm_name          = "nt-${local.env}-alb-unhealthy-targets"
  alarm_description   = "An API target is registered and failing its health check"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  treat_missing_data  = "notBreaching"

  dimensions = {
    TargetGroup  = aws_lb_target_group.api.arn_suffix
    LoadBalancer = aws_lb.main.arn_suffix
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

locals {
  # Resource names come from services.tf. Kept as a map so an added service gets
  # its alarms by editing one line, not four resources.
  ecs_services = {
    api     = aws_ecs_service.api.name
    workers = aws_ecs_service.workers.name
  }
}

# "Fewer tasks running than ECS wants running", sustained for 15 minutes.
#
# This is the alarm that catches a crash-looping container, an image that will
# not pull, and a task role missing a permission — the three ways a deploy fails
# silently while the pipeline reports success.
#
# It is arithmetically silent today rather than suppressed: at desired_count = 0
# the expression evaluates 0 - 0 = 0, which does not breach. Nothing needs to be
# switched on when the first image lands. Container Insights is already enabled
# on the cluster (compute.tf), which is what publishes these.
resource "aws_cloudwatch_metric_alarm" "ecs_task_shortfall" {
  for_each = local.ecs_services

  alarm_name          = "nt-${local.env}-${each.key}-task-shortfall"
  alarm_description   = "${each.key}: fewer tasks running than desired for 15 minutes - suspect a crash loop, a bad image, or a missing IAM grant"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  treat_missing_data  = "missing"

  metric_query {
    id          = "shortfall"
    expression  = "desired - running"
    label       = "Tasks short of desired"
    return_data = true
  }

  metric_query {
    id = "desired"
    metric {
      namespace   = "ECS/ContainerInsights"
      metric_name = "DesiredTaskCount"
      period      = 300
      stat        = "Average"
      dimensions  = { ClusterName = aws_ecs_cluster.main.name, ServiceName = each.value }
    }
  }

  metric_query {
    id = "running"
    metric {
      namespace   = "ECS/ContainerInsights"
      metric_name = "RunningTaskCount"
      period      = 300
      stat        = "Average"
      dimensions  = { ClusterName = aws_ecs_cluster.main.name, ServiceName = each.value }
    }
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# Memory, not CPU, and only memory.
#
# Both task definitions are capped at 1024 MB (services.tf). A Node heap past
# 85% of that is heading for an OOM kill, and an OOM kill presents as "the
# deploy is flaky" rather than "we are out of memory" — which is why it deserves
# its own alarm. Fargate CPU saturation, by contrast, surfaces as latency, and
# the ALB p95 alarm above already catches that. A second alarm for the same
# incident is not more monitoring, it is more noise.
resource "aws_cloudwatch_metric_alarm" "ecs_memory_high" {
  for_each = local.ecs_services

  alarm_name          = "nt-${local.env}-${each.key}-memory-high"
  alarm_description   = "${each.key}: memory above 85% of its 1024 MB task limit - an OOM kill is next"
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 85
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  unit                = "Percent"
  treat_missing_data  = "notBreaching"

  dimensions = { ClusterName = aws_ecs_cluster.main.name, ServiceName = each.value }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# --------------------------------------------------------------------------
# LIVE ALARMS — SES reputation.
#
# Not on the Governance §13.2 list, and included anyway: doc@ is the primary
# document intake channel (SoT Stage 1, email.tf). AWS suspends sending at 5%
# bounce / 0.1% complaint, and a suspension does not announce itself — the first
# symptom is that onboarding invites and supplier chases stop arriving. The
# thresholds below are AWS's own review thresholds, so this fires while there is
# still room to act.
#
# treat_missing_data = notBreaching because these metrics only publish with
# sending volume — production access was granted 17 Aug 2026, but no sending
# client exists in the app yet, so there is no volume (email.tf).
# --------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "ses_bounce_rate" {
  alarm_name          = "nt-${local.env}-ses-bounce-rate"
  alarm_description   = "SES bounce rate above 5% - AWS suspends sending at this level"
  namespace           = "AWS/SES"
  metric_name         = "Reputation.BounceRate"
  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0.05
  period              = 3600
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

resource "aws_cloudwatch_metric_alarm" "ses_complaint_rate" {
  alarm_name          = "nt-${local.env}-ses-complaint-rate"
  alarm_description   = "SES complaint rate above 0.1% - AWS suspends sending at this level"
  namespace           = "AWS/SES"
  metric_name         = "Reputation.ComplaintRate"
  statistic           = "Average"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0.001
  period              = 3600
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# --------------------------------------------------------------------------
# LIVE ALARM — the alerting path monitoring itself.
#
# Honest about its own limits: this catches a broken SUBSCRIPTION (an HTTPS
# endpoint returning 500, a bounced email address) because SNS still accepts the
# publish and records the delivery failure. It CANNOT catch a broken topic — if
# the KMS grant is wrong and every publish is rejected, this alarm's own
# notification is rejected too.
#
# ⚠ AND NOTHING CURRENTLY CATCHES THAT CASE. An earlier revision claimed a
# "quarterly alert-path drill (Governance §13.2)" covered it. No such drill
# exists: §13.2 is the alert list, and the only drill Governance contains is
# the quarterly RESTORE drill in §17, which proves backups and says nothing
# about whether an alarm can reach a human.
#
# So this is an open gap, not a covered one. The cheapest closure is a
# scheduled EventBridge rule publishing a heartbeat to this topic and an alarm
# on its absence — an alert path that is never exercised is indistinguishable
# from one that is broken, and both look like silence.
# --------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "sns_delivery_failures" {
  alarm_name          = "nt-${local.env}-alerts-delivery-failed"
  alarm_description   = "The alerts topic failed to deliver to a subscriber - a subscription endpoint is broken"
  namespace           = "AWS/SNS"
  metric_name         = "NumberOfNotificationsFailed"
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  dimensions = { TopicName = aws_sns_topic.alerts.name }

  alarm_actions = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# --------------------------------------------------------------------------
# LOG METRIC FILTERS — cheap, and real the moment a line is written.
#
# Metric filters themselves are free; the derived custom metric is $0.30/month
# each, so five of them is $1.50. That is the cheapest real telemetry available
# before any instrumentation exists.
#
# `default_value = 0` on every transformation matters more than it looks: it
# publishes a zero for every non-matching log event, which turns a metric that
# only exists during an incident into a continuous series. Without it the
# derived alarms flap between INSUFFICIENT_DATA and ALARM and the graphs are
# unreadable. (default_value and dimensions are mutually exclusive in
# CloudWatch, which is why the service name is in the metric name below rather
# than in a dimension.)
# --------------------------------------------------------------------------

# local.services (api, web, workers) and the log groups come from compute.tf.
resource "aws_cloudwatch_log_metric_filter" "log_errors" {
  for_each = local.services

  name           = "nt-${local.env}-${each.key}-errors"
  log_group_name = aws_cloudwatch_log_group.service[each.key].name

  # Governance §13.1 mandates structured JSON logs with a `level` field. This
  # filter is a load-bearing consumer of that contract: change the log shape and
  # this goes silently to zero, which is why the log-shape assertion belongs in
  # the logger's unit tests.
  pattern = "{ $.level = \"error\" }"

  metric_transformation {
    name          = "log.errors.${each.key}"
    namespace     = local.ns_logs
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# An absolute error-log count, not a rate — a rate needs a request counter the
# app does not emit yet (see the pending block below for the real §13.2 alarm).
# This is the partial answer that works from the first deploy: 10 error lines in
# 5 minutes in staging, where the only traffic is our own smoke tests, is always
# worth a look.
resource "aws_cloudwatch_metric_alarm" "log_errors" {
  for_each = local.services

  alarm_name          = "nt-${local.env}-${each.key}-error-logs"
  alarm_description   = "More than 10 error-level log lines from ${each.key} in 5 minutes"
  namespace           = local.ns_logs
  metric_name         = "log.errors.${each.key}"
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 10
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

locals {
  # "10.20.0.0/16" -> "10.20." — CloudWatch flow-log filter patterns match strings,
  # not CIDRs, so the source scope has to be a textual prefix. Derived rather than
  # written out so it cannot drift from the CIDR the VPC is actually built with.
  # Assumes the /16 that modules/network/variables.tf documents for both envs.
  vpc_addr_prefix = "${split(".", local.vpc_cidr)[0]}.${split(".", local.vpc_cidr)[1]}."
}

# Flow logs are REJECT-only (network.tf), and the app subnets are public with no
# NAT, so total rejects are dominated by internet background scanning — alarming
# on that count would be pure noise. Rejects aimed at 5432/6379 *from inside the
# VPC* are different: the data tier has no route to the internet and its security
# group only admits the app security group, so an internal connection attempt to
# Postgres or Redis that gets refused means something is reaching for the database
# that should not be. That is a real signal.
#
# ⚠ The `srcaddr` scope below is load-bearing, and it was missing until 25 Aug 2026.
# The port filter alone does NOT mean "inside the VPC". Flow logs cover EVERY ENI
# in the VPC — including the ALB's public nodes — and mass scanners probe 5432 and
# 6379 against any public IP they find. Without the srcaddr clause this filter
# counted that scan traffic, and between 17 and 25 Aug it fired the alarm 54 times
# with zero real events: every source was external (Chinese and Google Cloud ranges,
# assorted hosting), every destination was an nt-staging-alb ENI, and the security
# group was correctly refusing all of it. The alarm was measuring the internet, not
# us — and 54 false pages on the channel that carries the real ones is how a real
# one gets ignored.
resource "aws_cloudwatch_log_metric_filter" "data_tier_rejects" {
  name           = "nt-${local.env}-data-tier-rejects"
  log_group_name = module.network.flow_log_group_name

  # Default flow-log format, positionally matched. The action = "REJECT" clause
  # is redundant while traffic_type is REJECT and is kept so the filter stays
  # correct if network.tf ever switches to ALL.
  pattern = "[version, account_id, interface_id, srcaddr = \"${local.vpc_addr_prefix}*\", dstaddr, srcport, dstport = 5432 || dstport = 6379, protocol, packets, bytes, start, end, action = \"REJECT\", log_status]"

  metric_transformation {
    name          = "vpc.rejects.data_tier"
    namespace     = local.ns_logs
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "data_tier_rejects" {
  alarm_name          = "nt-${local.env}-data-tier-rejects"
  alarm_description   = "Connections to Postgres/Redis rejected at the security group from a source INSIDE the VPC - something is reaching for the data tier without permission. External scan traffic is excluded by the filter's srcaddr scope and is not this alarm's business."
  namespace           = local.ns_logs
  metric_name         = "vpc.rejects.data_tier"
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 5
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  # Every other alarm in this file pairs these. This one did not, which is why it
  # only ever sent ALARM mail and never a recovery — 43 one-way messages in one
  # thread, with no way to tell from the inbox whether it had cleared.
  ok_actions = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# --------------------------------------------------------------------------
# Slow-query counter.
#
# data.tf sets log_min_duration_statement = 100 specifically so Governance §5.1
# ("any query over 100 ms p95 gets an EXPLAIN ANALYZE and an issue") is
# enforceable rather than aspirational. This filter is the enforcement: it turns
# those log lines into a number somebody can see on a dashboard.
#
# ⚠ The log group is created by RDS, not Terraform, on the instance's first boot
# with the postgresql export enabled (data.tf). It exists — the database is live
# — but if this resource ever fails with ResourceNotFoundException on a rebuilt
# environment, that is why: apply the database first.
#
# ⚠ KNOWN DRIFT: because RDS auto-creates it, that group has infinite retention,
# the exact cost-and-compliance problem compute.tf calls out for ECS groups. It
# needs `terraform import` + a 30-day retention (Gov §12.2). Not done here
# because importing a resource another file owns is how two agents fight.
# --------------------------------------------------------------------------
resource "aws_cloudwatch_log_metric_filter" "postgres_slow_queries" {
  name           = "nt-${local.env}-postgres-slow-queries"
  log_group_name = "/aws/rds/instance/${module.data.db_instance_identifier}/postgresql"

  # Postgres only logs "duration:" for statements exceeding the 100 ms threshold
  # (log_duration is off), so a match is by definition a slow query.
  pattern = "\"duration:\""

  metric_transformation {
    name          = "postgres.slow_queries"
    namespace     = local.ns_logs
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }

  depends_on = [module.data]
}

# Deliberately a nudge, not a page: 50 slow queries in 15 minutes on a staging
# database whose only traffic is our own tests means a missing index shipped.
# Migrations and seeds legitimately breach 100 ms, hence a threshold above zero.
resource "aws_cloudwatch_metric_alarm" "postgres_slow_queries" {
  alarm_name          = "nt-${local.env}-postgres-slow-queries"
  alarm_description   = "Over 50 queries above 100 ms in 15 minutes - Governance §5.1 wants an EXPLAIN ANALYZE and an issue, not a pager"
  namespace           = local.ns_logs
  metric_name         = "postgres.slow_queries"
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 50
  period              = 900
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# --------------------------------------------------------------------------
# EventBridge — GuardDuty findings (Governance §13.2 security path, runbook
# Step 11).
#
# GuardDuty itself is enabled account-wide in envs/account/ (separate state,
# separate agent). This rule deliberately references it ONLY through the event
# pattern — there is no resource or data reference to cross the state boundary,
# so envs/account/ and envs/staging/ can be applied in either order.
#
# Severity >= 7 is GuardDuty's HIGH band. MEDIUM (4–6.9) in a synthetic-data
# staging environment is mostly port-scan noise against the public-subnet
# Fargate IPs that B.3 chose to accept; paging on it trains people to ignore the
# channel. Review this threshold when prod carries real client documents.
#
# ⚠ SCOPE LIMIT: findings are delivered to the default event bus of the region
# that produced them. This rule sees eu-west-2 only. That is consistent with D30
# (we operate nowhere else) but it means a finding in a region we do not use —
# which is exactly where an attacker would work in a SHARED account — is not
# seen here. Cross-region GuardDuty aggregation belongs in envs/account/.
# --------------------------------------------------------------------------
resource "aws_cloudwatch_event_rule" "guardduty_findings" {
  name        = "nt-${local.env}-guardduty-high"
  description = "GuardDuty findings of severity 7.0 and above (HIGH)"

  event_pattern = jsonencode({
    source        = ["aws.guardduty"]
    "detail-type" = ["GuardDuty Finding"]
    detail = {
      severity = [{ numeric = [">=", 7] }]
    }
  })

  tags = { Component = "observability" }
}

resource "aws_cloudwatch_event_target" "guardduty_findings" {
  rule      = aws_cloudwatch_event_rule.guardduty_findings.name
  target_id = "sns-alerts"
  arn       = aws_sns_topic.alerts.arn

  # A raw GuardDuty finding is ~4 KB of JSON. Delivered unmodified to an email
  # subscriber it is unreadable, and an unreadable alert is an ignored alert.
  input_transformer {
    input_paths = {
      severity     = "$.detail.severity"
      type         = "$.detail.type"
      title        = "$.detail.title"
      description  = "$.detail.description"
      region       = "$.region"
      account      = "$.account"
      resourceType = "$.detail.resource.resourceType"
      findingId    = "$.detail.id"
    }

    input_template = "\"GuardDuty HIGH finding (severity <severity>) in <region>\\n\\n<title>\\n\\nType:     <type>\\nResource: <resourceType>\\nAccount:  <account>\\nFinding:  <findingId>\\n\\n<description>\\n\\nRunbook Step 11. Triage in the GuardDuty console before touching the resource.\""
  }
}

# --------------------------------------------------------------------------
# EventBridge — RDS events. This is Governance §13.2's "failed backup" alert.
#
# It is the ONLY one of the seven application-dependent §13.2 alerts that is
# genuinely buildable today, and it is not a metric alarm because RDS publishes
# no metric for backup success or failure. It publishes an EVENT.
#
# EventBridge rather than `aws_db_event_subscription` on purpose: an RDS event
# subscription publishes to SNS as the `rds.amazonaws.com` principal, which would
# need its own statement in BOTH the topic policy and the ops key policy above.
# Every extra publisher principal on an encrypted topic is another way for an
# alert to be silently rejected. Routing through EventBridge reuses the
# events.amazonaws.com grant that GuardDuty already needs — one mechanism, one
# set of permissions, one thing to test. If RDS events never arrive, the
# fallback is aws_db_event_subscription plus those two policy statements.
#
# ⚠ WHAT THIS DOES NOT DO: it detects a backup that FAILED. It cannot detect a
# backup that never ran, because absence produces no event. Governance §17's
# restore drill is what actually proves the 35-day PITR window works; this alarm
# is not a substitute for running it.
# --------------------------------------------------------------------------
resource "aws_cloudwatch_event_rule" "rds_events" {
  name        = "nt-${local.env}-rds-events"
  description = "RDS failure, low-storage, availability and deletion events - Gov §13.2 failed-backup alert"

  # Matching on EventCategories rather than on RDS-EVENT-nnnn IDs: the ID list
  # changes between engine versions, the categories do not. RDS reports a failed
  # automated backup under `failure`.
  event_pattern = jsonencode({
    source        = ["aws.rds"]
    "detail-type" = ["RDS DB Instance Event", "RDS DB Snapshot Event"]
    detail = {
      EventCategories = ["failure", "low storage", "availability", "deletion"]
    }
  })

  tags = { Component = "observability" }
}

resource "aws_cloudwatch_event_target" "rds_events" {
  rule      = aws_cloudwatch_event_rule.rds_events.name
  target_id = "sns-alerts"
  arn       = aws_sns_topic.alerts.arn

  input_transformer {
    input_paths = {
      message    = "$.detail.Message"
      categories = "$.detail.EventCategories"
      sourceArn  = "$.detail.SourceArn"
      eventTime  = "$.time"
    }

    input_template = "\"RDS event: <message>\\n\\nCategories: <categories>\\nResource:   <sourceArn>\\nAt:         <eventTime> (UTC)\\n\\nIf this is backup or storage related, treat it as Governance §17 territory - check the PITR window is still 35 days before doing anything else.\""
  }
}

# ==========================================================================
# PENDING ALARMS — Governance §13.2, awaiting application instrumentation.
#
# READ THIS BEFORE YOU "FIX" THE GREY ALARMS IN THE CONSOLE.
#
# Every alarm below targets the Neoting/Pipeline namespace. Nothing emits to
# that namespace as of 13 Aug 2026, so every one of them will sit in
# INSUFFICIENT_DATA until the API and workers ship. That state is TRUTHFUL: we
# do not know the queue age, so the alarm must not claim OK.
# treat_missing_data is `missing`, not `notBreaching`, for exactly that reason —
# the opposite choice from Tier 2, where an absent metric genuinely does mean
# nothing bad is happening.
#
# They are SILENT while grey. No alarm in this file sets
# insufficient_data_actions, so nobody is paged by absence. The cost of leaving
# them here is $0.10/month each (~$0.90 total). The cost of NOT leaving them
# here is a "wire up the §13.2 alarms" ticket that outlives the sprint.
#
# WHY ERROR RATE AND p95 APPEAR IN BOTH TIER 2 AND TIER 3, WHICH LOOKS LIKE
# DUPLICATION AND IS NOT: the ALB alarms above answer "are users getting errors
# and are they waiting", from outside the process, today. These answer "which
# route, which handler, and excluding the LLM lane" — the precision §13.2's
# "non-LLM" qualifier actually requires and that no load balancer can provide.
# Keep both. When they disagree, the ALB is right about what users experienced
# and the in-process metric is right about why.
#
# THE CONTRACT THE APPLICATION MUST MEET — emit these to "Neoting/Pipeline":
#
#   http.requests          Count         Sum        every HTTP response
#   http.errors            Count         Sum        5xx and unhandled 4xx
#   http.server.duration   Milliseconds  raw values (needed for real p95)
#   extraction.duration    Milliseconds  raw values, per document
#   queue.job.age          Seconds       age of the oldest waiting BullMQ job
#   queue.dlq.depth        Count         dead-letter depth, per queue
#   ai.spend.pence         None          INTEGER PENCE. Never pounds, never a
#                                        float — the money invariant applies to
#                                        telemetry too, and a float here is how
#                                        a rounding bug becomes a budget bug.
#   sms.send.failed        Count         Twilio status-callback failures
#   integration.token.expiring  Count    connections whose refresh has failed
#
# CARDINALITY DISCIPLINE (runbook Step 7.2): never dimension any of these with a
# document ID, user ID or workspace ID. Custom metrics bill per unique
# dimension combination — one workspace-ID dimension turns $0.30/month into a
# four-figure invoice. Queue name and service name are the only safe dimensions.
#
# Percentiles: publish raw observations (or Values/Counts arrays), not
# pre-aggregated averages. CloudWatch cannot compute p95 from an average, and
# the §13.3 SLOs are all percentile-based.
# ==========================================================================

# §13.2: error rate > 2% over 5 min — the in-process counterpart to
# aws_cloudwatch_metric_alarm.alb_error_rate. Counts unhandled 4xx as well as
# 5xx, which the ALB deliberately does not: a 401 storm from a broken portal OTP
# flow is a real incident that never shows up as a 5xx.
resource "aws_cloudwatch_metric_alarm" "pending_error_rate" {
  alarm_name          = "nt-${local.env}-pending-error-rate"
  alarm_description   = "PENDING INSTRUMENTATION. Error rate above 2% over 5 minutes (Gov §13.2)"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 2
  evaluation_periods  = 1
  treat_missing_data  = "missing"

  # IF() rather than a bare division: with zero requests the division yields no
  # datapoint, which reads identically to "not instrumented". An explicit 0%
  # distinguishes "deployed and idle" from "not deployed".
  metric_query {
    id          = "e1"
    expression  = "IF(reqs > 0, 100 * errs / reqs, 0)"
    label       = "Error rate %"
    return_data = true
  }

  metric_query {
    id = "reqs"
    metric {
      namespace   = local.ns_pipeline
      metric_name = "http.requests"
      period      = 300
      stat        = "Sum"
    }
  }

  metric_query {
    id = "errs"
    metric {
      namespace   = local.ns_pipeline
      metric_name = "http.errors"
      period      = 300
      stat        = "Sum"
    }
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# §13.2: p95 > 1 s over 10 min (non-LLM). The SLO in §13.3 is tighter (500 ms) —
# the SLO is what the error budget is measured against, this is when someone is
# woken up. They are not meant to be the same number.
#
# MILLISECONDS here, threshold 1000. The Tier 2 ALB alarm expresses the same
# limit in SECONDS with a threshold of 1. Both are correct for their source.
# This one is what eventually carries the "non-LLM" qualifier, by dimensioning
# on route class — which is why it stays even though the ALB covers latency.
resource "aws_cloudwatch_metric_alarm" "pending_api_p95" {
  alarm_name          = "nt-${local.env}-pending-api-p95"
  alarm_description   = "PENDING INSTRUMENTATION. API p95 above 1000 ms over 10 minutes, non-LLM routes (Gov §13.2)"
  namespace           = local.ns_pipeline
  metric_name         = "http.server.duration"
  extended_statistic  = "p95"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 1000
  period              = 600
  evaluation_periods  = 1
  treat_missing_data  = "missing"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# §13.2 / §13.3: extraction p95 > 5 min over 30 min. 300000 ms, in ms because
# that is the unit the OTel histogram emits — converting units in the alarm is
# how thresholds end up 1000x wrong.
resource "aws_cloudwatch_metric_alarm" "pending_extraction_p95" {
  alarm_name          = "nt-${local.env}-pending-extraction-p95"
  alarm_description   = "PENDING INSTRUMENTATION. Extraction p95 above 5 minutes over 30 minutes (Gov §13.2, SLO §13.3)"
  namespace           = local.ns_pipeline
  metric_name         = "extraction.duration"
  extended_statistic  = "p95"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 300000
  period              = 1800
  evaluation_periods  = 1
  treat_missing_data  = "missing"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# §13.2: queue age > 5 min. Three of the last five minutes, so a single slow
# job does not page, but a stalled worker does.
resource "aws_cloudwatch_metric_alarm" "pending_queue_age" {
  alarm_name          = "nt-${local.env}-pending-queue-age"
  alarm_description   = "PENDING INSTRUMENTATION. Oldest waiting job older than 5 minutes (Gov §13.2)"
  namespace           = local.ns_pipeline
  metric_name         = "queue.job.age"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 300
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  treat_missing_data  = "missing"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# §13.2: DLQ non-empty > 4 h. Four consecutive hourly datapoints, all breaching —
# a job landing in the DLQ is a bug to triage in hours, not a 3 a.m. page.
resource "aws_cloudwatch_metric_alarm" "pending_dlq_depth" {
  alarm_name          = "nt-${local.env}-pending-dlq-non-empty"
  alarm_description   = "PENDING INSTRUMENTATION. Dead-letter queue non-empty for 4 hours (Gov §13.2)"
  namespace           = local.ns_pipeline
  metric_name         = "queue.dlq.depth"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 3600
  evaluation_periods  = 4
  datapoints_to_alarm = 4
  treat_missing_data  = "missing"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# §13.2 asks for a PER-FIRM token-spend anomaly at 3x baseline. That alarm
# cannot exist in Terraform: it needs one alarm per practice, and practices are
# rows in a database that Terraform has never heard of. Per-firm enforcement is
# the application's job via the §9.7 Redis daily budgets
# (nt:{practiceId}:_:ai:budget:{date}) — this is the environment-wide backstop
# for the failure that budget cannot catch, which is a retry loop hammering
# Bedrock across every firm at once.
#
# 200 pence/hour: at the £0.02/document guardrail (D28) that is ~100 documents
# an hour, an order of magnitude above any staging test loop. Integer pence, per
# the money invariant — no floats in a budget number.
resource "aws_cloudwatch_metric_alarm" "pending_ai_spend" {
  alarm_name          = "nt-${local.env}-pending-ai-spend"
  alarm_description   = "PENDING INSTRUMENTATION. Model spend above 200 pence/hour environment-wide - suspect a retry loop (Gov §13.2, D28)"
  namespace           = local.ns_pipeline
  metric_name         = "ai.spend.pence"
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 200
  period              = 3600
  evaluation_periods  = 1
  treat_missing_data  = "missing"

  alarm_actions = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# §13.2: SMS delivery failure spike.
#
# NOTE FOR WHOEVER LOOKS HERE FIRST: this is not AWS/SNS SMS. Neoting sends SMS
# through Twilio (Gov §13.5), so AWS publishes no metric for it at all. The only
# possible source is the application recording Twilio status callbacks. There is
# no AWS-side alternative to wire up instead.
resource "aws_cloudwatch_metric_alarm" "pending_sms_failures" {
  alarm_name          = "nt-${local.env}-pending-sms-failures"
  alarm_description   = "PENDING INSTRUMENTATION. More than 5 Twilio SMS delivery failures in 5 minutes (Gov §13.2)"
  namespace           = local.ns_pipeline
  metric_name         = "sms.send.failed"
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 5
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "missing"

  alarm_actions = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# §13.2: integration token expiring unhandled. The metric is a gauge of
# connections whose refresh has already failed — "unhandled" is the operative
# word, so the app must only count tokens the refresh path has given up on. A
# token merely approaching expiry is not an alert, it is a cron job.
resource "aws_cloudwatch_metric_alarm" "pending_token_expiry" {
  alarm_name          = "nt-${local.env}-pending-integration-token-expiry"
  alarm_description   = "PENDING INSTRUMENTATION. A Xero/QuickBooks/TrueLayer token is expiring and refresh has failed (Gov §13.2)"
  namespace           = local.ns_pipeline
  metric_name         = "integration.token.expiring"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 3600
  evaluation_periods  = 1
  treat_missing_data  = "missing"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = { Component = "observability" }
}

# --------------------------------------------------------------------------
# Dashboard — the Kickoff §7.6 gate.
#
# §7.6 requires four panels live even at zero traffic: error rate, p95 latency,
# queue age, token spend. All four are on the top row.
#
# Panels 1 and 2 plot the Tier 2 ALB series and the Tier 3 in-process series on
# the SAME axes on purpose. The ALB series starts drawing on the first deploy
# with no code change, so those two panels stop being blank long before OTel
# lands — and once both are drawing, the gap between the two lines is itself the
# diagnostic (the ALB seeing errors the app does not is a task dying mid-request).
# Panels 3 and 4 have no AWS-side equivalent and stay empty until instrumented.
#
# The first widget is a text banner saying exactly that, because a blank panel
# with no explanation is worse than no dashboard: it reads as a healthy system
# to anyone who did not build it.
#
# One dashboard, not three: CloudWatch gives three dashboards free and bills
# $3/month after that, and a split staging dashboard is $72/year for the
# privilege of looking in two places during an incident.
# --------------------------------------------------------------------------
locals {
  live_alarm_arns = concat(
    [for a in aws_cloudwatch_metric_alarm.rds : a.arn],
    [for a in aws_cloudwatch_metric_alarm.redis : a.arn],
    [for a in aws_cloudwatch_metric_alarm.log_errors : a.arn],
    [
      aws_cloudwatch_metric_alarm.ses_bounce_rate.arn,
      aws_cloudwatch_metric_alarm.ses_complaint_rate.arn,
      aws_cloudwatch_metric_alarm.sns_delivery_failures.arn,
      aws_cloudwatch_metric_alarm.data_tier_rejects.arn,
      aws_cloudwatch_metric_alarm.postgres_slow_queries.arn,
    ]
  )

  deploy_alarm_arns = concat(
    [for a in aws_cloudwatch_metric_alarm.ecs_task_shortfall : a.arn],
    [for a in aws_cloudwatch_metric_alarm.ecs_memory_high : a.arn],
    [
      aws_cloudwatch_metric_alarm.alb_error_rate.arn,
      aws_cloudwatch_metric_alarm.alb_target_p95.arn,
      aws_cloudwatch_metric_alarm.alb_unhealthy_targets.arn,
    ]
  )

  pending_alarm_arns = [
    aws_cloudwatch_metric_alarm.pending_error_rate.arn,
    aws_cloudwatch_metric_alarm.pending_api_p95.arn,
    aws_cloudwatch_metric_alarm.pending_extraction_p95.arn,
    aws_cloudwatch_metric_alarm.pending_queue_age.arn,
    aws_cloudwatch_metric_alarm.pending_dlq_depth.arn,
    aws_cloudwatch_metric_alarm.pending_ai_spend.arn,
    aws_cloudwatch_metric_alarm.pending_sms_failures.arn,
    aws_cloudwatch_metric_alarm.pending_token_expiry.arn,
  ]
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "nt-${local.env}"

  dashboard_body = jsonencode({
    start          = "-PT12H"
    periodOverride = "auto"

    widgets = [
      {
        type   = "text"
        x      = 0
        y      = 0
        width  = 24
        height = 4
        properties = {
          markdown = join("\n", [
            "# Neoting ${local.env} — Kickoff §7.6",
            "",
            "**Empty panels below mean \"not measured yet\", not \"healthy\".** Both ECS services are at `desired_count = 0` until an image is pushed, so there is no traffic to plot. Read every flat line here as unknown, not as good news.",
            "",
            "- **Error rate** and **p95** each plot two series. The `ALB` one is AWS-emitted and starts drawing on the **first deploy**, no code required. The `in-process` one needs the app to publish to `${local.ns_pipeline}`.",
            "- **Queue age** and **model spend** have no AWS-side equivalent. They stay empty until the workers are instrumented — metric names and units are documented in `infra/envs/staging/observability.tf`.",
            "",
            "Everything under *AWS-emitted* has real data today. Alarm state is at the bottom in three groups; **grey in the \"pending\" group is expected and correct**.",
          ])
        }
      },

      # ---- Kickoff §7.6, panel 1 of 4: error rate ----
      {
        type   = "metric"
        x      = 0
        y      = 4
        width  = 6
        height = 6
        properties = {
          title  = "§7.6 Error rate (%)"
          region = local.region
          view   = "timeSeries"
          period = 300
          metrics = [
            [{ expression = "IF(albreq > 0, 100 * (elb5 + tgt5) / albreq, 0)", label = "ALB 5xx rate % (live on deploy)", id = "albrate" }],
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.main.arn_suffix, { id = "albreq", stat = "Sum", visible = false }],
            ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", aws_lb.main.arn_suffix, { id = "elb5", stat = "Sum", visible = false }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", aws_lb.main.arn_suffix, { id = "tgt5", stat = "Sum", visible = false }],
            [{ expression = "IF(reqs > 0, 100 * errs / reqs, 0)", label = "In-process error rate % (pending)", id = "apprate" }],
            [local.ns_pipeline, "http.requests", { id = "reqs", stat = "Sum", visible = false }],
            [local.ns_pipeline, "http.errors", { id = "errs", stat = "Sum", visible = false }],
          ]
          yAxis       = { left = { min = 0, label = "%", showUnits = false } }
          annotations = { horizontal = [{ label = "Gov §13.2 alert: 2%", value = 2 }] }
        }
      },

      # ---- panel 2 of 4: p95 latency ----
      {
        type   = "metric"
        x      = 6
        y      = 4
        width  = 6
        height = 6
        properties = {
          # Both series in MILLISECONDS. The ALB reports seconds, so it is scaled
          # by 1000 in metric math rather than being plotted on a second axis —
          # two latency lines in two units on one chart is how the wrong
          # conclusion gets drawn at 2 a.m.
          title  = "§7.6 API p95 latency (ms)"
          region = local.region
          view   = "timeSeries"
          period = 300
          metrics = [
            [{ expression = "albp95 * 1000", label = "ALB p95 ms (live on deploy)", id = "albms" }],
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.main.arn_suffix, { id = "albp95", stat = "p95", visible = false }],
            [local.ns_pipeline, "http.server.duration", { stat = "p95", label = "In-process p95 (pending)" }],
            [local.ns_pipeline, "http.server.duration", { stat = "p99", label = "In-process p99 (pending)" }],
          ]
          yAxis = { left = { min = 0, label = "ms", showUnits = false } }
          annotations = { horizontal = [
            { label = "SLO §13.3: 500 ms", value = 500 },
            { label = "Alert §13.2: 1000 ms", value = 1000 },
          ] }
        }
      },

      # ---- panel 3 of 4: queue age ----
      {
        type   = "metric"
        x      = 12
        y      = 4
        width  = 6
        height = 6
        properties = {
          title  = "§7.6 Queue age & DLQ"
          region = local.region
          view   = "timeSeries"
          period = 60
          metrics = [
            [local.ns_pipeline, "queue.job.age", { stat = "Maximum", label = "Oldest waiting job (s)" }],
            [local.ns_pipeline, "queue.dlq.depth", { stat = "Maximum", label = "DLQ depth", yAxis = "right" }],
          ]
          yAxis       = { left = { min = 0, label = "seconds", showUnits = false }, right = { min = 0, label = "jobs", showUnits = false } }
          annotations = { horizontal = [{ label = "Gov §13.2 alert: 5 min", value = 300 }] }
        }
      },

      # ---- panel 4 of 4: token spend ----
      {
        type   = "metric"
        x      = 18
        y      = 4
        width  = 6
        height = 6
        properties = {
          # Pence, not pounds. The money invariant is not suspended for graphs.
          title  = "§7.6 Model spend (pence) & tokens"
          region = local.region
          view   = "timeSeries"
          period = 3600
          metrics = [
            [local.ns_pipeline, "ai.spend.pence", { stat = "Sum", label = "Spend (pence/hr)" }],
            [local.ns_pipeline, "ai.tokens.input", { stat = "Sum", label = "Input tokens", yAxis = "right" }],
            [local.ns_pipeline, "ai.tokens.output", { stat = "Sum", label = "Output tokens", yAxis = "right" }],
          ]
          yAxis       = { left = { min = 0, label = "pence", showUnits = false }, right = { min = 0, label = "tokens", showUnits = false } }
          annotations = { horizontal = [{ label = "Runaway-loop alert: 200p/hr", value = 200 }] }
        }
      },

      {
        type   = "text"
        x      = 0
        y      = 10
        width  = 24
        height = 2
        properties = {
          markdown = "## AWS-emitted — real data now\nThese panels have datapoints from the moment the resource exists. If one of them is flat, that is a finding."
        }
      },

      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 8
        height = 6
        properties = {
          title  = "RDS — CPU & connections"
          region = local.region
          view   = "timeSeries"
          period = 300
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", module.data.db_instance_identifier, { stat = "Average", label = "CPU %" }],
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", module.data.db_instance_identifier, { stat = "Maximum", label = "Connections", yAxis = "right" }],
          ]
          yAxis       = { left = { min = 0, max = 100, label = "%", showUnits = false }, right = { min = 0, label = "conns", showUnits = false } }
          annotations = { horizontal = [{ label = "alarm: 80%", value = 80 }] }
        }
      },

      {
        type   = "metric"
        x      = 8
        y      = 12
        width  = 8
        height = 6
        properties = {
          title  = "RDS — free storage & memory"
          region = local.region
          view   = "timeSeries"
          period = 300
          metrics = [
            ["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", module.data.db_instance_identifier, { stat = "Average", label = "Free storage" }],
            ["AWS/RDS", "FreeableMemory", "DBInstanceIdentifier", module.data.db_instance_identifier, { stat = "Average", label = "Freeable memory", yAxis = "right" }],
          ]
          yAxis = { left = { min = 0 }, right = { min = 0 } }
        }
      },

      {
        type   = "metric"
        x      = 16
        y      = 12
        width  = 8
        height = 6
        properties = {
          # A falling credit balance on a t4g in unlimited mode is a bill, not a
          # slowdown. This panel is here for the budget review, not for triage.
          title  = "RDS — burst credits (cost signal)"
          region = local.region
          view   = "timeSeries"
          period = 300
          metrics = [
            ["AWS/RDS", "CPUCreditBalance", "DBInstanceIdentifier", module.data.db_instance_identifier, { stat = "Average", label = "Credit balance" }],
            ["AWS/RDS", "CPUSurplusCreditsCharged", "DBInstanceIdentifier", module.data.db_instance_identifier, { stat = "Sum", label = "Surplus credits CHARGED", yAxis = "right" }],
          ]
          yAxis       = { left = { min = 0 }, right = { min = 0 } }
          annotations = { horizontal = [{ label = "alarm: 60 credits", value = 60 }] }
        }
      },

      {
        type   = "metric"
        x      = 0
        y      = 18
        width  = 8
        height = 6
        properties = {
          title  = "Redis — engine CPU & memory"
          region = local.region
          view   = "timeSeries"
          period = 300
          metrics = [
            ["AWS/ElastiCache", "EngineCPUUtilization", "CacheClusterId", local.redis_node, { stat = "Average", label = "Engine CPU %" }],
            ["AWS/ElastiCache", "DatabaseMemoryUsagePercentage", "CacheClusterId", local.redis_node, { stat = "Average", label = "Memory %" }],
          ]
          yAxis       = { left = { min = 0, max = 100, label = "%", showUnits = false } }
          annotations = { horizontal = [{ label = "memory alarm: 80%", value = 80 }, { label = "engine alarm: 90%", value = 90 }] }
        }
      },

      {
        type   = "metric"
        x      = 8
        y      = 18
        width  = 8
        height = 6
        properties = {
          # Any non-zero eviction is a lost BullMQ job. Bar view because these are
          # discrete events, not a level.
          title  = "Redis — evictions & swap (job loss)"
          region = local.region
          view   = "timeSeries"
          period = 300
          metrics = [
            ["AWS/ElastiCache", "Evictions", "CacheClusterId", local.redis_node, { stat = "Sum", label = "Evictions (= lost jobs)" }],
            ["AWS/ElastiCache", "SwapUsage", "CacheClusterId", local.redis_node, { stat = "Average", label = "Swap", yAxis = "right" }],
          ]
          yAxis = { left = { min = 0 }, right = { min = 0 } }
        }
      },

      {
        type   = "metric"
        x      = 16
        y      = 18
        width  = 8
        height = 6
        properties = {
          title  = "Application error logs (log-derived)"
          region = local.region
          view   = "timeSeries"
          period = 300
          stat   = "Sum"
          metrics = [
            for s in sort(tolist(local.services)) : [local.ns_logs, "log.errors.${s}", { label = s }]
          ]
          yAxis = { left = { min = 0, label = "error lines", showUnits = false } }
        }
      },

      {
        type   = "metric"
        x      = 0
        y      = 24
        width  = 12
        height = 6
        properties = {
          title  = "Postgres slow queries (>100 ms) & data-tier rejects"
          region = local.region
          view   = "timeSeries"
          period = 300
          stat   = "Sum"
          metrics = [
            [local.ns_logs, "postgres.slow_queries", { label = "Queries over 100 ms (Gov §5.1)" }],
            [local.ns_logs, "vpc.rejects.data_tier", { label = "Rejected 5432/6379 attempts", yAxis = "right" }],
          ]
          yAxis = { left = { min = 0 }, right = { min = 0 } }
        }
      },

      {
        type   = "metric"
        x      = 12
        y      = 24
        width  = 12
        height = 6
        properties = {
          # Intake dies quietly when SES suspends. Keep it on the wall.
          title  = "SES reputation (doc@ intake depends on this)"
          region = local.region
          view   = "timeSeries"
          period = 3600
          stat   = "Average"
          metrics = [
            ["AWS/SES", "Reputation.BounceRate", { label = "Bounce rate" }],
            ["AWS/SES", "Reputation.ComplaintRate", { label = "Complaint rate" }],
          ]
          yAxis = { left = { min = 0 } }
          annotations = { horizontal = [
            { label = "AWS suspends: 5% bounce", value = 0.05 },
            { label = "AWS suspends: 0.1% complaint", value = 0.001 },
          ] }
        }
      },

      {
        type   = "alarm"
        x      = 0
        y      = 36
        width  = 12
        height = 6
        properties = {
          title  = "Alarms — live (real metrics)"
          alarms = local.live_alarm_arns
        }
      },

      # Tier 2. This widget was missing: `deploy_alarm_arns` was computed and
      # then referenced nowhere, so the group the banner above calls the
      # important tier — the ALB and ECS alarms that carry §13.2's error-rate
      # and p95 without waiting for OTel — appeared on no dashboard at all.
      # The dashboard promised three groups and drew two.
      {
        type   = "alarm"
        x      = 0
        y      = 42
        width  = 12
        height = 6
        properties = {
          title  = "Alarms — live on first deploy (ALB + ECS, no app code needed)"
          alarms = local.deploy_alarm_arns
        }
      },

      {
        type   = "alarm"
        x      = 12
        y      = 42
        width  = 12
        height = 6
        properties = {
          title  = "Alarms — pending instrumentation (grey is expected)"
          alarms = local.pending_alarm_arns
        }
      },
    ]
  })
}

# --------------------------------------------------------------------------
# COST (runbook Step 7.2 promised "a few dollars a month" — this is the sum):
#
#   KMS ops CMK                     $1.00   + a few cents of requests
#   Alarms, 35 live + pending       $3.50   $0.10 per alarm-metric; the metric-
#                                           math error-rate alarm counts as 2.
#                                           COUNTED FROM THE PLAN, not by eye:
#                                           24 resource blocks, six of which
#                                           use for_each/count, expand to 35
#                                           instances. An earlier revision said
#                                           25 because it counted blocks.
#   Custom metrics from log filters $1.50   5 metrics at $0.30 (3 services,
#                                           flow-log rejects, slow queries)
#   Dashboard                       $0.00   first 3 are free
#   SNS + EventBridge               $0.00   inside the free tier; AWS-source
#                                           events on the default bus are free
#   ----------------------------------------
#   Total                          ~$6.00/month
#
# Appendix B.2 budgets $15–25/month for "CloudWatch logs + dashboards + alarms"
# in staging, so this sits inside the line with room for log ingestion — which
# is the part of that line that actually moves. B.2's warning stands: structured
# JSON at debug level on every request can quietly out-cost RDS.
#
# WHAT IS DELIBERATELY NOT HERE:
#   * (ECS alarms USED to be listed here as absent. They are not — see
#     aws_cloudwatch_metric_alarm.ecs_task_shortfall and .ecs_memory_high in
#     this file. They are Tier 2: AWS emits them itself, so they need a pushed
#     image and a non-zero desired_count, not application code, and
#     treat_missing_data keeps them correct and silent at zero scale. The stale
#     sentence survived the tier being built.)
#   * AWS Budgets and Cost Anomaly Detection (§13.2 "metered-vendor spend
#     anomaly or budget threshold crossed"). Account-scoped, already live per
#     Gov §13.5, and owned by envs/account/. The only staging-side dependency is
#     the budgets.amazonaws.com statement in the topic policy above.
#   * ElastiCache event notifications. They are configured with a
#     `notification_topic_arn` argument on the replication group itself, which
#     lives in data.tf. FOLLOW-UP for whoever owns that file: one line,
#     `notification_topic_arn = aws_sns_topic.alerts.arn`.
# --------------------------------------------------------------------------

output "alerts_topic_arn" {
  value       = aws_sns_topic.alerts.arn
  description = "Alarm and event destination. Subscriptions are added OUT OF BAND - verify none read PendingConfirmation."
}

output "ops_kms_key_arn" { value = aws_kms_key.ops.arn }

output "dashboard_url" {
  value = "https://${local.region}.console.aws.amazon.com/cloudwatch/home?region=${local.region}#dashboards/dashboard/${aws_cloudwatch_dashboard.main.dashboard_name}"
}
