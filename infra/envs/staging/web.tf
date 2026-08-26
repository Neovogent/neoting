# --------------------------------------------------------------------------
# Web — the SPA leaves Vercel and moves onto AWS (launch stage S3).
#
# WHAT THIS REPLACES. docs/runbooks/vercel-web.md hosts apps/web on Vercel and
# rewrites /v1/* server-side to api.<domain> so the page and the API share an
# origin. That trick is the ONLY reason the app works at all: apps/api never
# calls enableCors (deliberately), and the session cookie is SameSite=Lax, so a
# genuinely cross-origin SPA cannot authenticate. Read that runbook's "the one
# idea this rests on" before changing anything below — this file reproduces the
# same-origin property on CloudFront, and losing it produces a login that
# appears to succeed and then 401s on every subsequent call.
#
# THE SHAPE: one distribution, two origins.
#
#     <web host>/            -> S3, private, Origin Access Control   (the SPA)
#     <web host>/v1/*        -> the SAME ALB origin edge.tf uses     (the API)
#     <web host>/d/*         -> the same ALB origin                  (capability URLs)
#     <web host>/healthz     -> the same ALB origin                  (the smoke probe)
#
# Everything reusable is reused rather than duplicated, which is why this file
# is short despite adding a whole surface: the WAF ACL, the security-headers
# policy, the wildcard certificate, the ALB origin hostname and the origin
# verification header all already exist in edge.tf and alb.tf, and a Terraform
# root module is flat, so they are referenced directly.
#
# COST, added to edge.tf's ~$11.50/mo:
#   S3 storage (a ~2 MB bundle, versioned)        ~$0.00
#   CloudFront traffic                            ~$0.00  1 TB/mo free tier
#   CloudFront Function invocations               ~$0.00  $0.10/million
#   Invalidations                                 $0.00   1000 paths/mo free;
#                                                         a deploy spends ONE
#   WAF                                           $0.00   shared ACL, already paid
#   ------------------------------------------------------------------------
#   TOTAL                                         ~$0.05/mo
#
# The WAF ACL is shared with the api. distribution deliberately — see the
# "ONE SHARED ACL" banner in edge.tf. A second ACL would be $5/mo flat plus
# duplicated managed-rule-group charges to protect a bucket of static files.
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# THE HOSTNAME, AND WHY IT IS NOT neoacc.neovogent.com BY DEFAULT.
#
# docs/launch/PLAN.md's walkthrough says "sign up at neoacc.neovogent.com".
# That name cannot be built by this Terraform, and the reason is DNS, not
# preference. Measured 26 Aug 2026:
#
#   neovogent.com          NS -> peyton.ns.cloudflare.com, ali.ns.cloudflare.com
#   neoting.neovogent.com  NS -> ns-{326,803,1428,2004}.awsdns-*  (Route 53)
#   neoacc.neovogent.com   NXDOMAIN
#
# So `neoacc.` is a name in the CLOUDFLARE zone. This repository has no
# Cloudflare provider and data.aws_route53_zone.primary is the neoting.
# subdomain zone, so Terraform can neither publish the record nor answer the
# ACM validation challenge for it. Worse, the wildcard certificate does NOT
# cover it: `*.neoting.neovogent.com` matches exactly one label under
# neoting.neovogent.com, and neoacc.neovogent.com is not under it at all.
#
# THE FAILURE MODE IF YOU HARDCODE IT ANYWAY: aws_acm_certificate_validation
# blocks until the challenge is answered, so `terraform apply` hangs for its
# full timeout and CI's apply job times out at 45 minutes having changed
# nothing. That is a wedged pipeline, not an error message.
#
# THEREFORE: the default is app.<domain>, which the issued wildcard already
# covers and which Route 53 publishes with no human in the loop.
#
# `neoacc.` IS SUPPORTED, BY DELEGATING IT — the same thing that was already
# done once for neoting.neovogent.com, which is why THAT name is manageable
# here and its parent is not. Cloudflare keeps neovogent.com; a four-record NS
# delegation hands the single label `neoacc` to Route 53, and from that point
# Terraform owns the certificate, its renewal validation and the alias records
# with no human in the loop ever again.
#
# The alternative — leaving the name in Cloudflare and hand-writing a CNAME to
# the distribution plus a CNAME for the ACM challenge — was rejected. Not for
# effort: the two records are five minutes. It is that the validation CNAME
# must survive FOREVER, because ACM re-validates against it at every renewal.
# Delete it as tidying-up and the certificate silently fails to renew about
# thirteen months later, taking the customer-facing hostname down with it, and
# nothing between now and then reports a problem.
#
# TWO-PHASE ON PURPOSE, because a zone cannot be delegated before it exists:
#
#   Phase 1  set web_public_zone_name. Apply. Terraform creates the hosted zone
#            and prints its four nameservers as `web_public_zone_nameservers`.
#            Nothing else changes; the distribution is untouched.
#   Phase 2  put those four NS records in Cloudflare, confirm they resolve,
#            THEN set web_public_zone_delegated = true and apply again.
#
# The second flag is not ceremony. ACM DNS validation blocks until the
# challenge is answered, and the challenge cannot be answered until the
# delegation is live — so a single-phase apply hangs for its full timeout and
# CI's apply job dies at 45 minutes having changed nothing. The flag is what
# keeps that impossible, and it is why the certificate below is gated on it
# rather than on the zone existing.
#
# Full instructions, with the exact Cloudflare fields: docs/runbooks/web-cloudfront.md.
# --------------------------------------------------------------------------
variable "web_public_zone_name" {
  type        = string
  default     = null
  description = "A hostname outside the neoting. zone to serve the app on, e.g. \"neoacc.neovogent.com\". Terraform creates a Route 53 hosted zone for it; you delegate to that zone from the parent (Cloudflare) once. Null builds app.<domain> only."
}

variable "web_public_zone_delegated" {
  type        = bool
  default     = false
  description = "Set true ONLY after the NS records from web_public_zone_nameservers are live in the parent zone. Until then the certificate cannot validate and apply would hang. Ignored when web_public_zone_name is null."

  validation {
    condition     = !var.web_public_zone_delegated || var.web_public_zone_name != null
    error_message = "web_public_zone_delegated is true but web_public_zone_name is null — there is no zone to delegate. Set the zone name, apply, delegate, then set this."
  }
}

locals {
  # The name Terraform fully owns from the first apply: covered by the
  # wildcard, published by the Route 53 records at the foot of this file,
  # reachable the moment apply ends.
  edge_web_host = "app.${local.domain}"

  # Phase gate. The zone exists as soon as it is named; the certificate and the
  # alias wait for the delegation to be live.
  web_public_zone_enabled = var.web_public_zone_name != null
  web_public_host_enabled = local.web_public_zone_enabled && var.web_public_zone_delegated

  # The public name is APPENDED, never substituted. app. keeps working as the
  # fallback when a delegation is mid-propagation — which is exactly when you
  # need a known-good URL to compare against.
  web_aliases = concat(
    [local.edge_web_host],
    local.web_public_host_enabled ? [var.web_public_zone_name] : [],
  )

  # One CloudFront distribution carries one viewer certificate, so adding a
  # name outside the wildcard means REPLACING the certificate rather than
  # adding to it. aws_acm_certificate.web_public therefore carries the wildcard
  # as a SAN — dropping it would strand app.<domain> on a certificate that no
  # longer covers it, and CloudFront rejects an alias its certificate misses.
  #
  # `one(...[*]...)` rather than a `? :` on [0]. Terraform does not promise to
  # short-circuit a conditional, so the untaken branch can still be evaluated —
  # and `web_public[0]` against a count of zero is an "Invalid index" error at
  # plan time, i.e. the default configuration would fail to plan. The splat
  # yields [] when the resource is absent and one() turns that into null, which
  # coalesce then steps over.
  web_certificate_arn = coalesce(
    one(aws_acm_certificate_validation.web_public[*].certificate_arn),
    aws_acm_certificate_validation.cloudfront.certificate_arn,
  )

  web_bucket_name = "nt-${local.env}-web-${local.account_id}"

  # The names aws_acm_certificate.web_public is requested for, mapped to "is
  # this one served by the primary Route 53 zone?". Both keys come from
  # configuration, which is exactly why this — and not the certificate's own
  # domain_validation_options — is what the validation records iterate. See the
  # banner on aws_route53_record.web_public_cert_validation.
  #
  # The list is conditional rather than the map so that the null zone name in
  # the default configuration is never used as a map key.
  web_public_cert_domains = {
    for d in(local.web_public_host_enabled ? [var.web_public_zone_name, "*.${local.domain}"] : []) :
    d => endswith(d, local.domain)
  }

  # The certificate's validation challenges, keyed by domain. Unknown until the
  # certificate exists — so this is read in resource bodies and must never
  # become a for_each.
  web_public_validation = {
    for dvo in try(aws_acm_certificate.web_public[0].domain_validation_options, []) :
    dvo.domain_name => dvo
  }

  # Paths that must reach the API rather than the bucket. Ordered cache
  # behaviours are evaluated in the order given to CloudFront, and all three
  # are disjoint prefixes, so relative order does not matter here — but the
  # SET does, and each entry is load-bearing:
  #
  #   /v1/*     the API itself. Same-origin, so the Lax session cookie is sent.
  #   /d/*      ⚠ THE ONE THAT IS EASY TO MISS. docs/launch/PLAN.md records
  #             that GET /d/{code} — the capability URL that makes a VT export
  #             line reach its source document (D43, stage A8) — is served at
  #             the ORIGIN ROOT, not under /v1, and is excluded from codegen.
  #             Without this behaviour it matches the SPA default, the
  #             CloudFront function rewrites it to /index.html, and every
  #             document link in every exported file silently returns the app
  #             shell with a 200. Step 9 of the launch walkthrough is the
  #             acceptance test for the whole product and it would fail here.
  #   /healthz  what scripts/smoke/staging-golden-path.sh and the Vercel
  #             runbook's first curl probe. Keeping it proves the proxy path
  #             end to end without authenticating.
  web_api_path_patterns = ["/v1/*", "/d/*", "/healthz"]
}

# --------------------------------------------------------------------------
# THE DELEGATED PUBLIC ZONE (phase 1).
#
# Created as soon as web_public_zone_name is set, and deliberately BEFORE
# anything depends on it — its only job in phase 1 is to mint the four
# nameservers that go into Cloudflare. Nothing here reaches the distribution
# until web_public_zone_delegated flips.
#
# ⚠ DO NOT TAINT, RECREATE OR `terraform destroy -target` THIS ZONE once the
# delegation is live. A new hosted zone gets a NEW set of four nameservers, the
# NS records in Cloudflare then point at a zone that no longer exists, and the
# hostname goes NXDOMAIN until someone notices and re-copies them by hand.
# This is the one resource in this file that a human has to touch again.
# --------------------------------------------------------------------------
resource "aws_route53_zone" "web_public" {
  count = local.web_public_zone_enabled ? 1 : 0

  name    = var.web_public_zone_name
  comment = "Delegated from the parent zone so Terraform can own the app hostname and its certificate renewal."

  tags = { Component = "web" }

  # This variable is for names the primary zone does NOT serve. Pointing it at
  # something under neoting.neovogent.com would create a second hosted zone
  # authoritative for a name the existing zone already answers, and DNS would
  # then resolve differently depending on which nameserver was asked — the kind
  # of split-brain that looks like caching for a day before anyone believes it.
  # A variable validation block cannot see local.domain, so the check lives
  # here.
  lifecycle {
    precondition {
      condition     = !endswith(var.web_public_zone_name, local.domain)
      error_message = "web_public_zone_name is inside ${local.domain}, which Route 53 already serves — use the wildcard and an alias record there instead of delegating a second zone."
    }
  }
}

# --------------------------------------------------------------------------
# The certificate for the public name (phase 2).
#
# us-east-1, because CloudFront reads certificates from nowhere else — the same
# constraint edge.tf documents at aws_acm_certificate.cloudfront.
#
# It carries the wildcard as a SAN so ONE certificate covers both aliases; see
# local.web_certificate_arn. Both names are validated by DNS, and both zones
# are in Route 53 by this point, so validation is fully automatic — that is the
# entire payoff of delegating rather than hand-writing CNAMEs.
# --------------------------------------------------------------------------
resource "aws_acm_certificate" "web_public" {
  count    = local.web_public_host_enabled ? 1 : 0
  provider = aws.us_east_1

  domain_name               = var.web_public_zone_name
  subject_alternative_names = ["*.${local.domain}"]
  validation_method         = "DNS"

  # A certificate attached to an in-service distribution cannot be replaced in
  # place without taking the edge down mid-apply.
  lifecycle {
    create_before_destroy = true
  }
}

# Each validation record has to land in the zone that actually serves its name,
# and this certificate spans TWO zones — which is the whole reason for the
# lookup below rather than a single zone_id.
#
# ⚠ allow_overwrite IS REQUIRED, and the reason is in edge.tf's cert_validation
# block: ACM issues ONE validation CNAME per domain name per account, so every
# certificate covering *.neoting.neovogent.com — the ALB's, the CloudFront
# one, and now this one — converges on the SAME record with the SAME value.
# Three resources, one byte-identical record. Without allow_overwrite whichever
# applies second fails the CREATE. Do not "deduplicate" these: each
# certificate's validation waits on the FQDNs its own resource produced.
#
# ⚠ AND THE for_each IS BUILT FROM CONFIG, NOT FROM THE CERTIFICATE. The
# obvious spelling — `for dvo in aws_acm_certificate.….domain_validation_options`
# — is what edge.tf uses, and it fails the plan here with "the for_each map
# includes keys derived from resource attributes that cannot be determined
# until apply". edge.tf gets away with it only because its certificate is
# already in state; on the apply that FIRST creates a certificate,
# domain_validation_options is a SET whose elements are still unknown, so
# Terraform cannot identify the elements and therefore cannot derive the keys.
#
# The two domain names, on the other hand, are written in this file. Iterating
# THEM gives a key set known at plan time, and the unknown validation values
# are then read in the resource BODY, where unknowns are ordinary. Same for the
# zone id of a zone that does not exist yet.
resource "aws_route53_record" "web_public_cert_validation" {
  for_each = local.web_public_cert_domains

  # each.value is "is this name served by the primary zone?" — known at plan
  # time because endswith() is a pure function of two known strings.
  zone_id         = each.value ? data.aws_route53_zone.primary.zone_id : aws_route53_zone.web_public[0].zone_id
  name            = local.web_public_validation[each.key].resource_record_name
  type            = local.web_public_validation[each.key].resource_record_type
  ttl             = 60
  records         = [local.web_public_validation[each.key].resource_record_value]
  allow_overwrite = true
}

# Auto-renewal re-validates against those records ~13 months from now. This is
# the resource that makes deleting them a visible Terraform change rather than
# a silent outage in a year.
resource "aws_acm_certificate_validation" "web_public" {
  count    = local.web_public_host_enabled ? 1 : 0
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.web_public[0].arn
  validation_record_fqdns = [for r in aws_route53_record.web_public_cert_validation : r.fqdn]
}

# --------------------------------------------------------------------------
# The bucket. PRIVATE — runbook §6.5 is explicit that public origins bypassing
# CloudFront also bypass WAF, and a public website-endpoint bucket is exactly
# that. This is a REST-endpoint origin behind Origin Access Control, so the
# only way to the bytes is through the distribution.
#
# Note what that costs us and how it is paid for: an S3 REST endpoint has no
# index-document behaviour and no SPA fallback, so `/app` is a 404 rather than
# index.html. aws_cloudfront_function.web_spa_router below is what supplies it.
# --------------------------------------------------------------------------
resource "aws_s3_bucket" "web" {
  bucket = local.web_bucket_name

  # No force_destroy. This holds build output that is reproducible from git, so
  # the data is not precious — but an accidental `terraform destroy` taking the
  # live front end with it is not a thing to make one flag easier.
  tags = { Component = "web" }
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket = aws_s3_bucket.web.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    object_ownership = "BucketOwnerEnforced" # ACLs off entirely
  }
}

# SSE-S3, not the documents CMK. This bucket holds a public JavaScript bundle
# that is served to anonymous browsers; there is no confidentiality to protect,
# and pointing it at the customer-managed key would add KMS decrypt calls on
# every cache miss for no security gain. Customer data lives in the buckets
# infra/modules/storage manages, and those DO use the CMK.
resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  bucket = aws_s3_bucket.web.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Versioning is the rollback story. A bad deploy is fixed by re-running the
# workflow on the previous commit, but versioning means the previous bytes are
# still there while you work out which commit that was.
resource "aws_s3_bucket_versioning" "web" {
  bucket = aws_s3_bucket.web.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Noncurrent versions of a JS bundle have no value after a week and every
# deploy makes more of them. Without this the bucket grows forever.
resource "aws_s3_bucket_lifecycle_configuration" "web" {
  bucket = aws_s3_bucket.web.id

  # depends_on rather than a reference: S3 rejects a lifecycle configuration
  # mentioning noncurrent versions on a bucket where versioning is not yet on,
  # and Terraform has no data dependency between the two to order them.
  depends_on = [aws_s3_bucket_versioning.web]

  rule {
    id     = "expire-old-bundles"
    status = "Enabled"

    filter {} # the whole bucket

    noncurrent_version_expiration {
      noncurrent_days = 7
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# --------------------------------------------------------------------------
# Origin Access Control — the SigV4 successor to Origin Access Identity.
#
# OAI is legacy and AWS documents OAC as the replacement; the practical
# difference that matters here is that OAC can sign requests to buckets using
# SSE-KMS, which OAI cannot, so choosing OAC now means the encryption decision
# above stays reversible.
# --------------------------------------------------------------------------
resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "nt-${local.env}-web"
  description                       = "SigV4 access from the web distribution to the SPA bucket."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# The bucket policy names ONE distribution by ARN. Without the AWS:SourceArn
# condition the statement reads "any CloudFront distribution in any account may
# read this bucket" — the confused-deputy shape OAC's docs warn about, and a
# stranger's distribution can be pointed at our bucket in five minutes.
data "aws_iam_policy_document" "web_bucket" {
  statement {
    sid     = "AllowCloudFrontRead"
    effect  = "Allow"
    actions = ["s3:GetObject"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    resources = ["${aws_s3_bucket.web.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.web_bucket.json

  # The public access block must exist first, or a brief window exists where
  # the policy is attached to a bucket whose block settings are still default.
  depends_on = [aws_s3_bucket_public_access_block.web]
}

# --------------------------------------------------------------------------
# SPA ROUTING — a CloudFront Function, NOT custom_error_response.
#
# ⚠ READ THIS BEFORE "SIMPLIFYING" IT TO THE USUAL RECIPE. The standard S3+SPA
# pattern maps 403 and 404 to /index.html with a 200. It is wrong for THIS
# distribution, and the way it is wrong is invisible in a browser test:
#
#   custom_error_response is a DISTRIBUTION-level property. CloudFront applies
#   it to every cache behaviour, including the ones pointing at the ALB. So
#   `GET /v1/documents/does-not-exist`, which the API correctly answers 404
#   with a problem+json body, would be rewritten into the HTML app shell with
#   status 200. Every client Zod-parsing that response gets a parse error
#   instead of a not-found, `GET /d/{expired-token}` reports success for a
#   revoked capability URL, and the smoke test passes because / still loads.
#
# A viewer-request function is attached PER BEHAVIOUR, so it touches the SPA
# path and nothing else. It also fixes the routing before the cache lookup,
# which means one cached copy of index.html serves every client-side route
# rather than one error-mapped entry per URL anyone ever visited.
#
# The rule: a final path segment containing a dot is a real file (assets/
# index-a1b2c3.js, favicon.png, manifest.webmanifest); anything else is a
# client-side route from apps/web/src/lib/router.ts and gets the shell. That
# covers "/", "/app", "/clients/1/costs" and "/p/<token>" without listing them,
# which matters because the router is hand-rolled and its route table is not
# available to Terraform.
# --------------------------------------------------------------------------
resource "aws_cloudfront_function" "web_spa_router" {
  name    = "nt-${local.env}-web-spa-router"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrite extensionless paths to /index.html for the hand-rolled SPA router."
  publish = true

  # Deliberately ES5-flavoured. The CloudFront Functions runtime is not Node
  # and not a full modern browser engine; `String.prototype.endsWith` and
  # optional chaining have both been sources of "function failed to publish"
  # in this style of file. indexOf and substring are available everywhere.
  code = <<-JS
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);

      // No dot in the final segment => not a file => a client-side route.
      // "" (a trailing slash, including "/") lands here too, which is correct.
      if (lastSegment.indexOf('.') === -1) {
        request.uri = '/index.html';
      }

      return request;
    }
  JS
}

# --------------------------------------------------------------------------
# Cache policies for the static side.
#
# Managed-CachingOptimized honours the origin's Cache-Control, which is what
# makes the deploy workflow's two-pass upload work: hashed assets are written
# with `immutable`, index.html with `no-cache`, so the edge holds assets for a
# year and revalidates the shell. The invalidation in the workflow is then a
# belt-and-braces measure rather than the only thing making a deploy visible.
# --------------------------------------------------------------------------
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

# --------------------------------------------------------------------------
# The web distribution.
# --------------------------------------------------------------------------
resource "aws_cloudfront_distribution" "web" {
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  comment         = "nt-${local.env} web"
  aliases         = local.web_aliases
  web_acl_id      = aws_wafv2_web_acl.edge.arn
  price_class     = "PriceClass_100"

  # The SPA shell. index.html rather than a redirect: the function above has
  # already rewritten "/" to /index.html by the time S3 is asked, so this is
  # only the belt for a request that somehow arrives without it.
  default_root_object = "index.html"

  # No custom_error_response. See the CloudFront Function banner above — it
  # would corrupt every API error on this distribution.

  # ---- origin 1: the SPA bucket, private, via OAC -------------------------
  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "spa"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id

    # No custom_origin_config: this is an S3 REST origin, and giving it one
    # turns it into a generic HTTP origin that OAC will not sign for.
  }

  # ---- origin 2: the SAME ALB edge.tf fronts ------------------------------
  #
  # Byte-identical to edge.tf's origin block, and it has to be. The ALB's HTTPS
  # listener defaults to a fixed 403 and forwards only when
  # local.origin_header_name carries random_password.alb_origin_verify — so an
  # origin missing that header gets 403 on every API call while the SPA loads
  # perfectly, which reads as an auth bug for as long as you let it.
  #
  # ROTATION applies to BOTH distributions now: add the new value as a second
  # entry in aws_lb_listener_rule.api_origin_verified's `values`, apply, let
  # both distributions propagate, then remove the old one.
  origin {
    domain_name = local.api_origin_host
    origin_id   = "alb"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 60
    }

    custom_header {
      name  = local.origin_header_name
      value = random_password.alb_origin_verify.result
    }
  }

  # ---- default: the SPA ---------------------------------------------------
  default_cache_behavior {
    target_origin_id       = "spa"
    viewer_protocol_policy = "redirect-to-https"

    # Static files. No POST anywhere on this behaviour — an S3 REST origin
    # would reject it anyway, and allowing write methods against a bucket
    # origin is the kind of thing that is only ever a mistake.
    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]
    compress        = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.web_spa_router.arn
    }
  }

  # ---- the API paths ------------------------------------------------------
  #
  # Same policies as edge.tf's default behaviour: caching disabled, because an
  # API that caches by accident serves one workspace's data to another; and
  # AllViewerExceptHostHeader, so cookies, Authorization and the rest reach the
  # origin. This is the same-origin property the whole hosting decision rests
  # on — the browser only ever talks to <web host>, so the session cookie is
  # first-party and no CORS surface has to exist.
  dynamic "ordered_cache_behavior" {
    for_each = local.web_api_path_patterns

    content {
      path_pattern           = ordered_cache_behavior.value
      target_origin_id       = "alb"
      viewer_protocol_policy = "redirect-to-https"

      allowed_methods = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods  = ["GET", "HEAD"]

      # Compression is decided by Managed-CachingDisabled (it is off there), so
      # `true` would be a comforting no-op. The API gzips at the origin and
      # CloudFront passes it through — same reasoning as edge.tf.
      compress = false

      cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
      origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
      response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

      # No function_association. The SPA rewrite must not touch API paths:
      # /v1/documents has no dot in its last segment and would become
      # /index.html.
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = local.web_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = { Component = "web" }
}

# --------------------------------------------------------------------------
# The deploy workflow's two coordinates, published so it does not have to
# guess them.
#
# WHY SSM AND NOT A HARDCODED VALUE IN THE YAML: the bucket name is
# deterministic, but the distribution ID is minted by AWS and changes if the
# distribution is ever replaced. A workflow carrying a stale ID does not fail —
# it invalidates a distribution that no longer serves anyone and reports
# success, so the deploy looks green and the site does not change. Reading it
# at deploy time makes that impossible.
#
# Standard-tier parameters are free and neither value is a secret; both are
# readable from the CloudFront and S3 APIs by anyone holding the deploy role.
# --------------------------------------------------------------------------
resource "aws_ssm_parameter" "web_bucket" {
  name        = "/neoting/${local.env}/web/bucket"
  type        = "String"
  value       = aws_s3_bucket.web.id
  description = "SPA origin bucket for the web distribution. Read by .github/workflows/deploy-web.yml."
  tags        = { Component = "web" }
}

resource "aws_ssm_parameter" "web_distribution_id" {
  name        = "/neoting/${local.env}/web/distribution-id"
  type        = "String"
  value       = aws_cloudfront_distribution.web.id
  description = "Web CloudFront distribution. Read by .github/workflows/deploy-web.yml to invalidate after a sync."
  tags        = { Component = "web" }
}

# --------------------------------------------------------------------------
# DNS.
#
# A and AAAA for every name, for the reason edge.tf gives: is_ipv6_enabled is
# on and a client on an IPv6-only UK mobile network cannot resolve an A-only
# name. The portal's whole job is to work on a phone.
#
# The public name's records are ALIAS records at the apex of its own delegated
# zone — which is only possible because it is a Route 53 zone. A CNAME cannot
# live at a zone apex, so had the name stayed in Cloudflare this would have had
# to be Cloudflare's CNAME-flattening instead. Another quiet argument for
# delegating.
# --------------------------------------------------------------------------
resource "aws_route53_record" "web" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = local.edge_web_host
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "web_v6" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = local.edge_web_host
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "web_public" {
  count = local.web_public_host_enabled ? 1 : 0

  zone_id = aws_route53_zone.web_public[0].zone_id
  name    = var.web_public_zone_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "web_public_v6" {
  count = local.web_public_host_enabled ? 1 : 0

  zone_id = aws_route53_zone.web_public[0].zone_id
  name    = var.web_public_zone_name
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}

output "web_bucket" {
  value       = aws_s3_bucket.web.id
  description = "Private S3 origin holding the built SPA."
}

output "web_distribution_id" {
  value       = aws_cloudfront_distribution.web.id
  description = "Web distribution. Invalidate this after syncing the bucket."
}

output "web_distribution_domain_name" {
  value       = aws_cloudfront_distribution.web.domain_name
  description = "CloudFront hostname. Point a CNAME here for any host outside the Route 53 zone."
}

output "web_url" {
  value       = "https://${local.edge_web_host}"
  description = "The terraform-managed public URL for the app."
}

# THE PHASE-1 HANDOFF. These four values are what go into Cloudflare as NS
# records on the `neoacc` label. Empty until web_public_zone_name is set.
#
# Read them with:  terraform output -json web_public_zone_nameservers
output "web_public_zone_nameservers" {
  # try() for the same reason local.web_certificate_arn uses one(): a bare [0]
  # against a count of zero is a plan-time error, not an empty result.
  value       = try(aws_route53_zone.web_public[0].name_servers, [])
  description = "Copy these into the PARENT zone as NS records for the delegated label, then set web_public_zone_delegated = true."
}

output "web_public_url" {
  value       = local.web_public_host_enabled ? "https://${var.web_public_zone_name}" : null
  description = "The delegated public URL, once the NS delegation is live and the flag is set."
}
