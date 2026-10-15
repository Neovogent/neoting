# ==========================================================================
# SMS delivery receipts (rush/chase-detection) — written, NOT applied.
#
#   chase send (ConfigurationSetName) → End User Messaging configuration set
#   → event destination → SNS topic → SQS queue → workers
#   (apps/api/src/modules/chase/sms-delivery-events.ts)
#
# The consumer writes delivery state and cost_pence onto sms_log, and emails
# the same reviewed message when a text is reported undelivered.
#
# Same topology as sms-inbound.tf and for the same reason: End User Messaging
# event destinations accept SNS (or Firehose / CloudWatch Logs), never SQS
# directly, and SNS keeps nothing — the queue is what survives a worker restart.
#
# ⚠ The configuration set and its event destination are a CloudFormation
# stack: the AWS provider has `aws_pinpointsmsvoicev2_configuration_set` but no
# event-destination resource, and `AWS::SMSVOICE::ConfigurationSet` carries
# both in one declarative unit, so nothing here is a CLI side effect.
# ==========================================================================

locals {
  sms_configuration_set_name = "nt-${local.env}-sms"
}

resource "aws_sns_topic" "sms_events" {
  name = "nt-${local.env}-sms-events"
  tags = { Component = "sms" }
}

resource "aws_sns_topic_policy" "sms_events" {
  arn = aws_sns_topic.sms_events.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "Owner"
        Effect    = "Allow"
        Principal = { AWS = local.account_id }
        Action = [
          "SNS:Publish", "SNS:Subscribe", "SNS:GetTopicAttributes",
          "SNS:SetTopicAttributes", "SNS:ListSubscriptionsByTopic",
          "SNS:DeleteTopic", "SNS:AddPermission", "SNS:RemovePermission",
        ]
        Resource = aws_sns_topic.sms_events.arn
      },
      {
        # Shared account: SourceAccount pins the service principal to us.
        Sid       = "AllowEndUserMessagingEvents"
        Effect    = "Allow"
        Principal = { Service = "sms-voice.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.sms_events.arn
        Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
      },
    ]
  })
}

resource "aws_sqs_queue" "sms_events_dlq" {
  name                      = "nt-${local.env}-sms-events-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = { Component = "sms" }
}

resource "aws_sqs_queue" "sms_events" {
  name = "nt-${local.env}-sms-events"

  # The consumer long-polls 20 s; a batch is a few DB writes and at most one
  # email, well inside 60 s.
  visibility_timeout_seconds = 60
  receive_wait_time_seconds  = 20
  message_retention_seconds  = 345600

  # SQS-managed SSE: SNS can deliver into it with no KMS key-policy grant
  # (an SSE-KMS queue silently drops SNS deliveries without one).
  sqs_managed_sse_enabled = true

  # An event whose sms_log row never appears (a sign-in code text, which has
  # none) is dropped by the consumer after 10 minutes; anything it cannot
  # handle five times lands here rather than looping.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.sms_events_dlq.arn
    maxReceiveCount     = 5
  })

  tags = { Component = "sms" }
}

resource "aws_sqs_queue_policy" "sms_events" {
  queue_url = aws_sqs_queue.sms_events.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSnsEvents"
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.sms_events.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.sms_events.arn } }
    }]
  })
}

resource "aws_sns_topic_subscription" "sms_events_to_sqs" {
  topic_arn = aws_sns_topic.sms_events.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.sms_events.arn
  # Raw delivery: the queue holds End User Messaging's own event JSON. The
  # consumer also unwraps an SNS envelope, so flipping this is not a break.
  raw_message_delivery = true
}

resource "aws_cloudformation_stack" "sms_configuration_set" {
  name = "nt-${local.env}-sms-configuration-set"

  template_body = jsonencode({
    AWSTemplateFormatVersion = "2010-09-09"
    Resources = {
      ConfigurationSet = {
        Type = "AWS::SMSVOICE::ConfigurationSet"
        Properties = {
          ConfigurationSetName = local.sms_configuration_set_name
          EventDestinations = [{
            EventDestinationName = "delivery-receipts"
            Enabled              = true
            MatchingEventTypes   = ["TEXT_ALL"]
            SnsDestination       = { TopicArn = aws_sns_topic.sms_events.arn }
          }]
          Tags = [{ Key = "Component", Value = "sms" }]
        }
      }
    }
  })

  depends_on = [aws_sns_topic_policy.sms_events]
}

# The task role may drain this queue — nothing else, and no send/purge.
resource "aws_iam_role_policy" "app_sms_events" {
  name = "nt-sms-events"
  role = aws_iam_role.app.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "SmsDeliveryReceipts"
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = aws_sqs_queue.sms_events.arn
    }]
  })
}

output "sms_events_queue_url" {
  description = "Queue the workers drain for SMS delivery receipts (SMS_EVENTS_QUEUE_URL)."
  value       = aws_sqs_queue.sms_events.url
}
