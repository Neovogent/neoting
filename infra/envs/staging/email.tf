# --------------------------------------------------------------------------
# SES — outbound identity and inbound intake for doc@ (Kickoff 2.3, 2.4, 3.5)
#
# Verification 8.2 RESOLVED 13 Aug 2026: inbound receiving IS available in
# eu-west-2, so the eu-west-1 fallback named in D30 is not needed. Every hop
# of the email path stays in London.
#
# ⚠ Production access (sandbox exit) is a support-ticket flow, not Terraform.
#
# STATUS: **DENIED**, not pending. `aws sesv2 get-account --region eu-west-2`
# returns ProductionAccessEnabled=false with ReviewDetails.Status="DENIED",
# case 178662887400793 (verified 13 Aug 2026). An earlier comment here said
# PENDING; that was wrong and the difference matters, because a denial does not
# resolve itself by waiting.
#
# What this blocks: every OUTBOUND path. Client onboarding invites (SoT §6),
# supplier statement-gap chases (D16), publish-failure and upload notifications.
# In the sandbox, SES will only deliver to verified identities — so a staging
# demo can be wired to verified test addresses, but nothing reaches a real
# recipient.
#
# What this does NOT block: inbound. Receiving works in the sandbox, so
# doc@ intake and the whole of Stage 1 are unaffected.
#
# To appeal, AWS wants the things a reviewer looks for and this account cannot
# yet show: a configuration set with bounce/complaint event handling, a stated
# suppression-list policy, and a description of who is emailed and why they
# consented. The configuration set below is the first of those.
# --------------------------------------------------------------------------

data "aws_route53_zone" "primary" {
  name         = "${local.domain}."
  private_zone = false
}

resource "aws_sesv2_email_identity" "primary" {
  email_identity         = local.domain
  configuration_set_name = aws_sesv2_configuration_set.primary.configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# --------------------------------------------------------------------------
# Configuration set + bounce/complaint handling (runbook §5.3.4).
#
# This is not optional plumbing: handling bounces and complaints is precisely
# what the production-access reviewer asks about, and this account's first
# request was DENIED. Sending to addresses that have already bounced is the
# fastest way to wreck a sending reputation, and SES's suppression list is the
# cheapest defence against doing it by accident.
# --------------------------------------------------------------------------

resource "aws_sesv2_configuration_set" "primary" {
  configuration_set_name = "nt-${local.env}-default"

  delivery_options {
    tls_policy = "REQUIRE" # never fall back to plaintext SMTP
  }

  reputation_options {
    reputation_metrics_enabled = true # bounce/complaint rates as CloudWatch metrics
  }

  # Account-level suppression already defaults to these; setting them per
  # configuration set makes the behaviour explicit rather than inherited.
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }

  sending_options {
    sending_enabled = true
  }
}

# Encrypted with the OPS key, not the documents key — the distinction matters.
#
# SNS server-side encryption requires the *publisher* to hold both
# kms:GenerateDataKey* and kms:Decrypt. The documents CMK grants
# ses.amazonaws.com encrypt-side actions only (policies/kms-docs.json.tftpl,
# AllowSESToEncryptInboundMail), and adding Decrypt there would hand SES the
# ability to decrypt customer documents purely so it could encrypt a bounce
# notification. Wrong trade: these events carry recipient addresses and
# delivery verdicts, not document content.
#
# alias/nt-staging-ops (observability.tf) is the right key — operational
# telemetry, separate blast radius, and ses.amazonaws.com is on its publisher
# list alongside cloudwatch, events and budgets. Bounce payloads contain
# recipient email addresses, so leaving the topic unencrypted was not an option
# either (Governance §11.6).
resource "aws_sns_topic" "ses_events" {
  name              = "nt-${local.env}-ses-events"
  kms_master_key_id = aws_kms_key.ops.arn
}

resource "aws_sns_topic_policy" "ses_events" {
  arn = aws_sns_topic.ses_events.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSESToPublish"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.ses_events.arn
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

resource "aws_sesv2_configuration_set_event_destination" "sns" {
  configuration_set_name = aws_sesv2_configuration_set.primary.configuration_set_name
  event_destination_name = "bounces-and-complaints"

  event_destination {
    enabled = true

    # REJECT and RENDERING_FAILURE are included because both are our bug, not
    # the recipient's, and both are invisible without this.
    matching_event_types = ["BOUNCE", "COMPLAINT", "REJECT", "RENDERING_FAILURE", "DELIVERY_DELAY"]

    sns_destination {
      topic_arn = aws_sns_topic.ses_events.arn
    }
  }
}

# Easy DKIM: three CNAMEs AWS generates and rotates.
resource "aws_route53_record" "dkim" {
  count = 3

  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "${aws_sesv2_email_identity.primary.dkim_signing_attributes[0].tokens[count.index]}._domainkey"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_sesv2_email_identity.primary.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

# Custom MAIL FROM so SPF aligns for DMARC. Without this, SPF authenticates
# amazonses.com rather than our domain and DMARC alignment fails — which is
# how onboarding invites and supplier chases end up in spam.
resource "aws_sesv2_email_identity_mail_from_attributes" "primary" {
  email_identity         = aws_sesv2_email_identity.primary.email_identity
  mail_from_domain       = "mail.${local.domain}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "mail_from_mx" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "mail"
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.${local.region}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "mail"
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}

# p=none while we watch alignment. Tighten to p=quarantine before the pilot —
# and add rua= once support@ exists (a report address that bounces is worse
# than none).
resource "aws_route53_record" "dmarc" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "_dmarc"
  type    = "TXT"
  ttl     = 600
  records = ["v=DMARC1; p=none;"]
}

# --------------------------------------------------------------------------
# Inbound: doc@ → S3 receipts bucket → ingestion pipeline (SoT Stage 1)
# --------------------------------------------------------------------------

resource "aws_ses_receipt_rule_set" "inbound" {
  rule_set_name = "nt-${local.env}-inbound"
}

resource "aws_ses_active_receipt_rule_set" "inbound" {
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
}

resource "aws_ses_receipt_rule" "doc" {
  name          = "doc-to-s3"
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
  recipients    = ["doc@${local.domain}"]
  enabled       = true
  scan_enabled  = true # spam + virus verdicts before we touch the payload
  tls_policy    = "Require"

  s3_action {
    position          = 1
    bucket_name       = local.bucket_names["receipts"]
    object_key_prefix = "inbound/"
    kms_key_arn       = aws_kms_key.docs.arn
  }

  # SES validates bucket writability at rule-creation time, so the policy and
  # the key grant must exist first.
  depends_on = [
    aws_s3_bucket_policy.this,
    aws_kms_key.docs,
  ]
}

resource "aws_route53_record" "inbound_mx" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = local.domain
  type    = "MX"
  ttl     = 600
  records = ["10 inbound-smtp.${local.region}.amazonaws.com"]
}

output "ses_dkim_tokens" {
  value       = aws_sesv2_email_identity.primary.dkim_signing_attributes[0].tokens
  description = "Published as CNAMEs; verification is async and usually completes within minutes."
}
