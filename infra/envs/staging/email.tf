# --------------------------------------------------------------------------
# SES — outbound identity and inbound intake for doc@ (Kickoff 2.3, 2.4, 3.5)
#
# Verification 8.2 RESOLVED 13 Aug 2026: inbound receiving IS available in
# eu-west-2, so the eu-west-1 fallback named in D30 is not needed. Every hop
# of the email path stays in London.
#
# ⚠ Production access (sandbox exit) is a support-ticket flow, not Terraform.
#
# STATUS: **case open, pending OUR reply** — case 178662887400793.
#
# Read the API status carefully, because it is misleading on its own:
# `aws sesv2 get-account --region eu-west-2` reports
# ProductionAccessEnabled=false with ReviewDetails.Status="DENIED", but the
# support case itself is "Pending customer action" — AWS replied within the
# hour asking for more detail on sending processes, bounce handling and
# recipient-list management. SES marks access as denied while it waits.
#
# So this is NOT a refusal and NOT a timer running down on its own. It is a
# question waiting for an answer, and nothing moves until someone answers it.
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
# ⚠ `p=none` WITHOUT `rua=` COLLECTS NOTHING. That was the state until now, and
# it is worth naming because it looks finished: a DMARC record existed, DKIM and
# SPF aligned, and every checker reported "DMARC configured".
#
# `p=none` is monitor mode — its entire purpose is to gather aggregate reports
# BEFORE tightening. With no `rua=`, no receiver has anywhere to send them, so
# the policy did the one thing DMARC can do without reports: nothing. The
# runbook (§5.3) says to tighten to `p=quarantine` "once reports are clean";
# there was no path to ever knowing.
#
# WHY THE REPORT ADDRESS IS ON OUR OWN DOMAIN, and why a personal mailbox is not
# an option: RFC 7489 §7.1 requires cross-domain reporting to be AUTHORISED by
# the receiving domain, which publishes
#   <our-domain>._report._dmarc.<their-domain>  TXT  "v=DMARC1"
# Pointing `rua` at, say, a Gmail address means gmail.com would have to publish
# that record for us. It will not. Conforming reporters check, find no
# authorisation, and silently drop the report — so the obvious "one-line fix"
# produces exactly the same nothing, with the appearance of a fix.
#
# `fo=1` asks for a failure report when ANY mechanism fails, rather than the
# default (only when everything fails) — the useful setting while a sending
# domain is still being shaken out.
resource "aws_route53_record" "dmarc" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "_dmarc"
  type    = "TXT"
  ttl     = 600
  records = ["v=DMARC1; p=none; rua=mailto:dmarc@${local.domain}; fo=1;"]
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

  # ⚠ NO kms_key_arn HERE, AND THAT IS DELIBERATE. Read before "fixing" it.
  #
  # Naming a KMS key on an SES s3_action does NOT produce an SSE-KMS object.
  # AWS: "Your mail is encrypted by SES using the S3 encryption client before
  # the mail is submitted to S3 for storage. It is not encrypted using S3
  # server-side encryption... you must use the S3 encryption client to decrypt
  # the email after retrieving it from S3... This encryption client is
  # available in the AWS SDK for Java and the AWS SDK for Ruby."
  #
  # So the object would be AWS-Encryption-SDK envelope ciphertext, and the only
  # runtime in this repository is TypeScript — for which AWS ships no S3
  # encryption client. The ingestion worker would GetObject, receive a 200 and
  # a body of binary, and either throw in the MIME parser or, worse, succeed on
  # garbage and file a document with an empty extraction. Nothing downstream
  # would signal an encryption problem; it would present as malformed email.
  # That is SoT Stage 1's email intake — the one intake path that works today,
  # since inbound receiving is unaffected by the SES sandbox.
  #
  # Omitting the key means the object lands under the bucket's default, which
  # for `receipts` is AES256 (SSE-S3) for the separate SES-validation reason in
  # main.tf. The trade, accepted knowingly: raw inbound MIME sits under an
  # AWS-managed key rather than our CMK, so it is outside D36's explicit-Deny
  # boundary. It is acceptable because that object is transient — lifecycle.tf
  # expires `inbound/` at 30 days — and the DOCUMENT extracted from it lands in
  # the docs bucket under alias/nt-staging-docs, which is the artefact with the
  # six-year retention and the customer-document data class. D30 residency is
  # untouched either way: eu-west-2, encrypted at rest, never leaves London.
  #
  # Recorded in ADR 0002, which owns the receipt-bucket topology.
  s3_action {
    position          = 1
    bucket_name       = local.bucket_names["receipts"]
    object_key_prefix = "inbound/"
  }

  # SES validates bucket writability at rule-creation time, so the bucket, its
  # policy and the key grant must all exist first.
  #
  # ⚠ THIS `depends_on` IS NOT DECORATIVE, AND IT CANNOT BE NARROWED. The
  # s3_action above names the bucket by STRING (local.bucket_names, which the
  # module derives from its inputs, not from the aws_s3_bucket resources), so
  # Terraform infers no ordering edge from it whatsoever. Without this line the
  # rule is created concurrently with the bucket policy and fails validation on
  # a cold apply — intermittently, which is the worst way to find out.
  #
  # It names the whole module rather than the policy resource because
  # depends_on takes static addresses only and a module's internals are not
  # addressable from here. Coarser than it was when the buckets were flat; the
  # trade is one unnecessary ordering edge against a real correctness bug.
  depends_on = [module.storage]
}

# The other half of the `rua=` above. Naming a report address the MX does not
# accept would bounce every report — a receiver that cannot deliver simply stops
# trying, and we would be back to collecting nothing while believing otherwise.
#
# Reports are gzipped XML, one per reporting domain per day, a few KB each: the
# volume is negligible and nothing consumes them automatically yet. Reading them
# is a human step before the `p=quarantine` decision (runbook §5.3), which is
# what they exist for.
#
# NOT customer data despite sharing the receipts bucket: an aggregate report
# contains sending IPs, message counts and pass/fail verdicts for OUR domain.
# The `dmarc/` prefix keeps it out of `inbound/`, which is what the ingestion
# pipeline and the AV scanner read.
resource "aws_ses_receipt_rule" "dmarc_reports" {
  name          = "dmarc-reports-to-s3"
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
  recipients    = ["dmarc@${local.domain}"]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Require"

  # Ordering is explicit rather than incidental. The rules match disjoint
  # recipients so evaluation order cannot change behaviour today — but SES
  # positions are global to the rule set, and a future catch-all rule would make
  # order load-bearing overnight.
  after = aws_ses_receipt_rule.doc.name

  # No kms_key_arn, for the reason documented at length on the `doc` rule above:
  # SES's key argument produces AWS-Encryption-SDK envelope ciphertext, not an
  # SSE-KMS object, and there is no TypeScript client that can decrypt it.
  #
  # ⚠ THIS PREFIX IS COUPLED TO THE BUCKET POLICY, AND THE FAILURE IS UGLY.
  # `modules/storage/policies/bucket-receipts.json.tftpl` grants
  # `ses.amazonaws.com` PutObject on an EXPLICIT LIST of prefixes. A rule
  # writing anywhere else is rejected at CREATE time with
  #
  #   InvalidS3ConfigurationException: Could not write to bucket: <bucket>
  #
  # because SES test-writes to the destination before it will accept the rule.
  # The AWS provider treats that as retryable (it usually IS bucket-policy
  # propagation lag), so terraform does not fail — it retries every ~10 seconds
  # indefinitely with no output. Measured on 15 Aug 2026: the apply looked
  # hung, and the real error was only visible in CloudTrail, because the
  # `lookup-events` summary reports ErrorCode as None and the actual code lives
  # in the raw `CloudTrailEvent` JSON.
  #
  # So: adding a prefix here means adding it to that template in the SAME
  # change, or the apply spins forever and tells you nothing.
  s3_action {
    position          = 1
    bucket_name       = local.bucket_names["receipts"]
    object_key_prefix = "dmarc/"
  }

  depends_on = [module.storage]
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
