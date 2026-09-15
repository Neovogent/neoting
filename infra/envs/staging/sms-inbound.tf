# ==========================================================================
# Inbound SMS — the reply half of the chase rail
#
# Two-way SMS on the UK long code +447441471756 (owner approved the number
# 9 Sep 2026; registration GB_LONG_CODE_REGISTRATION is COMPLETE). AWS End
# User Messaging delivers an inbound message to ONE destination and the API
# accepts only an SNS topic or an Amazon Connect instance — an SQS ARN is
# rejected with MEMBER_IS_INVALID. So the topic is the channel and the queue
# is subscribed to it: SNS has no retention, and a reply that arrives while
# the consumer is down must still be there when it comes back.
#
# ⚠ THE PHONE NUMBER ITSELF IS NOT TERRAFORM-MANAGED. It was leased and
# registered through the console, and `TwoWayEnabled`/`TwoWayChannelArn` were
# set by CLI against the topic below. There is no aws_pinpoint_phone_number
# resource in this provider to import it into. If this topic is ever renamed
# or destroyed, the number keeps pointing at a dead ARN and inbound silently
# stops — re-point it with:
#   aws pinpoint-sms-voice-v2 update-phone-number \
#     --phone-number-id phone-b307702afd4b4c598b92e6e9ff73b71c \
#     --two-way-enabled --two-way-channel-arn <new topic arn>
#
# ⚠ NOTHING CONSUMES THIS QUEUE YET. Replies accumulate for 14 days and are
# then dropped. Wiring it to chase auto-close (`modules/chase/auto-close.ts`,
# SoT §4 Stage 8.5) is a separate change and gated on D45 — an inbound number
# must resolve to a registered contact before a reply may close anything.
# ==========================================================================

resource "aws_sns_topic" "sms_inbound" {
  name = "nt-${local.env}-sms-inbound"
  tags = { Component = "sms" }
}

resource "aws_sns_topic_policy" "sms_inbound" {
  arn = aws_sns_topic.sms_inbound.arn

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
        Resource = aws_sns_topic.sms_inbound.arn
      },
      {
        # End User Messaging publishes here on every inbound SMS. SourceAccount
        # pins it to us: this is a shared account and the service principal is
        # the same one for every AWS customer.
        Sid       = "AllowEndUserMessagingInbound"
        Effect    = "Allow"
        Principal = { Service = "sms-voice.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.sms_inbound.arn
        Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
      },
    ]
  })
}

resource "aws_sqs_queue" "sms_inbound" {
  name = "nt-${local.env}-sms-inbound"

  # 14 days, the maximum — same reasoning as the av-scan DLQ. A client reply
  # is evidence in an audit trail, not a transient event.
  message_retention_seconds = 1209600

  tags = { Component = "sms" }
}

resource "aws_sqs_queue_policy" "sms_inbound" {
  queue_url = aws_sqs_queue.sms_inbound.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSnsInbound"
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.sms_inbound.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.sms_inbound.arn } }
    }]
  })
}

resource "aws_sns_topic_subscription" "sms_inbound_to_sqs" {
  topic_arn = aws_sns_topic.sms_inbound.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.sms_inbound.arn

  # Raw delivery: the consumer parses End User Messaging's own inbound JSON
  # (originationNumber, destinationNumber, messageBody, ...) rather than
  # unwrapping an SNS envelope around a JSON string first.
  raw_message_delivery = true
}

# These four already exist — created by CLI on 11 Sep 2026 to turn two-way on
# the same day the number was approved, ahead of this file. Import blocks so
# the next apply ADOPTS them instead of failing on AlreadyExists.
import {
  to = aws_sns_topic.sms_inbound
  id = "arn:aws:sns:${local.region}:${local.account_id}:nt-${local.env}-sms-inbound"
}

import {
  to = aws_sqs_queue.sms_inbound
  id = "https://sqs.${local.region}.amazonaws.com/${local.account_id}/nt-${local.env}-sms-inbound"
}

# The subscription too, and this one is not optional: without it an apply
# creates a SECOND subscription and every inbound reply is delivered twice.
import {
  to = aws_sns_topic_subscription.sms_inbound_to_sqs
  id = "arn:aws:sns:${local.region}:${local.account_id}:nt-${local.env}-sms-inbound:25e34c55-1787-408e-88f8-f79427625512"
}
