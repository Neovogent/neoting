# --------------------------------------------------------------------------
# SES — outbound identity and inbound intake for doc@ (Kickoff 2.3, 2.4, 3.5)
#
# Verification 8.2 RESOLVED 13 Aug 2026: inbound receiving IS available in
# eu-west-2, so the eu-west-1 fallback named in D30 is not needed. Every hop
# of the email path stays in London.
#
# Production access (sandbox exit) is a support-ticket flow, not Terraform —
# requested 13 Aug, status PENDING. Inbound receiving works regardless; the
# sandbox only restricts outbound.
# --------------------------------------------------------------------------

data "aws_route53_zone" "primary" {
  name         = "${local.domain}."
  private_zone = false
}

resource "aws_sesv2_email_identity" "primary" {
  email_identity = local.domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
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
