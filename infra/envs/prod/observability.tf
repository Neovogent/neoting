# ==========================================================================
# Observability — the hard blocker on prod carrying a single real document.
#
# `envs/prod/main.tf` listed this as the most uncomfortable omission on its
# "what is not in this root" list, and said so plainly:
#
#     ⚠ Prod must not take a single real document until this lands.
#
# This is that file. Governance §13.2 wants alerts on queue age > 5 min, and
# Appendix B.1's November pilot has no meaning without them.
#
# ==========================================================================
# WHAT IS DELIBERATELY DIFFERENT FROM envs/staging/observability.tf
#
# 1. TWO TOPICS, NOT ONE. staging's own comment says why:
#
#      "ONE topic is correct for staging and WRONG for prod. Governance §13.2
#       wants a channel on-call actually watches; mixing 'a slow query
#       happened' with 'the database is down' in one feed is how that channel
#       gets muted. Prod splits at minimum page/ vs ticket/ topics."
#
#    So: `nt-prod-page` for "a human must act now" and `nt-prod-ticket` for
#    "somebody should look tomorrow". Every alarm below names which it is and
#    the split is the first thing to check when someone says the alerts are
#    noisy.
#
# 2. NO CPU-CREDIT ALARM. staging alarms on RDS `CPUCreditBalance` because
#    db.t4g.small is burstable and `unlimited` mode bills surplus credits.
#    db.m7g.large is NOT burstable — it has no credit balance, and that metric
#    is never published. Copying the alarm across would have created one that
#    sits in INSUFFICIENT_DATA forever, which is exactly the "teaches people to
#    ignore the console" failure staging's header warns about.
#
# 3. REPLICATION ALARMS EXIST HERE AND CANNOT EXIST IN STAGING. Cross-region
#    replication to eu-west-1 is prod-only (replication.tf, ADR 0007), and
#    Governance §17 puts an RPO of ≤ 15 minutes on it. Nothing else in this
#    repo would notice a replication backlog. See the block near the foot.
#
# 4. THRESHOLDS ARE RESIZED, NOT COPIED. db.m7g.large is 2 vCPU / 8 GiB
#    Multi-AZ with 100 GB autoscaling to 1000; Redis is cache.t4g.medium × 2
#    with automatic failover; tasks are 2 GB (api) and 4 GB (workers). Every
#    number below is derived from those and says which.
#
# TREAT_MISSING_DATA POLICY — the same one rule staging applies:
#   `missing`      metrics that publish unconditionally every 60 s (RDS,
#                  ElastiCache). A gap means the telemetry broke, not that the
#                  box is fine.
#   `notBreaching` metrics that only exist when something happened (log-derived
#                  counters, replication failures). Zero events genuinely is
#                  the healthy state.
#   `breaching`    used nowhere, and in prod that is a harder call than in
#                  staging. It is still right: a metric that stops arriving is
#                  an observability failure, and paging on it would mean every
#                  CloudWatch hiccup wakes someone at 3am. The GAP itself is
#                  visible on the dashboard.
# ==========================================================================

locals {
  ns_pipeline = "Neoting/Pipeline"
  ns_logs     = "Neoting/Logs"

  # Prod runs TWO cache clusters (data.tf, redis_num_cache_clusters = 2)
  # because automatic failover requires a replica. Alarms are per-node, so a
  # per-node alarm on a two-node group is the only way to see the REPLICA
  # running out of memory before the failover lands on it.
  #
  # ⚠ `_expected`, NOT `module.data.redis_member_clusters`, AND THE DIFFERENCE
  # IS NOT COSMETIC. member_clusters is a resource attribute, so on a first
  # apply it is unknown at plan time — and `for_each` over an unknown value
  # produces NO instances rather than an error. Measured: the first envs/prod
  # plan came back with 158 resources and ZERO Redis alarms, and it would have
  # applied cleanly. Prod would have come up with no alarm on Redis evictions,
  # which in the BullMQ keyspace is permanent, silent job loss.
  #
  # The `_expected` output derives the same IDs from the module's INPUTS, so
  # they are known before anything exists. The postcondition at the foot of
  # this file asserts the two agree once they can be compared.
  redis_nodes = toset(module.data.redis_member_cluster_ids_expected)

  ecs_services = {
    api     = aws_ecs_service.api.name
    workers = aws_ecs_service.workers.name
  }

  # Log groups that carry application output. `web` is created by compute.tf
  # and stays empty while Vercel owns the frontend (G6) — filtering it would
  # create a metric that is structurally always zero and tell nobody anything.
  logged_services = toset(["api", "workers"])
}

# --------------------------------------------------------------------------
# KMS — the operational telemetry key.
#
# Same shape as staging's, and separate from both the documents key and the
# secrets key for the same reason those two are separate from each other: "who
# can read an alert" is a different question from "who can read a client's
# receipt", and the answers diverge the moment an on-call rota exists.
# --------------------------------------------------------------------------
resource "aws_kms_key" "ops" {
  description              = "Neoting production - operational telemetry: alerts, alarm notifications, log encryption"
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
        # ⚠ EVERY PUBLISHER TO AN SSE-ENABLED SNS TOPIC NEEDS GenerateDataKey*
        # AND Decrypt ON THIS KEY. Miss one and the alarm fires, SNS rejects the
        # publish, and nobody is told — the worst failure mode an alerting
        # system has, and in prod it is the failure mode that ends a pilot. Add
        # a principal HERE and in the topic policy below, never one without the
        # other.
        #
        # ses.amazonaws.com is granted ahead of use: email.tf does not exist in
        # this root yet (SES production access is still an open support case).
        # Granting now means landing SES later is a receipt-rule change rather
        # than a key-policy change made under time pressure.
        Sid    = "AllowAWSServicesToPublishToEncryptedTopic"
        Effect = "Allow"
        Principal = { Service = [
          "cloudwatch.amazonaws.com", # metric alarms
          "events.amazonaws.com",     # EventBridge rules (GuardDuty, RDS events)
          "budgets.amazonaws.com",    # AWS Budgets thresholds (Gov §13.5)
          "ses.amazonaws.com",        # bounce/complaint events, when email.tf lands
        ] }
        Action    = ["kms:GenerateDataKey*", "kms:Decrypt", "kms:DescribeKey"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
      },
      {
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
# SNS — page and ticket.
#
# NO SUBSCRIPTIONS ARE DECLARED, and in prod that matters more than it does in
# staging. An `aws_sns_topic_subscription` with protocol "email" is created in
# state as PendingConfirmation and stays there until a human clicks the link.
# Terraform reports it created and the console shows a subscriber, so the
# alerting path LOOKS wired while nothing is delivered — the dead channel
# Governance §13.2 exists to prevent, on the environment where it matters.
#
# Subscriptions are added out of band and the confirmation is the proof:
#   aws sns list-subscriptions-by-topic --topic-arn <arn> --region eu-west-2
# and no SubscriptionArn may read "PendingConfirmation".
#
# ⚠ PROD MUST NOT CARRY A REAL DOCUMENT UNTIL `page` HAS A CONFIRMED
# SUBSCRIBER. Every alarm in this file is decoration until then, and an
# unsubscribed topic is indistinguishable from a healthy one on a dashboard.
# --------------------------------------------------------------------------
resource "aws_sns_topic" "page" {
  name              = "nt-${local.env}-page"
  display_name      = "Neoting PRODUCTION - page"
  kms_master_key_id = aws_kms_key.ops.id

  tags = { Component = "observability", Severity = "page" }
}

resource "aws_sns_topic" "ticket" {
  name              = "nt-${local.env}-ticket"
  display_name      = "Neoting production - ticket"
  kms_master_key_id = aws_kms_key.ops.id

  tags = { Component = "observability", Severity = "ticket" }
}

resource "aws_sns_topic_policy" "alerts" {
  for_each = {
    page   = aws_sns_topic.page.arn
    ticket = aws_sns_topic.ticket.arn
  }

  arn = each.value

  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "nt-${local.env}-${each.key}-policy"
    Statement = [
      {
        # Without the owner statement, a topic policy listing only service
        # principals can leave the account unable to manage its own topic.
        Sid       = "AllowAccountOwnerToManageTopic"
        Effect    = "Allow"
        Principal = { AWS = "*" }
        Action = [
          "SNS:Subscribe", "SNS:Publish", "SNS:GetTopicAttributes", "SNS:SetTopicAttributes",
          "SNS:ListSubscriptionsByTopic", "SNS:AddPermission", "SNS:RemovePermission", "SNS:DeleteTopic"
        ]
        Resource  = each.value
        Condition = { StringEquals = { "AWS:SourceOwner" = local.account_id } }
      },
      {
        Sid       = "AllowCloudWatchAlarmsToPublish"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = each.value
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.account_id }
          ArnLike      = { "aws:SourceArn" = "arn:aws:cloudwatch:${local.region}:${local.account_id}:alarm:*" }
        }
      },
      {
        # Scoped to rules in this account and region so a rule belonging to
        # another product in this SHARED account (D36) cannot publish here.
        Sid       = "AllowEventBridgeRulesToPublish"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = each.value
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.account_id }
          ArnLike      = { "aws:SourceArn" = "arn:aws:events:${local.region}:${local.account_id}:rule/*" }
        }
      },
      {
        # AWS Budgets lives in envs/account/ (separate state) and cannot
        # reference this topic as a Terraform resource. This statement is the
        # whole cross-state contract. Budgets is global, hence the region-less
        # SourceArn. Governance §13.5: "a surprising bill is an alerting
        # failure."
        Sid       = "AllowAWSBudgetsToPublish"
        Effect    = "Allow"
        Principal = { Service = "budgets.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = each.value
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.account_id }
          ArnLike      = { "aws:SourceArn" = "arn:aws:budgets::${local.account_id}:*" }
        }
      }
    ]
  })
}

# --------------------------------------------------------------------------
# LIVE — RDS. db.m7g.large: 2 vCPU, 8 GiB, Multi-AZ, 100 GB → 1000 GB gp3.
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
      severity    = "ticket"
      # m7g is NOT burstable, so unlike staging there is no credit cliff hiding
      # behind this — 80% sustained is simply 80% of the machine, and the next
      # step is a bigger instance or a missing index. Ticket, not page: it
      # degrades, it does not stop.
      description = "RDS CPU above 80% for 10 of 15 minutes - a missing index or a runaway job before it is a resize"
    }
    storage-low = {
      metric      = "FreeStorageSpace"
      statistic   = "Average"
      comparison  = "LessThanThreshold"
      threshold   = 21474836480 # 20 GiB of 100 GB allocated
      period      = 300
      evaluations = 2
      datapoints  = 2
      unit        = "Bytes"
      severity    = "page"
      # PAGE. Storage autoscaling to 1000 GB should absorb this long before the
      # threshold; if it fires, autoscaling is throttled by its 6-hour cooldown
      # or has hit the cap. A full RDS volume takes the database READ-ONLY,
      # which in prod is a total outage of every write path.
      description = "RDS free storage below 20 GiB - autoscaling is not keeping up and a full volume takes the database read-only"
    }
    memory-low = {
      metric      = "FreeableMemory"
      statistic   = "Average"
      comparison  = "LessThanThreshold"
      threshold   = 536870912 # 512 MiB of 8 GiB
      period      = 300
      evaluations = 3
      datapoints  = 3
      unit        = "Bytes"
      severity    = "ticket"
      # 512 MiB rather than staging's 256 MiB: the absolute floor scales with
      # the instance, and on 8 GiB the point at which the buffer cache stops
      # being effective arrives earlier in absolute terms than on 2 GiB.
      description = "RDS freeable memory below 512 MiB of 8 GiB - the buffer cache is being squeezed and p95 will follow"
    }
    connections-high = {
      metric      = "DatabaseConnections"
      statistic   = "Maximum"
      comparison  = "GreaterThanThreshold"
      threshold   = 600
      period      = 300
      evaluations = 2
      datapoints  = 2
      unit        = "Count"
      severity    = "ticket"
      # RDS derives max_connections as LEAST({DBInstanceClassMemory/9531392},
      # 5000) — about 900 on 8 GiB. 600 leaves room to react. As in staging,
      # this fires because a task is cycling and leaking pool connections far
      # more often than because of real load.
      description = "RDS connections above 600 of ~900 - suspect a leaked connection pool, not real load"
    }
    read-latency-high = {
      metric      = "ReadLatency"
      statistic   = "Average"
      comparison  = "GreaterThanThreshold"
      threshold   = 0.05 # 50 ms
      period      = 300
      evaluations = 3
      datapoints  = 2
      unit        = "Seconds"
      severity    = "ticket"
      # Governance §5.1 budgets 100 ms p95 for a QUERY. Storage read latency is
      # a component of that, and 50 ms of it leaves nothing for the query
      # itself. gp3 at this size should sit in single-digit milliseconds, so
      # this is a "something is badly wrong with IO" signal rather than a
      # tuning one.
      description = "RDS read latency above 50 ms - gp3 should be single-digit; §5.1's 100 ms query budget is already gone"
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

  # OK notifications on deliberately. A channel that only ever carries bad news
  # gets muted; seeing the recovery is what keeps people reading it (§13.2).
  alarm_actions = [local.severity_topic[each.value.severity]]
  ok_actions    = [local.severity_topic[each.value.severity]]

  tags = { Component = "observability", Severity = each.value.severity }
}

locals {
  # The one place severity becomes a topic ARN. Every alarm names a severity
  # rather than a topic, so re-routing a class of alert is one edit here.
  severity_topic = {
    page   = aws_sns_topic.page.arn
    ticket = aws_sns_topic.ticket.arn
  }
}

# --------------------------------------------------------------------------
# LIVE — ElastiCache. cache.t4g.medium × 2 (~3 GiB usable each), automatic
# failover on.
#
# Redis is not a cache here, it is the BullMQ job store (data.tf). Memory
# pressure is DATA LOSS, not a slower page — and in prod a lost job is a
# document that is never extracted and a client who is never chased.
#
# Per-node, not per-group: with a replica, the alarm that matters most is the
# one on the node that is about to be failed over TO.
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
      severity    = "ticket"
      # EngineCPUUtilization, NOT CPUUtilization. Redis is single-threaded, so
      # on a 2-vCPU node a saturated engine reads as ~50% CPUUtilization and
      # looks healthy. This is the metric that tells the truth.
      description = "Redis engine thread above 90% - saturated regardless of what CPUUtilization says"
    }
    memory-high = {
      metric      = "DatabaseMemoryUsagePercentage"
      statistic   = "Average"
      comparison  = "GreaterThanThreshold"
      threshold   = 75
      period      = 300
      evaluations = 2
      datapoints  = 2
      unit        = "Percent"
      severity    = "page"
      # 75%, tighter than staging's 80%, and a PAGE rather than a ticket. The
      # next thing that happens after memory pressure is eviction, and eviction
      # in the BullMQ keyspace is silent, permanent job loss. The margin buys
      # the time to act before that.
      description = "Redis memory above 75% - eviction is next and an evicted BullMQ key is a permanently lost job"
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
      severity    = "page"
      # Zero tolerance and no apology for it. An evicted key in a pure cache is
      # a miss; an evicted key in the BullMQ keyspace is a job that silently
      # never runs. There is no acceptable non-zero value.
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
      severity    = "ticket"
      description = "Redis swap above 50 MiB - memory pressure, latency is about to fall off a cliff"
    }
  }

  # Cartesian product: every alarm on every node. Flattened to a map because
  # for_each needs stable string keys — a list index would re-create every
  # alarm the day a node is added.
  redis_node_alarms = {
    for pair in setproduct(tolist(local.redis_nodes), keys(local.redis_alarms)) :
    "${pair[0]}-${pair[1]}" => { node = pair[0], alarm = local.redis_alarms[pair[1]], key = pair[1] }
  }
}

resource "aws_cloudwatch_metric_alarm" "redis" {
  for_each = local.redis_node_alarms

  alarm_name          = "nt-${local.env}-redis-${each.key}"
  alarm_description   = "${each.value.node}: ${each.value.alarm.description}"
  namespace           = "AWS/ElastiCache"
  metric_name         = each.value.alarm.metric
  statistic           = each.value.alarm.statistic
  comparison_operator = each.value.alarm.comparison
  threshold           = each.value.alarm.threshold
  period              = each.value.alarm.period
  evaluation_periods  = each.value.alarm.evaluations
  datapoints_to_alarm = each.value.alarm.datapoints
  unit                = each.value.alarm.unit

  dimensions = { CacheClusterId = each.value.node }

  treat_missing_data = "missing"

  alarm_actions = [local.severity_topic[each.value.alarm.severity]]
  ok_actions    = [local.severity_topic[each.value.alarm.severity]]

  tags = { Component = "observability", Severity = each.value.alarm.severity }
}

# --------------------------------------------------------------------------
# LIVE ON DEPLOY — ALB. AWS emits these itself, so they need a pushed image and
# a non-zero desired_count, not application instrumentation. This tier is why
# §13.2's error-rate and p95 alerts do not have to wait for OTel.
#
# treat_missing_data = notBreaching, so they are correct and silent at zero
# scale rather than parked in INSUFFICIENT_DATA.
# --------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "alb_error_rate" {
  alarm_name          = "nt-${local.env}-alb-5xx-rate"
  alarm_description   = "More than 1% of requests returned 5xx over 5 minutes - §13.2's error-rate alert, measured at the load balancer so it does not depend on app instrumentation"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 1
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"

  # A RATE, not a count. Ten 5xx in an hour of heavy traffic is noise; ten in a
  # minute of light traffic is an outage. A count alarm cannot tell those
  # apart, which is how error alarms end up muted.
  metric_query {
    id          = "rate"
    expression  = "IF(requests > 0, 100 * errors / requests, 0)"
    label       = "5xx as % of requests"
    return_data = true
  }

  metric_query {
    id = "errors"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix }
    }
  }

  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 300
      stat        = "Sum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix }
    }
  }

  alarm_actions = [aws_sns_topic.page.arn]
  ok_actions    = [aws_sns_topic.page.arn]

  tags = { Component = "observability", Severity = "page" }
}

resource "aws_cloudwatch_metric_alarm" "alb_target_p95" {
  alarm_name          = "nt-${local.env}-alb-target-p95"
  alarm_description   = "Target p95 response time above 1s for 15 minutes - the user-visible half of §5.1's latency budget"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 1
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  unit                = "Seconds"
  treat_missing_data  = "notBreaching"

  dimensions = { LoadBalancer = aws_lb.main.arn_suffix }

  alarm_actions = [aws_sns_topic.ticket.arn]
  ok_actions    = [aws_sns_topic.ticket.arn]

  tags = { Component = "observability", Severity = "ticket" }
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_targets" {
  alarm_name          = "nt-${local.env}-alb-unhealthy-targets"
  alarm_description   = "PAGE: an api target has been failing its health check for 5 minutes. With two tasks this means capacity is halved; with one it means the service is down."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  unit                = "Count"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }

  alarm_actions = [aws_sns_topic.page.arn]
  ok_actions    = [aws_sns_topic.page.arn]

  tags = { Component = "observability", Severity = "page" }
}

# --------------------------------------------------------------------------
# LIVE ON DEPLOY — ECS.
# --------------------------------------------------------------------------

# "Fewer tasks running than ECS wants running", sustained.
#
# This is the alarm that catches a crash-looping container, an image that will
# not pull, and a task role missing a permission — the three ways a deploy
# fails silently while the pipeline reports success.
#
# Arithmetically silent at zero scale rather than suppressed: 0 - 0 = 0 does
# not breach, so nothing has to be switched on when the first image lands.
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

  alarm_actions = [aws_sns_topic.page.arn]
  ok_actions    = [aws_sns_topic.page.arn]

  tags = { Component = "observability", Severity = "page" }
}

# Memory, not CPU, and only memory.
#
# api is capped at 2048 MB and workers at 4096 MB (services.tf). A Node heap
# past 85% of that is heading for an OOM kill, and an OOM kill presents as "the
# deploy is flaky" rather than "we are out of memory". Fargate CPU saturation
# surfaces as latency, which the ALB p95 alarm already catches — a second alarm
# for the same incident is not more monitoring, it is more noise.
resource "aws_cloudwatch_metric_alarm" "ecs_memory_high" {
  for_each = local.ecs_services

  alarm_name          = "nt-${local.env}-${each.key}-memory-high"
  alarm_description   = "${each.key}: memory above 85% of its task limit - an OOM kill is next, and it will look like a flaky deploy"
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

  alarm_actions = [aws_sns_topic.ticket.arn]
  ok_actions    = [aws_sns_topic.ticket.arn]

  tags = { Component = "observability", Severity = "ticket" }
}

# ==========================================================================
# LIVE — CROSS-REGION REPLICATION. PROD ONLY, AND THE REASON IS THE SLA.
#
# replication.tf replicates the documents bucket to eu-west-1 with Replication
# Time Control on, because Governance §17 puts an RPO of ≤ 15 minutes on it and
# ADR 0007 makes Ireland the DR region. RTC carries a 15-minute SLA — and an
# SLA nobody measures is a hope.
#
# Staging has no equivalent because staging has no DR region, which is exactly
# why this is the gap `infra/README.md` described as "nothing would notice a
# failed S3 replication".
#
# ⚠ THESE METRICS ONLY EXIST BECAUSE THE REPLICATION RULE SETS A METRICS BLOCK.
# S3 publishes replication metrics per rule, and only when the rule opts in. If
# someone removes `metrics { status = "Enabled" }` from the rule in
# replication.tf, these three alarms go to INSUFFICIENT_DATA and the RPO stops
# being measured — while replication itself carries on looking fine.
# ==========================================================================
resource "aws_cloudwatch_metric_alarm" "replication_latency" {
  alarm_name          = "nt-${local.env}-replication-latency"
  alarm_description   = "PAGE: document replication to ${local.dr_region} is lagging past 900s. Governance §17's RPO is 15 minutes, so at this point the DR copy is outside the recovery objective the DPIA claims."
  namespace           = "AWS/S3"
  metric_name         = "ReplicationLatency"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 900 # seconds = the RPO itself
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  unit                = "Seconds"

  # notBreaching: the metric is only published while objects are in flight. No
  # replication traffic is genuinely healthy, not a gap in telemetry.
  treat_missing_data = "notBreaching"

  dimensions = {
    SourceBucket      = local.bucket_names["docs"]
    DestinationBucket = local.dr_bucket_name
    RuleId            = "docs-to-${local.dr_region}"
  }

  alarm_actions = [aws_sns_topic.page.arn]
  ok_actions    = [aws_sns_topic.page.arn]

  tags = { Component = "observability", Severity = "page" }
}

resource "aws_cloudwatch_metric_alarm" "replication_failed" {
  alarm_name          = "nt-${local.env}-replication-failed"
  alarm_description   = "PAGE: an object FAILED to replicate to ${local.dr_region}. Failed replications are not retried automatically - the object needs S3 Batch Replication or it stays single-copy forever."
  namespace           = "AWS/S3"
  metric_name         = "OperationsFailedReplication"
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  unit                = "Count"
  treat_missing_data  = "notBreaching"

  dimensions = {
    SourceBucket      = local.bucket_names["docs"]
    DestinationBucket = local.dr_bucket_name
    RuleId            = "docs-to-${local.dr_region}"
  }

  # Zero tolerance, and the reason is that this one does not heal. A latency
  # spike drains; a FAILED replication is permanent until somebody runs a batch
  # job. Every failure is a document that exists in exactly one region while
  # the DPIA says otherwise.
  alarm_actions = [aws_sns_topic.page.arn]
  ok_actions    = [aws_sns_topic.page.arn]

  tags = { Component = "observability", Severity = "page" }
}

resource "aws_cloudwatch_metric_alarm" "replication_pending_backlog" {
  alarm_name          = "nt-${local.env}-replication-backlog"
  alarm_description   = "Objects have been pending replication to ${local.dr_region} for 30 minutes - a backlog that is draining is fine, one that is not is the RPO quietly slipping"
  namespace           = "AWS/S3"
  metric_name         = "OperationsPendingReplication"
  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 300
  evaluation_periods  = 6
  datapoints_to_alarm = 6
  unit                = "Count"
  treat_missing_data  = "notBreaching"

  dimensions = {
    SourceBucket      = local.bucket_names["docs"]
    DestinationBucket = local.dr_bucket_name
    RuleId            = "docs-to-${local.dr_region}"
  }

  # Ticket rather than page: six consecutive periods of a non-empty queue is a
  # trend, and the latency alarm above pages if it turns into a breach.
  alarm_actions = [aws_sns_topic.ticket.arn]
  ok_actions    = [aws_sns_topic.ticket.arn]

  tags = { Component = "observability", Severity = "ticket" }
}

# --------------------------------------------------------------------------
# LIVE — log-derived metrics.
#
# Governance §13.1 mandates structured JSON logs with a `level` field. These
# filters are load-bearing consumers of that contract: change the log shape and
# they go silently to zero, which is why the log-shape assertion belongs in the
# logger's unit tests rather than being trusted here.
# --------------------------------------------------------------------------
resource "aws_cloudwatch_log_metric_filter" "log_errors" {
  for_each = local.logged_services

  name           = "nt-${local.env}-${each.key}-errors"
  log_group_name = aws_cloudwatch_log_group.service[each.key].name
  pattern        = "{ $.level = \"error\" }"

  metric_transformation {
    name          = "log.errors.${each.key}"
    namespace     = local.ns_logs
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# An absolute count, not a rate — a rate needs a request counter the app does
# not emit yet (see the pending block below for §13.2's real alarm).
#
# The threshold is HIGHER than staging's, not lower, and that is deliberate:
# staging's only traffic is our own smoke tests, so 10 error lines there is
# always worth a look. Prod serves real users, where a handful of validation
# errors per five minutes is a Tuesday. 50 is the point at which it stops
# looking like users and starts looking like us.
resource "aws_cloudwatch_metric_alarm" "log_errors" {
  for_each = local.logged_services

  alarm_name          = "nt-${local.env}-${each.key}-log-errors"
  alarm_description   = "${each.key}: more than 50 error-level log lines in 5 minutes - past the point where this looks like user error rather than ours"
  namespace           = local.ns_logs
  metric_name         = "log.errors.${each.key}"
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 50
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.ticket.arn]
  ok_actions    = [aws_sns_topic.ticket.arn]

  tags = { Component = "observability", Severity = "ticket" }
}

# --------------------------------------------------------------------------
# LIVE — Postgres slow queries, straight out of the RDS log export.
#
# The parameter group sets log_min_duration_statement = 100 (modules/data),
# which is what makes Governance §5.1's "any query over 100 ms p95 gets an
# EXPLAIN ANALYZE and an issue" enforceable rather than aspirational. This is
# the counter that makes it visible without anyone tailing a log.
# --------------------------------------------------------------------------
resource "aws_cloudwatch_log_metric_filter" "postgres_slow_queries" {
  name           = "nt-${local.env}-postgres-slow-queries"
  log_group_name = "/aws/rds/instance/${module.data.db_instance_identifier}/postgresql"
  pattern        = "duration:"

  metric_transformation {
    name          = "postgres.slow_queries"
    namespace     = local.ns_logs
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "postgres_slow_queries" {
  alarm_name          = "nt-${local.env}-postgres-slow-queries"
  alarm_description   = "More than 100 queries over 100 ms in 5 minutes - §5.1 wants an EXPLAIN ANALYZE and an issue, not a resize"
  namespace           = local.ns_logs
  metric_name         = "postgres.slow_queries"
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 100
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.ticket.arn]
  ok_actions    = [aws_sns_topic.ticket.arn]

  tags = { Component = "observability", Severity = "ticket" }
}

# --------------------------------------------------------------------------
# LIVE — EventBridge routing for things that are not metrics.
#
# GuardDuty findings and RDS events are EVENTS, not datapoints. There is no
# metric to threshold; the finding either happened or it did not.
# --------------------------------------------------------------------------
resource "aws_cloudwatch_event_rule" "guardduty_findings" {
  name        = "nt-${local.env}-guardduty-findings"
  description = "GuardDuty findings at severity 7.0+ (HIGH and CRITICAL) in production"

  event_pattern = jsonencode({
    source        = ["aws.guardduty"]
    "detail-type" = ["GuardDuty Finding"]
    # 7.0+ only. MEDIUM findings in a shared account (D36) are dominated by
    # other products' noise, and a page that is usually somebody else's is a
    # page that gets ignored.
    detail = { severity = [{ numeric = [">=", 7] }] }
  })

  tags = { Component = "observability" }
}

resource "aws_cloudwatch_event_target" "guardduty_findings" {
  rule      = aws_cloudwatch_event_rule.guardduty_findings.name
  target_id = "page"
  arn       = aws_sns_topic.page.arn
}

resource "aws_cloudwatch_event_rule" "rds_events" {
  name        = "nt-${local.env}-rds-events"
  description = "RDS failover, low storage and Multi-AZ events for the production instance"

  event_pattern = jsonencode({
    source        = ["aws.rds"]
    "detail-type" = ["RDS DB Instance Event"]
    detail = {
      # 0049/0050/0051 are the Multi-AZ failover trio, 0006 is a restart, 0089
      # and 0090 are storage. On a Multi-AZ instance a failover is the single
      # most important event RDS emits and it produces NO metric — the instance
      # simply carries on, on the other side, with a latency blip.
      EventID = [
        "RDS-EVENT-0049", "RDS-EVENT-0050", "RDS-EVENT-0051",
        "RDS-EVENT-0006", "RDS-EVENT-0089", "RDS-EVENT-0090",
      ]
    }
  })

  tags = { Component = "observability" }
}

resource "aws_cloudwatch_event_target" "rds_events" {
  rule      = aws_cloudwatch_event_rule.rds_events.name
  target_id = "page"
  arn       = aws_sns_topic.page.arn
}

# ==========================================================================
# PENDING INSTRUMENTATION — the Neoting/Pipeline namespace.
#
# These need application code. They are created anyway and sit in
# INSUFFICIENT_DATA, which is TRUTHFUL: we do not know the queue age, so the
# alarm must not claim OK.
#
# They are SILENT while grey — no alarm here sets insufficient_data_actions, so
# nobody is paged by absence. $0.10/month each buys the guarantee that they
# light up on their own the day the metric starts flowing, instead of becoming
# a "wire up the §13.2 alarms" ticket that outlives the pilot.
#
# ⚠ THE QUEUE-AGE ONE IS NAMED IN THE GOVERNANCE DOCUMENT. §13.2 asks for an
# alert on queue age > 5 minutes, and `envs/prod/main.tf` cites it as the
# reason prod must not carry pilot traffic without this file.
# ==========================================================================
locals {
  pending_alarms = {
    queue-age = {
      metric      = "queue.age.oldest"
      statistic   = "Maximum"
      comparison  = "GreaterThanThreshold"
      threshold   = 300 # 5 minutes, exactly as §13.2 words it
      period      = 300
      evaluations = 2
      severity    = "page"
      description = "PAGE: oldest queued job older than 5 minutes (Governance §13.2). The ingest lane has stalled - documents are arriving and not being processed."
    }
    dlq-depth = {
      metric      = "queue.dlq.depth"
      statistic   = "Maximum"
      comparison  = "GreaterThanThreshold"
      threshold   = 0
      period      = 300
      evaluations = 1
      severity    = "page"
      description = "PAGE: a job exhausted its retries and landed in the dead-letter queue. apps/api/CLAUDE.md: an exhausted retry pages."
    }
    extraction-p95 = {
      metric      = "extraction.duration.p95"
      statistic   = "Maximum"
      comparison  = "GreaterThanThreshold"
      threshold   = 30000 # ms
      period      = 300
      evaluations = 3
      severity    = "ticket"
      description = "Extraction p95 above 30s - the pipeline is degrading before it is failing"
    }
    ai-spend = {
      metric      = "ai.spend.pence.hourly"
      statistic   = "Sum"
      comparison  = "GreaterThanThreshold"
      threshold   = 500000 # £5,000/hr in pence — a runaway, not a busy day
      period      = 3600
      evaluations = 1
      severity    = "page"
      description = "PAGE: model spend above £5,000 in an hour. Governance §13.5 - a surprising bill is an alerting failure. Integer pence, per the money invariant."
    }
    sms-failures = {
      metric      = "sms.send.failures"
      statistic   = "Sum"
      comparison  = "GreaterThanThreshold"
      threshold   = 5
      period      = 900
      evaluations = 1
      severity    = "ticket"
      description = "More than 5 SMS sends failed in 15 minutes - clients are not being chased and nobody would otherwise know"
    }
    token-expiry = {
      metric      = "integration.tokens.expiring"
      statistic   = "Maximum"
      comparison  = "GreaterThanThreshold"
      threshold   = 0
      period      = 3600
      evaluations = 1
      severity    = "ticket"
      description = "A Xero/QBO/TrueLayer refresh token expires within 7 days - publishing stops silently when one lapses"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "pending" {
  for_each = local.pending_alarms

  alarm_name          = "nt-${local.env}-${each.key}"
  alarm_description   = each.value.description
  namespace           = local.ns_pipeline
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  comparison_operator = each.value.comparison
  threshold           = each.value.threshold
  period              = each.value.period
  evaluation_periods  = each.value.evaluations
  datapoints_to_alarm = each.value.evaluations

  # `missing`, so an un-emitted metric shows INSUFFICIENT_DATA (truthful)
  # rather than OK (a lie). And deliberately NO insufficient_data_actions:
  # grey must be silent, or every one of these pages on the day it is applied.
  treat_missing_data = "missing"

  alarm_actions = [local.severity_topic[each.value.severity]]
  ok_actions    = [local.severity_topic[each.value.severity]]

  tags = { Component = "observability", Severity = each.value.severity, Tier = "pending-instrumentation" }
}

# --------------------------------------------------------------------------
# The dashboard.
#
# The text widget at the top is not decoration. A panel reading "No data" next
# to a banner explaining why is honest; the same panel without the banner reads
# as "healthy" and is a lie.
# --------------------------------------------------------------------------
resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "nt-${local.env}"

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "text", x = 0, y = 0, width = 24, height = 4
        properties = {
          markdown = join("\n", [
            "# Neoting **production**",
            "",
            "**Empty panels mean \"not measured yet\", not \"healthy\".** Panels in the *Pipeline* row need application instrumentation that does not exist yet — read a flat line there as unknown, never as good news.",
            "",
            "Alerts split two ways: **`nt-prod-page`** (act now) and **`nt-prod-ticket`** (look tomorrow). ⚠ Neither topic has a subscriber until a human confirms one out of band — an unsubscribed topic looks identical to a healthy one from here.",
          ])
        }
      },
      {
        type = "metric", x = 0, y = 4, width = 12, height = 6
        properties = {
          title  = "RDS — CPU / connections",
          region = local.region, view = "timeSeries", stacked = false
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", module.data.db_instance_identifier],
            [".", "DatabaseConnections", ".", "."],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 4, width = 12, height = 6
        properties = {
          title  = "RDS — free storage / freeable memory",
          region = local.region, view = "timeSeries", stacked = false
          metrics = [
            ["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", module.data.db_instance_identifier],
            [".", "FreeableMemory", ".", "."],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 10, width = 12, height = 6
        properties = {
          title  = "Redis — engine CPU and memory, per node",
          region = local.region, view = "timeSeries", stacked = false
          metrics = flatten([
            for node in tolist(local.redis_nodes) : [
              ["AWS/ElastiCache", "EngineCPUUtilization", "CacheClusterId", node],
              ["AWS/ElastiCache", "DatabaseMemoryUsagePercentage", "CacheClusterId", node],
            ]
          ])
        }
      },
      {
        type = "metric", x = 12, y = 10, width = 12, height = 6
        properties = {
          title  = "ALB — request count, 5xx, p95",
          region = local.region, view = "timeSeries", stacked = false
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.main.arn_suffix, { stat = "Sum" }],
            [".", "HTTPCode_Target_5XX_Count", ".", ".", { stat = "Sum" }],
            [".", "TargetResponseTime", ".", ".", { stat = "p95" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 16, width = 12, height = 6
        properties = {
          title  = "DR replication to ${local.dr_region} — latency and failures (RPO 15 min)",
          region = local.region, view = "timeSeries", stacked = false
          metrics = [
            ["AWS/S3", "ReplicationLatency", "SourceBucket", local.bucket_names["docs"], "DestinationBucket", local.dr_bucket_name, "RuleId", "docs-to-${local.dr_region}"],
            [".", "OperationsPendingReplication", ".", ".", ".", ".", ".", "."],
            [".", "OperationsFailedReplication", ".", ".", ".", ".", ".", "."],
          ]
          annotations = {
            horizontal = [{ label = "Governance §17 RPO — 15 min", value = 900 }]
          }
        }
      },
      {
        type = "metric", x = 12, y = 16, width = 12, height = 6
        properties = {
          title  = "ECS — running vs desired",
          region = local.region, view = "timeSeries", stacked = false
          metrics = flatten([
            for name in values(local.ecs_services) : [
              ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", name],
              ["ECS/ContainerInsights", "DesiredTaskCount", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", name],
            ]
          ])
        }
      },
      {
        type = "metric", x = 0, y = 22, width = 24, height = 6
        properties = {
          title  = "Pipeline — NOT INSTRUMENTED YET, a flat line here means unknown",
          region = local.region, view = "timeSeries", stacked = false
          metrics = [
            [local.ns_pipeline, "queue.age.oldest"],
            [".", "queue.dlq.depth"],
            [".", "extraction.duration.p95"],
          ]
          annotations = {
            horizontal = [{ label = "§13.2 queue age — 5 min", value = 300 }]
          }
        }
      },
    ]
  })
}

# --------------------------------------------------------------------------
# COST, itemised, because Appendix B.2 calls CloudWatch the sleeper line item.
#
#   Metric alarms      ~46 × $0.10        ≈ $4.60/mo
#     (5 RDS, 8 Redis (4 × 2 nodes), 3 ALB, 4 ECS, 2 log, 1 slow-query,
#      3 replication, 6 pending)
#   Custom metrics     ~10 × $0.30        ≈ $3.00/mo
#   Dashboard          first 3 are free   = $0.00
#   SNS                first 1k emails    = $0.00
#   KMS                1 CMK              = $1.00/mo
#                                          ---------
#                                          ≈ $8.60/mo
#
# Against the ~$15–25/mo `envs/prod/main.tf` budgeted for this, and against the
# alternative of finding out about a replication backlog from a client.
#
# AMP/AMG (~$40–70/mo) stay deferred to Infra Week for the same reason staging
# defers them: it is the OTel instrumentation that carries over, not this file.
# --------------------------------------------------------------------------

output "page_topic_arn" {
  value       = aws_sns_topic.page.arn
  description = "⚠ Has no subscriber until one is confirmed out of band. Prod must not carry a real document before then."
}

output "ticket_topic_arn" { value = aws_sns_topic.ticket.arn }
output "ops_kms_key_arn" { value = aws_kms_key.ops.arn }

# The other half of the `_expected` trade-off.
#
# The Redis alarms are keyed on node IDs DERIVED from the module's inputs,
# because the real ones are unknown before the group exists. That buys alarms
# on the first apply and costs a guess. This postcondition is what stops the
# guess going unchecked: it compares the derived IDs against what AWS actually
# created, at apply time, and FAILS THE APPLY if they diverge.
#
# Without it, a change to the replication group's naming would leave every
# Redis alarm pointing at a CacheClusterId that does not exist — permanently
# INSUFFICIENT_DATA, green-looking, measuring nothing.
output "redis_node_ids" {
  value = module.data.redis_member_clusters

  precondition {
    condition = toset(module.data.redis_member_clusters) == toset(module.data.redis_member_cluster_ids_expected)
    error_message = join(" ", [
      "Redis node IDs do not match what the alarms were keyed on.",
      "Expected ${join(", ", module.data.redis_member_cluster_ids_expected)};",
      "AWS created ${join(", ", module.data.redis_member_clusters)}.",
      "Every alarm in observability.tf keyed on CacheClusterId is now pointing at a node that does not exist —",
      "they will sit in INSUFFICIENT_DATA and monitor nothing.",
      "Fix redis_member_cluster_ids_expected in modules/data/outputs.tf to match the real naming.",
    ])
  }
}

output "dashboard_url" {
  value = "https://${local.region}.console.aws.amazon.com/cloudwatch/home?region=${local.region}#dashboards:name=nt-${local.env}"
}
