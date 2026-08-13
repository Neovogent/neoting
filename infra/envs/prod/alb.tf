# ==========================================================================
# The serving path: ACM → ALB → api target group (runbook §6.5, Kickoff 3.6)
#
# The intended request path, once the edge exists:
#
#   client → CloudFront (WAF web ACL, us-east-1) → adds x-nt-origin-verify
#          → ALB :443 (SG: CloudFront prefix list only) → api task :3000
#
# ⚠ CLOUDFRONT IS NOT BUILT IN THIS ENVIRONMENT (see main.tf). The consequence
# is worth stating rather than leaving to be discovered: the ALB security group
# admits :443 from the CloudFront origin-facing prefix list and nothing else,
# so **the production ALB is currently unreachable from anywhere on the
# internet.** That is the correct state for an environment with no image, no
# edge WAF and no pen test. It is not a broken deployment.
#
# BOTH locks are required and they cover different attacks. The prefix list
# stops anyone dialling the ALB's DNS name directly. The secret origin header
# stops anyone who stands up their OWN CloudFront distribution pointed at our
# origin — which costs them nothing, comes from the same prefix list, and would
# otherwise walk straight past our WAF. Runbook §6.5: "public origins that
# bypass CloudFront also bypass WAF."
# ==========================================================================

locals {
  # The port the api container listens on. modules/network derives both halves
  # of the alb↔app security-group pair from this via var.app_port, so it cannot
  # drift.
  app_port = 3000

  # The ALB's own hostname, deliberately NOT api.${local.domain}: runbook §6.5
  # gives `api.` to a CloudFront distribution and a hostname cannot alias both.
  # Keeping the origin on its own name also means an accidental `dig api.`
  # never reveals the origin address.
  api_origin_host = "origin-api.${local.domain}"

  # Lower-case on purpose: ALB header-NAME matching is case-insensitive, but
  # CloudFront forwards exactly what you type, and mixed case in config invites
  # a "why does it 403" afternoon.
  origin_header_name = "x-nt-origin-verify"
}

# --------------------------------------------------------------------------
# TLS — a wildcard for prod's subdomain, in eu-west-2, for the ALB.
#
# `*.prod.neoting.neovogent.com`, NOT `*.neoting.neovogent.com`. The parent
# wildcard is staging's (envs/staging/alb.tf) and a DNS wildcard is a single
# label: `*.neoting.neovogent.com` matches `api.` but not `api.prod.`, so the
# two certificates cover disjoint names and neither can serve the other's
# traffic. That is a feature — a staging certificate must never be able to
# terminate a production connection.
#
# The validation CNAME lands in the PARENT zone (there is no `prod.` hosted
# zone — see local.parent_zone in main.tf), at `_x.prod.neoting.neovogent.com`,
# so it cannot collide with staging's `_x.neoting.neovogent.com`.
#
# ACM public certificates are free and renew themselves, but ONLY while that
# validation CNAME stays in the zone. Do not garbage-collect it.
# --------------------------------------------------------------------------

data "aws_route53_zone" "primary" {
  name         = "${local.parent_zone}."
  private_zone = false
}

resource "aws_acm_certificate" "alb" {
  domain_name       = "*.${local.domain}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true # a cert swap must never leave the listener certificateless
  }

  tags = { Component = "edge" }
}

resource "aws_route53_record" "alb_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.alb.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = data.aws_route53_zone.primary.zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]

  # ACM emits the SAME validation record for `*.example.com` and
  # `example.com`, so if the apex is ever added as a SAN the second record is a
  # byte-identical duplicate and Route 53 rejects the create without this. It
  # is also what will let the CloudFront certificate (us-east-1, when edge.tf
  # lands) validate through the same record.
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "alb" {
  certificate_arn         = aws_acm_certificate.alb.arn
  validation_record_fqdns = [for r in aws_route53_record.alb_cert_validation : r.fqdn]
}

# --------------------------------------------------------------------------
# The load balancer.
#
# ONE ALB for the whole environment (~$18/mo fixed plus LCUs). When web and
# portal move off Vercel they get host-based listener rules on this listener,
# not their own load balancers.
#
# ⚠ IT IS IN THE PUBLIC SUBNETS AND THE TASKS ARE NOT. That is the shape a NAT
# buys: the only thing with a public-facing address in this environment is the
# load balancer, and it accepts connections from ~15 CloudFront prefixes.
# --------------------------------------------------------------------------

resource "aws_lb" "main" {
  name               = "nt-${local.env}-alb"
  load_balancer_type = "application"
  internal           = false
  subnets            = module.network.public_subnet_ids
  security_groups    = [module.network.alb_security_group_id]
  ip_address_type    = "ipv4"

  # TRUE in prod, the opposite of staging. Deleting this load balancer takes
  # the production front door with it, and the API refuses until the flag is
  # cleared by a separate, reviewed change. Same reasoning as the database's
  # deletion_protection: the obstruction IS the control.
  enable_deletion_protection = true

  # Free hardening:
  #  - drop_invalid_header_fields: strips headers that are not RFC-7230 valid
  #    rather than passing them to Node, which parses them more leniently.
  #  - desync_mitigation_mode "strictest": rejects ambiguous
  #    Content-Length/Transfer-Encoding framing outright (request smuggling).
  #    Safe to be strict because every legitimate client is CloudFront.
  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"

  # ⚠ The classic 502 generator: Node's server.keepAliveTimeout defaults to 5s
  # while the ALB holds connections for 60s. The ALB then reuses a socket Node
  # has already closed and the client sees an intermittent 502 with nothing in
  # the application log. Set keepAliveTimeout ABOVE this value in apps/api (65s
  # is the conventional pairing) and headersTimeout above that again.
  idle_timeout = 60

  # ⚠ ACCESS LOGS ARE OFF AND IN PROD THAT IS A REAL GAP, not a cost decision.
  # Without them a 5xx spike has no per-request evidence beyond CloudWatch's
  # aggregate counts — no client IP, no path, no target, no trace correlation.
  # They are off because the nt-prod-logs bucket does not exist (the storage
  # module takes a bucket map; adding `logs` to it is one line) and the ALB
  # validates writability at CREATE time, so pointing at a missing bucket fails
  # the apply. When the bucket lands: prefix "alb/", 90-day expiry, and a
  # bucket policy granting the eu-west-2 ELB account (652711504416 — verify
  # against the current AWS table). Cost is pennies. This should land before
  # the first real request, not after the first incident.
  tags = { Component = "edge" }
}

# --------------------------------------------------------------------------
# Target group for the api.
#
# target_type = "ip" is not a preference — awsvpc networking (which Fargate
# mandates) gives every task its own ENI, and "instance" targets do not exist
# in that world.
# --------------------------------------------------------------------------

resource "aws_lb_target_group" "api" {
  name        = "nt-${local.env}-api"
  port        = local.app_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = module.network.vpc_id

  # Requests are wildly uneven — a document-detail read is milliseconds, an
  # ingestion trigger is not. Round-robin queues fast requests behind slow ones
  # on the same task; least-outstanding-requests does not. Free.
  load_balancing_algorithm_type = "least_outstanding_requests"

  # Default is 300s: five minutes of a doomed task still being billed on every
  # deploy, and five minutes added to every rollback.
  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/healthz"
    protocol            = "HTTP"
    port                = "traffic-port"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # WHY /healthz AND NOT /readyz (runbook §6.4 defines both):
  #   /healthz — liveness. Is this process able to serve? No dependency calls.
  #   /readyz  — readiness. Can it reach Postgres AND Redis?
  # /readyz must never be the target-group check. Every task shares the same
  # database and the same Redis, so a 30-second Redis blip would fail every
  # task's check simultaneously, deregister the entire service, and turn a
  # degraded dependency into a hard outage with no capacity left to recover
  # into. In prod that is the difference between a slow minute and a page.
  # /readyz belongs to the deployment gate and to the synthetic check.

  tags = { Component = "api" }

  # ⚠ A change that FORCES REPLACEMENT here (port, protocol, target_type,
  # vpc_id) fails while the listener rule still references this group — ELB
  # refuses to delete a target group in use. Remove the rule, apply, restore
  # it. name_prefix + create_before_destroy is capped at SIX characters for
  # target groups, which produces a machine-generated name in an account shared
  # with three other products.
}

# --------------------------------------------------------------------------
# The shared origin secret.
#
# Generated here rather than typed by a human so it never exists in a password
# manager, a Slack message, or this diff.
#
# ⚠ AND IT IS NOT A STRONG CONTROL — read this before treating it as one. The
# same string is a plaintext condition value on the listener rule below, and
# `elasticloadbalancing:DescribeRules` returns rule conditions verbatim, an
# action AWS's managed ReadOnlyAccess grants. Terraform proves it: it diffs
# that attribute on every plan, which it could not do if the value were
# write-only. So anyone in this shared account with ELB read access can read
# the production origin header, and encrypting the Secrets Manager copy does
# not change that.
#
# Against an OUTSIDER the prefix list and the header work as a pair. Against an
# INSIDER in a shared account (D36) they do not, and the answer to that is the
# dedicated account, not a cleverer header.
#
# ROTATION: add the new value as a SECOND entry in the listener rule's `values`
# list (ALB matches any of them), roll CloudFront onto the new header, then
# remove the old one. Swapping in place 403s every request for the duration of
# the CloudFront propagation.
# --------------------------------------------------------------------------

resource "random_password" "alb_origin_verify" {
  length = 48

  # special = false yields [A-Za-z0-9] only, which matters twice: HTTP header
  # values must survive CloudFront's custom-header validation, and ALB
  # http-header conditions treat `*` and `?` as WILDCARDS — a generated `*`
  # would silently widen the rule to match far more than the secret.
  special = false
}

resource "aws_secretsmanager_secret" "alb_origin_verify" {
  name        = "/neoting/${local.env}/edge/alb-origin-header"
  description = "Shared secret CloudFront must present to the ALB (runbook §6.5)"

  kms_key_id = aws_kms_key.secrets.arn

  # 30 days in prod, not staging's 0.
  #
  # staging sets 0 (immediate, unrecoverable delete) because a deleted secret
  # RESERVES ITS NAME for the whole recovery window, which makes
  # destroy-and-rebuild fail on the second run — and staging is rebuilt often.
  # Production is not rebuilt, the name reservation is a feature here, and 30
  # days is the standard window. Do not copy staging's 0 into any prod secret.
  recovery_window_in_days = 30

  tags = { Component = "edge" }
}

resource "aws_secretsmanager_secret_version" "alb_origin_verify" {
  secret_id = aws_secretsmanager_secret.alb_origin_verify.id

  secret_string = jsonencode({
    header_name  = local.origin_header_name
    header_value = random_password.alb_origin_verify.result
  })
}

# The CloudFront managed prefix list. Read once here and passed into
# module.network (network.tf) as alb_ingress_prefix_list_id, so the edge and
# the origin lock read the same list rather than each holding their own data
# source. AWS maintains the ranges; we never track edge IPs by hand.
#
# ⚠ QUOTA: this list consumes its max_entries (55 for cloudfront/origin-facing)
# against the default 60 rules per security group, not one. The ALB security
# group therefore has room for almost nothing else — a temporary /32 for a
# smoke test fits; a second prefix list does not.
data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

# --------------------------------------------------------------------------
# Listeners.
#
# The HTTPS listener's DEFAULT action is a 403. Nothing is forwarded unless a
# rule matches, so a future misconfigured rule fails closed, not open.
# --------------------------------------------------------------------------

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"

  # TLS 1.2 floor with TLS 1.3 offered. Nothing that talks to this origin is a
  # legacy client — it is CloudFront — so there is no reason to keep 1.0/1.1
  # ciphers alive (Gov §11.9).
  ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn = aws_acm_certificate_validation.alb.certificate_arn

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      status_code  = "403"
      message_body = "Forbidden"
    }
  }

  tags = { Component = "edge" }
}

resource "aws_lb_listener_rule" "api_origin_verified" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  # The second of the two §6.5 locks — see the honesty banner on the secret
  # above for what it is and is not worth.
  condition {
    http_header {
      http_header_name = local.origin_header_name
      values           = [random_password.alb_origin_verify.result]
    }
  }
}

# Port 80 exists only so that plaintext can never serve a byte of this API.
#
# The ALB security group admits :443 from the CloudFront prefix list and
# nothing else, so this listener is unreachable today — intentional, and not
# dead config. The day somebody adds an :80 ingress rule "just to test
# something", this redirect is already there and the test cannot become a
# plaintext leak. A listener costs nothing beyond the LCUs it never serves.
resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }

  tags = { Component = "edge" }
}

# --------------------------------------------------------------------------
# DNS.
#
# ALIAS, not CNAME: an alias to an ALB is free (Route 53 does not charge for
# alias queries to AWS targets) and it is the only way to point a name at an
# ALB whose IPs change under you.
#
# evaluate_target_health = false deliberately: with a single ALB there is no
# second record to fail over to, and health-evaluated aliases can NXDOMAIN a
# name during a deploy blip — which looks like DNS being broken rather than the
# app being briefly unhealthy.
# --------------------------------------------------------------------------

resource "aws_route53_record" "api_origin" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = local.api_origin_host
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = false
  }
}

# --------------------------------------------------------------------------
output "alb_dns_name" { value = aws_lb.main.dns_name }
output "alb_zone_id" { value = aws_lb.main.zone_id }
output "alb_certificate_arn" { value = aws_acm_certificate_validation.alb.certificate_arn }
output "api_target_group_arn" { value = aws_lb_target_group.api.arn }

output "api_origin_host" {
  value       = local.api_origin_host
  description = "Origin hostname for the CloudFront api distribution, when edge.tf lands. Not user-facing."
}

output "alb_origin_header_name" {
  value       = local.origin_header_name
  description = "CloudFront must send this header with the value in the secret below, or the ALB returns 403."
}

output "alb_origin_header_secret_arn" { value = aws_secretsmanager_secret.alb_origin_verify.arn }
