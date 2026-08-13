# --------------------------------------------------------------------------
# Edge — CloudFront + WAF (runbook §6.5, D23; Slice B "CloudFront + basic WAF")
#
# WHY THIS EXISTS AT ALL: runbook §6.5 — "public origins that bypass CloudFront
# also bypass WAF". An ALB on the open internet is an unfiltered front door.
# This file is that filter, plus TLS termination at the edge and the security
# headers Governance §11.9 requires on every response.
#
# COST (Appendix B budgets $10–15/mo for "CloudFront + one shared WAF web ACL"):
#   WAF web ACL                     $5.00/mo   flat, per ACL
#   WAF rules                       $6.00/mo   6 billable rules @ $1 (a managed
#                                              rule GROUP bills as one rule)
#   WAF requests                    ~$0.00     $0.60/million; staging is noise
#   CloudFront traffic              ~$0.00     the 1 TB/mo free tier absorbs
#                                              all of staging
#   WAF logs (CloudWatch, BLOCK/COUNT only)  ~$0.50/mo  see the logging note
#   ACM certificate                 $0.00      public certs are free
#   ------------------------------------------------------------------------
#   TOTAL                           ~$11.50/mo — inside the budgeted band.
#
# Every rule added here costs $1/month forever. That is why the count below is
# six and not sixteen, and why SQLi/AnonymousIp are named as Slice C.
#
# D30 / REGION: CloudFront and WAFv2 CLOUDFRONT-scope are GLOBAL services whose
# control plane lives in us-east-1 — they cannot be created in eu-west-2 and no
# alternative exists. policies/region-guardrail.json already encodes this: the
# `DenyOutsideApprovedRegions` NotAction list carries `cloudfront:*`, `waf:*`
# and `wafv2:*`, and `us-east-1` is in the permitted `aws:RequestedRegion` set,
# while `NoDataServicesInUsEast1` keeps every data service (RDS, ECS, S3
# bucket creation, Bedrock, Textract, SES…) out of it. So: no customer data is
# processed or stored in us-east-1. This is the documented exemption, not a
# breach of it.
# --------------------------------------------------------------------------

locals {
  # The public name. alb.tf deliberately does NOT claim it ("runbook §6.5 gives
  # api. to a CloudFront distribution, and a hostname cannot alias both"), so
  # the alias record at the foot of this file is the one that owns it.
  #
  # The ORIGIN hostname is local.api_origin_host from alb.tf — not redefined
  # here. It exists because CloudFront validates that the origin's certificate
  # matches the origin domain name, and an ALB's own *.elb.amazonaws.com name
  # never matches our ACM wildcard; without a real hostname the only options
  # are a broken origin handshake or plaintext to the origin, and Governance
  # §11.9 rules the second one out.
  edge_api_host = "api.${local.domain}"

  # Rate ceilings, per IP. These are DoS walls, not the Governance §11.8
  # business limits — see the WAF section for why the two are different numbers.
  edge_rate_otp_per_ip_10m   = 30
  edge_rate_portal_per_ip_5m = 100
  edge_rate_api_per_ip_5m    = 5000
}

# --------------------------------------------------------------------------
# The one aliased provider. Nothing else in this repository may use it.
# --------------------------------------------------------------------------
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  # Same shared-account guardrail as the default provider in main.tf. The
  # account is shared with unrelated products; an aliased provider that skips
  # this check is a hole in exactly the place nobody looks.
  allowed_account_ids = [local.account_id]
}

# --------------------------------------------------------------------------
# ACM in us-east-1 (runbook §5.2).
#
# A SECOND certificate for the same wildcard is not duplication — it is the
# rule. CloudFront reads certificates only from us-east-1; the ALB's listener
# reads them only from eu-west-2 (alb.tf). One certificate cannot serve both,
# and no amount of wanting changes it.
#
# Wildcard rather than three SANs, matching alb.tf: adding `portal.` or `app.`
# at Infra Week then needs no certificate change and no revalidation window.
# The apex is deliberately absent for the same reason it is absent there —
# nothing terminates TLS on the apex, and it carries the SES inbound MX.
# --------------------------------------------------------------------------
resource "aws_acm_certificate" "cloudfront" {
  provider = aws.us_east_1

  domain_name       = "*.${local.domain}"
  validation_method = "DNS"

  # A certificate referenced by an in-service distribution cannot be replaced
  # in place without taking the edge down mid-apply.
  lifecycle {
    create_before_destroy = true
  }
}

# Route 53 is a global service, so these use the default provider deliberately.
#
# ⚠ THIS RECORD IS ALSO WRITTEN BY alb.tf (aws_route53_record.alb_cert_validation).
# ACM issues one validation CNAME per domain name per account, so both
# certificates for `*.neoting.neovogent.com` are validated by the SAME record,
# with the same name and the same value. Two Terraform resources therefore
# converge on one byte-identical record: harmless, but only because BOTH sides
# set allow_overwrite — without it, whichever applies second fails the CREATE.
# Do not remove allow_overwrite from either file, and do not "deduplicate" this
# by deleting one: each certificate's aws_acm_certificate_validation waits on
# the FQDNs its own resource produced.
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cloudfront.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id         = data.aws_route53_zone.primary.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
  allow_overwrite = true
}

# Auto-renewal re-validates against these records. Deleting them silently
# breaks renewal ~13 months later, which is the worst possible time to find out.
resource "aws_acm_certificate_validation" "cloudfront" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.cloudfront.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# --------------------------------------------------------------------------
# NOTE ON THE ORIGIN SECRET — it is NOT created here.
#
# alb.tf owns it: random_password.alb_origin_verify, published to Secrets
# Manager at /neoting/staging/edge/alb-origin-header, with the header name in
# local.origin_header_name. The distribution below reads both directly — same
# root module, same apply, so the value never has to be copied anywhere and no
# human ever sees it.
#
# That listener rule is the second of the two locks runbook §6.5 asks for, and
# it is the one that matters most: the CloudFront origin-facing prefix list
# (which network.tf's ALB ingress rule now uses) contains EVERY CloudFront
# distribution in the world, including one an attacker can create in five
# minutes pointed at our origin. The prefix list stops direct dialling; only
# the header stops a stranger's distribution walking past our WAF.
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# Security headers (Governance §11.9, runbook §6.5).
#
# CSP IS DELIBERATELY ABSENT. Governance §11.9 requires a nonce-based CSP with
# no `unsafe-inline`. A CloudFront response-headers policy is static — it emits
# the same bytes on every response and therefore cannot carry a per-response
# nonce. Only the application can. Setting a CSP here would also override the
# app's with `override = true`, replacing a correct policy with a weaker one.
# The portal ships the tightest CSP in the product; that lives in the portal.
#
# CORS is absent for the same reason: the allowed origin list is
# environment-dependent and credential-bearing, so the app owns it.
# --------------------------------------------------------------------------
resource "aws_cloudfront_response_headers_policy" "security" {
  name    = "nt-${local.env}-security-headers"
  comment = "Governance §11.9 baseline. CSP is emitted by the app (nonce-based)."

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000 # 1 year
      include_subdomains         = true

      # preload = false ON PURPOSE. Preloading is a months-long, effectively
      # irreversible commitment baked into browser binaries, and D5 moves this
      # product off neoting.neovogent.com onto neoting.com at cutover. Preload
      # the domain we keep, once, from prod — never from staging.
      preload  = false
      override = true
    }

    content_type_options {
      override = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    # Chase links are deliberately forwardable (SoT Stage 8.3) and get opened on
    # phones by people who are not our users. Nothing in this product is ever
    # legitimately framed, so clickjacking has no cost to deny.
    frame_options {
      frame_option = "DENY"
      override     = true
    }
  }

  custom_headers_config {
    # Restrictive, but NOT blanket-deny — read the three `self` entries before
    # tightening this, because two product features die without them:
    #   camera=(self)     the OTP portal captures receipts with the phone
    #                     camera (SoT §4 Stage 1, §14)
    #   microphone=(self) voice chat via Transcribe streaming (compute.tf grants
    #                     transcribe:StartStreamTranscription for exactly this)
    #   fullscreen=(self) full-page document viewing
    # `camera=()` here is a one-word change that breaks receipt capture on every
    # phone in the pilot and produces no error anyone can read.
    items {
      header   = "Permissions-Policy"
      override = true
      value    = "accelerometer=(), autoplay=(), browsing-topics=(), camera=(self), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), interest-cohort=(), magnetometer=(), microphone=(self), midi=(), payment=(), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()"
    }
  }

  # Free reconnaissance we do not need to hand out. Stripped at the edge so no
  # framework config has to remember to do it.
  remove_headers_config {
    items { header = "Server" }
    items { header = "X-Powered-By" }
  }
}

# --------------------------------------------------------------------------
# Cache policies.
#
# Managed policies are used where one fits: they are free, versioned by AWS,
# and every engineer already knows what they do.
# --------------------------------------------------------------------------
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# Reference data only: VAT rates, category taxonomies, chart-of-accounts
# templates — things identical for every tenant (runbook §6.5 "cache reference
# data by policy").
#
# ⚠ THE RULE FOR THIS PREFIX: only tenant-INDEPENDENT responses may ever be
# mounted under /v1/reference/*. A cached tenant-scoped response is a
# cross-tenant leak served from the CDN — the one failure mode that defeats
# scopedDb, RLS and every other tenancy control at once, because it never
# reaches the database.
#
# Two structural defences, not one comment:
#   1. min_ttl = 0, so an origin answering `Cache-Control: no-store` is obeyed
#      and CloudFront caches nothing.
#   2. The behaviour below attaches NO origin request policy, so the origin
#      receives no Authorization header and no cookies. A tenant-scoped route
#      mis-mounted here answers 401 rather than serving one firm's data to
#      another. It fails closed.
#
# No /v1/reference/* endpoint exists in packages/contracts/openapi.yaml yet.
# This reserves the namespace with the guardrails already on.
resource "aws_cloudfront_cache_policy" "reference" {
  name        = "nt-${local.env}-reference"
  comment     = "Tenant-independent reference data only. Auth is not in the cache key."
  min_ttl     = 0
  default_ttl = 300
  max_ttl     = 3600

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "all" }
  }
}

# --------------------------------------------------------------------------
# WAF — CLOUDFRONT scope, therefore us-east-1 (runbook §6.5, D23).
#
# ONE SHARED ACL, AND THE DOCUMENTS DISAGREE ABOUT THIS. Runbook §6.5 says
# "one web ACL per distribution, not one shared". Appendix B budgets
# "CloudFront + one shared WAF web ACL" at $10–15/mo. Three ACLs is
# 3 × $5 flat plus triplicated managed-rule-group charges — roughly $33/mo
# against a $170/mo staging envelope, ~20% of it, to protect one distribution
# that exists and two that do not.
#
# Staging takes the shared ACL. PROD MUST REVISIT: per-distribution ACLs are
# the right answer once the portal is a real surface, because the portal's
# ruleset is meant to be materially tighter than the workspace's and a shared
# ACL forces every tightening to be expressed as a path scope-down instead of
# a default. The scope-downs below are that compromise, made visible.
#
# Capacity: CommonRuleSet 700 + KnownBadInputs 200 + IpReputation 25 + the rate
# rules ≈ 940 WCU against the 1500 default ceiling. Adding SQLiRuleSet (200) in
# Slice C still fits; a fourth large group would need a quota increase.
# --------------------------------------------------------------------------
resource "aws_wafv2_web_acl" "edge" {
  provider = aws.us_east_1

  name        = "nt-${local.env}-edge"
  description = "Neoting ${local.env} shared edge ACL (runbook §6.5 basic ruleset)"
  scope       = "CLOUDFRONT"

  # Allow by default and block what we recognise. A default-deny edge in front
  # of a public API means every new endpoint ships broken.
  default_action {
    allow {}
  }

  # Governance §11.8 says rate limiting returns 429 + Retry-After. WAF's block
  # action returns 403 with an HTML body by default, which is neither. This is
  # deliberately NOT one of the NT- codes in packages/contracts: an edge block
  # never reached the API, carries no trace id, and must not impersonate an
  # application error the support team could look up.
  custom_response_body {
    key          = "rate-limited"
    content_type = "APPLICATION_JSON" # WAF offers no application/problem+json
    content = jsonencode({
      type   = "https://neoting.com/problems/rate-limited"
      title  = "Too many requests"
      status = 429
      detail = "Blocked at the edge before reaching the API. Wait and retry."
    })
  }

  # ---- managed rule groups ------------------------------------------------
  # Cheapest first: an IP already known bad is dropped before we spend WCU
  # inspecting its body.
  rule {
    name     = "amazon-ip-reputation"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "nt-${local.env}-ip-reputation"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "common-rule-set"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"

        # SizeRestrictions_BODY blocks request bodies over 8 KB. Two facts make
        # it a pure false-positive generator here: document bytes never touch
        # the API at all (packages/contracts/openapi.yaml — /document-uploads
        # returns a presigned URL and the client PUTs straight to S3), while
        # chat turns and extraction-correction payloads legitimately exceed
        # 8 KB. Counting keeps the signal without the outage. A real body cap
        # at a sane size is a Slice C rule.
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }

        # OCR text off a scanned invoice, supplier names and free-text chat all
        # contain character sequences this rule reads as XSS. The actual defence
        # against XSS is output encoding plus the nonce-based CSP of Governance
        # §11.9 — a body regex at the CDN was never it.
        rule_action_override {
          name = "CrossSiteScripting_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "nt-${local.env}-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "known-bad-inputs"
    priority = 30

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "nt-${local.env}-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  # Slice C adds AWSManagedRulesSQLiRuleSet and AWSManagedRulesAnonymousIpList
  # (+$2/mo). AnonymousIpList goes in COUNT first without exception — runbook
  # §6.5: accountants sit behind corporate proxies and VPNs, and blocking a
  # whole practice on day one of a pilot is not a security win.

  # ---- rate limits --------------------------------------------------------
  # WHAT WAF CAN AND CANNOT ENFORCE. Governance §11.8 sets:
  #     OTP request   3 per NUMBER / 10 min  AND  10 per IP / hour
  #     OTP verify    5 attempts per SESSION
  #     Standard API  100/min per USER
  # WAF aggregates on the IP it can see. It cannot see a phone number, a
  # session or a user, so the per-number, per-session and per-user limits are
  # NOT implemented here and CANNOT be — they are application enforcement,
  # sliding-window, config-driven, returning 429 + Retry-After (§11.8).
  #
  # WAF's job is therefore the outer wall: stop a bot farm burning SMS credit
  # or brute-forcing 6-digit codes at machine speed, without ever becoming the
  # business rule. That is why the numbers below are LOOSER than §11.8 — an
  # edge wall tighter than the app's own limit turns every legitimate 429 into
  # an unexplained 403 with no trace id, and the app rule stops being reachable
  # (and therefore stops being testable).
  #
  # WAF's maximum evaluation window is 600s, so "10 per IP per hour" is not
  # expressible here either. Another reason the hour-scale rule lives in the app.

  # Tightest first: an OTP-path request is counted here before the looser
  # portal and API walls see it.
  rule {
    name     = "otp-rate-limit"
    priority = 40

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = "rate-limited"

          response_header {
            name  = "Retry-After"
            value = "600"
          }
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = local.edge_rate_otp_per_ip_10m
        evaluation_window_sec = 600
        aggregate_key_type    = "IP"

        # ⚠ No OTP path exists in packages/contracts/openapi.yaml yet — the
        # portal contract has not landed. These prefixes are the runbook's
        # (/portal/*) plus the API's declared base path (/v1, from the
        # openapi.yaml `servers` block). RECONCILE THIS when the portal
        # endpoints are contracted. A mismatch fails OPEN — traffic falls
        # through to the looser portal and API walls rather than being blocked
        # — which is survivable precisely because the real §11.8 limits are
        # enforced in the application, not here.
        scope_down_statement {
          or_statement {
            statement {
              byte_match_statement {
                search_string         = "/portal/otp"
                positional_constraint = "STARTS_WITH"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "URL_DECODE"
                }
                text_transformation {
                  priority = 1
                  type     = "LOWERCASE"
                }
              }
            }

            statement {
              byte_match_statement {
                search_string         = "/v1/portal/otp"
                positional_constraint = "STARTS_WITH"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "URL_DECODE"
                }
                text_transformation {
                  priority = 1
                  type     = "LOWERCASE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "nt-${local.env}-otp-rate"
      sampled_requests_enabled   = true
    }
  }

  # Runbook §6.5, verbatim: ~100 req / 5 min per IP on /portal/*.
  #
  # Note what is NOT here: the runbook also asks for "block non-GET/POST" on the
  # portal. The portal edits extractions in place (SoT §4 — "every extracted
  # number in the secure-link portal is clickable and instantly correctable"),
  # which is a PATCH. A method allowlist of GET/POST breaks the portal's headline
  # feature, so it is deliberately omitted rather than shipped and reverted.
  rule {
    name     = "portal-rate-limit"
    priority = 50

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = "rate-limited"

          response_header {
            name  = "Retry-After"
            value = "300"
          }
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = local.edge_rate_portal_per_ip_5m
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        scope_down_statement {
          or_statement {
            statement {
              byte_match_statement {
                search_string         = "/portal/"
                positional_constraint = "STARTS_WITH"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "URL_DECODE"
                }
                text_transformation {
                  priority = 1
                  type     = "LOWERCASE"
                }
              }
            }

            statement {
              byte_match_statement {
                search_string         = "/v1/portal/"
                positional_constraint = "STARTS_WITH"

                field_to_match {
                  uri_path {}
                }

                text_transformation {
                  priority = 0
                  type     = "URL_DECODE"
                }
                text_transformation {
                  priority = 1
                  type     = "LOWERCASE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "nt-${local.env}-portal-rate"
      sampled_requests_enabled   = true
    }
  }

  # Whole-distribution ceiling. Sized for a practice behind one office NAT:
  # 5000/5 min ≈ 1000 req/min ≈ ten accountants at the §11.8 per-user 100/min
  # sharing one public IP. Deliberately generous — the per-user limit is the
  # app's job; this exists so a single host cannot turn Bedrock and Textract
  # meters into a bill (Appendix B.4).
  rule {
    name     = "api-rate-limit"
    priority = 60

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = "rate-limited"

          response_header {
            name  = "Retry-After"
            value = "300"
          }
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = local.edge_rate_api_per_ip_5m
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "nt-${local.env}-api-rate"
      sampled_requests_enabled   = true
    }
  }

  # NOT geo-blocked, and this is a product decision, not an oversight. Chase
  # links are deliberately forwardable (SoT Stage 8.3) — a client on holiday
  # opens one abroad and must be able to upload. Runbook §6.5 says the same.

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "nt-${local.env}-edge"
    sampled_requests_enabled   = true
  }
}

# --------------------------------------------------------------------------
# WAF logging.
#
# A WAF without logs is a wall you cannot tune: the count-mode overrides above
# are only defensible if somebody can read what they would have blocked.
#
# CloudWatch Logs, not the Firehose → S3 → Athena path of runbook §6.5, because
# that path costs a Firehose stream plus a logs bucket that does not exist yet
# (runbook §6.3 lists nt-<env>-logs-<acct>; it is not in local.buckets). Slice C
# builds it. Both the log group and any Firehose MUST live in us-east-1 for a
# CLOUDFRONT-scope ACL — the destination is not free to move.
#
# ⚠ PROD/D30: WAF log records carry request URIs and client IPs. Keeping them in
# us-east-1 is a residency question that needs an ADR before prod carries real
# data. It is a non-question today only because staging is synthetic-only (G2).
# No CMK on the group either — the documents CMK (module.storage) is
# eu-west-2 and KMS keys are
# regional, so this is AWS-managed encryption. Same ADR.
# --------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "waf" {
  provider = aws.us_east_1

  # The `aws-waf-logs-` prefix is mandatory — WAFv2 rejects any other log group
  # name outright.
  name              = "aws-waf-logs-nt-${local.env}-edge"
  retention_in_days = 30 # Governance §12.2: application logs / traces

  tags = { Component = "edge" }
}

# WAF calls CloudWatch Logs through the log-delivery service principal, and the
# grant lives on the LOG GROUP, not on any role we own. The AWS console writes
# this policy silently when you enable logging there; Terraform does not, and
# the symptom is an AccessDeniedException from PutLoggingConfiguration on the
# first apply with nothing in it naming the log group.
#
# Both confused-deputy conditions are present deliberately: this is a shared
# account, and a bare delivery.logs.amazonaws.com grant lets any other product
# in it nominate our log group as their delivery destination.
resource "aws_cloudwatch_log_resource_policy" "waf" {
  provider = aws.us_east_1

  policy_name = "nt-${local.env}-waf-logs"

  policy_document = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "delivery.logs.amazonaws.com" }
      Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]

      # Resource policies grant on the streams inside the group, hence ":*".
      Resource = "${aws_cloudwatch_log_group.waf.arn}:*"

      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnLike      = { "aws:SourceArn" = aws_wafv2_web_acl.edge.arn }
      }
    }]
  })
}

resource "aws_wafv2_web_acl_logging_configuration" "edge" {
  provider = aws.us_east_1

  # Without the grant above this call fails, and it fails intermittently
  # enough to look like an AWS problem rather than a missing policy.
  depends_on = [aws_cloudwatch_log_resource_policy.waf]


  resource_arn            = aws_wafv2_web_acl.edge.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  # Bearer tokens and session cookies must never be written to a log, least of
  # all one outside eu-west-2.
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }

  redacted_fields {
    single_header {
      name = "cookie"
    }
  }

  # THE COST CONTROL. Logging every ALLOW writes a record for every request the
  # product serves and is how a $5 web ACL grows a $50 logging bill. We keep
  # only what carries information: blocks, and the count-mode rules we are
  # actively evaluating.
  logging_filter {
    default_behavior = "DROP"

    filter {
      behavior    = "KEEP"
      requirement = "MEETS_ANY"

      condition {
        action_condition {
          action = "BLOCK"
        }
      }

      condition {
        action_condition {
          action = "COUNT"
        }
      }
    }
  }
}

# --------------------------------------------------------------------------
# The api. distribution.
#
# CloudFront's API is global, so the distribution itself uses the DEFAULT
# provider — only the ACM certificate and the CLOUDFRONT-scope ACL are pinned
# to us-east-1, because only those two are region-bound resources.
# --------------------------------------------------------------------------
resource "aws_cloudfront_distribution" "api" {
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  comment         = "nt-${local.env} api"
  aliases         = [local.edge_api_host]
  web_acl_id      = aws_wafv2_web_acl.edge.arn

  # NA + EU edges only. UK and EU users get the nearest edge; a forwarded chase
  # link opened outside that footprint still works, just via a further-away
  # edge. This is a price class, NOT a geo restriction (see the WAF note above)
  # — nothing is refused.
  price_class = "PriceClass_100"

  # No access logging: standard CloudFront logs need the nt-<env>-logs-<acct>
  # bucket that Slice C creates. The WAF log above carries the security signal
  # until then, and the ALB keeps the request-level record.

  # wait_for_deployment is left at its default (true) on purpose. It costs
  # 5–15 minutes of apply time, and it is what stops CI's post-deploy smoke
  # test from hitting a distribution that is not live yet and reporting a
  # phantom failure.

  origin {
    domain_name = local.api_origin_host # alb.tf; the A-alias lives there too
    origin_id   = "alb"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only" # Governance §11.9: TLS on every hop
      origin_ssl_protocols   = ["TLSv1.2"]

      # 60s is CloudFront's default ceiling without a service-quota increase.
      # Streaming chat responses must emit their first byte inside it.
      origin_read_timeout = 60
    }

    # The header aws_lb_listener_rule.api_origin_verified matches on. Both
    # sides read the same two symbols, so they cannot drift; anything that
    # arrives at the origin without this gets the listener's default 403.
    #
    # ROTATION (per alb.tf): add the new value as a SECOND entry in the
    # listener rule's `values` list, apply, let CloudFront propagate onto the
    # new header, then remove the old value. Swapping in place 403s every
    # request for the length of the propagation.
    custom_header {
      name  = local.origin_header_name
      value = random_password.alb_origin_verify.result
    }
  }

  # Everything is uncached by default. An API that caches by accident returns
  # one workspace's data to another, so the default must be the safe one and
  # caching must be opted into per path (see the reference behaviour below).
  default_cache_behavior {
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods  = ["GET", "HEAD"]

    # compress = false is not an omission. When a cache policy is attached, the
    # POLICY decides compression, and Managed-CachingDisabled has it off — so
    # `true` here would be a comforting no-op. The API gzips at the origin,
    # Accept-Encoding is forwarded, and CloudFront passes it through untouched.
    compress = false

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # ⚠ AllViewerExceptHostHeader replaces the Host header with the ORIGIN
  # hostname (origin-api.…), not the viewer's (api.…). alb.tf's listener rule
  # matches on the origin header alone, which is compatible — but the moment
  # anyone adds a `host_header` condition to that rule for app./portal. routing
  # at Infra Week, this behaviour 404s every request arriving via CloudFront
  # while direct-to-ALB requests keep working. That is the most misleading
  # failure shape available. If host-based routing is needed, switch this to
  # Managed-AllViewer and give the ALB a certificate that matches api. too, or
  # forward the viewer host explicitly.
  #
  # It also means the app cannot build absolute URLs from the Host header —
  # signed portal links must come from configuration, not from the request.

  ordered_cache_behavior {
    path_pattern           = "/v1/reference/*"
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]
    compress        = true

    cache_policy_id            = aws_cloudfront_cache_policy.reference.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    # No origin_request_policy_id, deliberately. See aws_cloudfront_cache_policy
    # .reference above: withholding Authorization and cookies from the origin is
    # what makes a mis-mounted tenant route fail closed instead of leaking.
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn = aws_acm_certificate_validation.cloudfront.certificate_arn

    # sni-only is free; the legacy dedicated-IP option is ~$600/month per
    # distribution. Every client we care about has supported SNI for a decade.
    ssl_support_method = "sni-only"

    # The strictest policy CloudFront offers, and it negotiates TLS 1.3 with any
    # client that supports it. Governance §11.9 asks for TLS 1.3; CloudFront has
    # no 1.3-only option, so 1.2 remains the floor. Note the gap, do not pretend.
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = { Component = "edge" }
}

# --------------------------------------------------------------------------
# app. AND portal. ARE DELIBERATELY NOT BUILT YET.
#
# Runbook §6.5 wants three distributions. Two of them have no origin in this
# account: apps/web — which serves BOTH the workspace and the OTP portal — runs
# on Vercel with Deployment Protection for the whole sprint (G6/G10/R16, runbook
# Appendix C: "does not host apps/web on AWS during the sprint"). ECS `web`
# lands at Infra Week.
#
# The alternative was pointing app. and portal. at this same ALB. Rejected: the
# ALB's only target group is the api service, so both names would answer 404 on
# every path — alb.tf's listener rule matches on the origin header alone, so a
# request for portal.<domain> forwards to the api target group just the same and
# comes back 404. A 404 served with a valid certificate through a WAF is worse
# than no distribution at all: it looks deployed. It would also claim two CNAMEs
# in CloudFront's global namespace that the real distributions then have to
# fight for at cutover.
#
# The protection is not actually lost in the meantime. The portal's HTML is
# static and lives on Vercel, but every request that MATTERS — OTP request, OTP
# verify, upload intent, extraction correction — is an API call to api., and
# api. is behind this distribution and this ACL. The rate rules above already
# cover them, which is why they are scoped by path rather than by distribution.
#
# TO ADD THEM at Infra Week: the wildcard certificate already covers both names,
# the response-headers policy and the shared ACL are reusable as-is, and prod
# should split the ACL per distribution at the same time (see the WAF banner).
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# DNS — api. is the public name and it points HERE, not at the ALB.
#
# This is the record that makes runbook §6.7 true ("a reachable, TLS-terminated,
# WAF-fronted staging stack"). Repoint it at the ALB and every control in this
# file leaves the request path at once — no WAF, no rate limits, no security
# headers — while the stack keeps answering 200 and looking healthy. There is
# no alarm for that. There is only this comment.
#
# alb.tf keeps origin-api. and explicitly does not claim api., so nothing
# competes for this name.
# --------------------------------------------------------------------------
resource "aws_route53_record" "api" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = local.edge_api_host
  type    = "A"

  alias {
    name    = aws_cloudfront_distribution.api.domain_name
    zone_id = aws_cloudfront_distribution.api.hosted_zone_id

    # CloudFront exposes no health for Route 53 to evaluate; setting this true
    # against a distribution is a documented no-op at best.
    evaluate_target_health = false
  }
}

# AAAA as well as A: is_ipv6_enabled is on, and a client on an IPv6-only mobile
# network (increasingly normal in the UK) cannot resolve an A-only name. The
# OTP portal's whole job is to work on a phone in a car park.
resource "aws_route53_record" "api_v6" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = local.edge_api_host
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.api.domain_name
    zone_id                = aws_cloudfront_distribution.api.hosted_zone_id
    evaluate_target_health = false
  }
}

# --------------------------------------------------------------------------
# INTEGRATION — what this file depends on, and the one thing it cannot finish.
#
# ALREADY SATISFIED by alb.tf and network.tf as of this writing — re-check if
# either is refactored, because each one silently removes a control:
#
#   ✓ aws_lb_listener.https defaults to a fixed-response 403, and
#     aws_lb_listener_rule.api_origin_verified forwards only when
#     local.origin_header_name matches random_password.alb_origin_verify. That
#     is what makes the custom_header above load-bearing rather than decorative.
#   ✓ network.tf's alb_https ingress is the CloudFront origin-facing prefix
#     list, not 0.0.0.0/0.
#   ✓ aws_route53_record.api_origin publishes origin-api. as an ALB alias, and
#     aws_acm_certificate.alb covers it — which is what lets this distribution
#     speak https-only to the origin.
#
# STILL OUTSTANDING, and it belongs to the observability lane:
#
#   ALARM ON BLOCKED-REQUEST SPIKES (runbook §6.5). WAF publishes to CloudWatch
#   IN US-EAST-1 — namespace AWS/WAFV2, metric BlockedRequests, dimensions
#   WebACL=nt-${local.env}-edge, Rule=<rule name>, Region=Global. An alarm
#   built in eu-west-2 against these will sit in INSUFFICIENT_DATA forever and
#   look like silence rather than a misconfiguration. Either build it with
#   provider = aws.us_east_1 or use a cross-region metric-stream/dashboard.
#   Worth alarming on separately: otp-rate-limit blocks (credential stuffing
#   against a 6-digit code, and every one costs an SMS) and a sudden drop in
#   ALLOW volume (which is what a DNS repoint away from CloudFront looks like).
# --------------------------------------------------------------------------

output "cloudfront_api_domain_name" {
  value = aws_cloudfront_distribution.api.domain_name
  # Terraform evaluates output descriptions statically, so no interpolation here.
  description = "Distribution hostname serving the api. subdomain."
}

output "cloudfront_api_hosted_zone_id" {
  value = aws_cloudfront_distribution.api.hosted_zone_id
}

output "waf_web_acl_arn" {
  value       = aws_wafv2_web_acl.edge.arn
  description = "Shared CLOUDFRONT-scope ACL. Reuse for app./portal. at Infra Week; split per distribution in prod."
}

output "acm_cloudfront_certificate_arn" {
  value = aws_acm_certificate_validation.cloudfront.certificate_arn
}
