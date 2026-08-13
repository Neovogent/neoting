# --------------------------------------------------------------------------
# The serving path: ACM → ALB → api target group (runbook §6.5, Kickoff 3.6)
#
# Once the edge lands the request path is:
#
#   client → CloudFront (WAF web ACL, us-east-1) → adds x-nt-origin-verify
#          → ALB :443 (SG: CloudFront prefix list only) → api task :3000
#
# BOTH locks are required and they cover different attacks. The prefix list
# stops anyone dialling the ALB's DNS name directly. The secret header stops
# anyone who stands up their OWN CloudFront distribution pointed at our origin
# — which costs them nothing, comes from the same prefix list, and would
# otherwise walk straight past our WAF. Runbook §6.5: "Public origins that
# bypass CloudFront also bypass WAF."
#
# CloudFront itself, its us-east-1 certificate and its WAF ACL are a separate
# file owned by another agent. This file owns everything from the origin
# hostname inwards.
# --------------------------------------------------------------------------

locals {
  # The port the api container listens on. network.tf's alb→app and app←alb
  # rules are already pinned to 3000; changing this means changing those too.
  app_port = 3000

  # The ALB's own hostname, and deliberately NOT api.${local.domain}:
  # runbook §6.5 gives api. to a CloudFront distribution, and a hostname
  # cannot alias both. Keeping the origin on its own name also means an
  # accidental `dig api.` never reveals the origin.
  #
  # NOT the apex either — the apex carries the SES inbound MX (email.tf) and
  # Route 53 will not hold an MX and an A/ALIAS on the same name.
  api_origin_host = "origin-api.${local.domain}"

  # Lower-case on purpose: ALB condition matching on header NAMES is
  # case-insensitive, but CloudFront forwards what you type and mixed case in
  # config invites a "why does it 403" afternoon.
  origin_header_name = "x-nt-origin-verify"
}

# --------------------------------------------------------------------------
# TLS — a wildcard in eu-west-2 for the ALB.
#
# ACM public certificates are free and renew themselves, but ONLY while the
# validation CNAME below stays in the zone. Do not garbage-collect it.
#
# This certificate cannot be shared with CloudFront: CloudFront reads
# certificates only from us-east-1 (the one documented exception to the
# eu-west-2-only rule, D30). The edge file issues its own.
# --------------------------------------------------------------------------

resource "aws_acm_certificate" "alb" {
  domain_name       = "*.${local.domain}"
  validation_method = "DNS"

  # A wildcard covers origin-api., api., app. and portal. in one certificate
  # and one validation record. The apex is deliberately absent: nothing
  # terminates TLS on the apex, and adding it here would create a second
  # validation record for no benefit.

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
  # `example.com`. If the apex is ever added as a SAN, the second record is a
  # byte-identical duplicate and Route 53 rejects the create without this.
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "alb" {
  certificate_arn         = aws_acm_certificate.alb.arn
  validation_record_fqdns = [for r in aws_route53_record.alb_cert_validation : r.fqdn]
}

# --------------------------------------------------------------------------
# The load balancer.
#
# COST DECISION (Appendix B.2 budgets the ALB at ~$18/mo — $0.0225/hr fixed
# plus LCUs): ONE ALB for the whole environment. When web and portal move off
# Vercel at Infra Week (G6) they get host-based listener rules on this
# listener, not their own load balancers — a second ALB is another ~$16/mo of
# fixed cost for zero capability staging needs.
# --------------------------------------------------------------------------

resource "aws_lb" "main" {
  name               = "nt-${local.env}-alb"
  load_balancer_type = "application"
  internal           = false
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]
  ip_address_type    = "ipv4"

  # Staging is disposable by design (G1) and holds synthetic data only (G2),
  # so `terraform destroy` must actually complete. Deletion protection here
  # turns a teardown into a console click, which is exactly the manual step
  # runbook §2.2 forbids. Prod flips this to true.
  enable_deletion_protection = false

  # Free hardening, and free is the right price for it:
  #  - drop_invalid_header_fields: strips headers that are not RFC-7230 valid
  #    rather than passing them to Node, which parses them more leniently.
  #  - desync_mitigation_mode "strictest": rejects ambiguous
  #    Content-Length/Transfer-Encoding framing outright (request smuggling).
  #    Safe to be strict here because every legitimate client is CloudFront.
  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"

  # ⚠ The classic 502 generator: Node's server.keepAliveTimeout defaults to 5s
  # while the ALB holds connections for 60s. The ALB then reuses a socket Node
  # has already closed and the client sees an intermittent 502 with nothing in
  # the application log. Set keepAliveTimeout ABOVE this value in apps/api
  # (65s is the conventional pairing) and headersTimeout above that again.
  idle_timeout = 60

  # TODO(runbook §6.2): access logs are OFF because the nt-${local.env}-logs
  # bucket does not exist yet — that bucket is part of the storage module and
  # is not built. Do not enable access_logs against a bucket that is missing;
  # the ALB validates writability at create time and the apply fails.
  # When the bucket lands: enable_access_logs with prefix "alb/", 30-90 day
  # lifecycle expiry, and a bucket policy granting the regional ELB account
  # (eu-west-2: 652711504416 — verify against the current AWS docs table;
  # regions enabled after Aug 2022 use a service principal instead). Cost is
  # pennies of S3 at staging volume, and without it a 5xx spike has no
  # per-request evidence beyond CloudWatch's aggregate counts.

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
  vpc_id      = aws_vpc.main.id

  # Requests are wildly uneven here — a document-detail read is milliseconds,
  # an ingestion trigger is not. Round-robin queues fast requests behind slow
  # ones on the same task; least-outstanding-requests does not. Free.
  load_balancing_algorithm_type = "least_outstanding_requests"

  # Default is 300s. That is five minutes of a doomed task still being billed
  # on every deploy, and five minutes added to every rollback.
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
  # into. /readyz belongs to the deployment gate and to the CloudWatch
  # synthetic check, where its failure pages a human instead of removing the
  # last healthy target. The app MUST expose both.

  tags = { Component = "api" }

  # ⚠ A change that FORCES REPLACEMENT here (port, protocol, target_type,
  # vpc_id) will fail on the first apply: Terraform tries to destroy this
  # group while the listener rule still references it, and ELB refuses to
  # delete a target group that is in use. Remove the rule, apply, restore it.
  # The alternative — name_prefix + create_before_destroy — is capped at SIX
  # characters for target groups, which produces a machine-generated name in
  # an account shared with three other products. A readable name is worth the
  # rare two-step apply.
}

# --------------------------------------------------------------------------
# The shared origin secret.
#
# Generated here rather than typed by a human so it never exists in a
# password manager, a Slack message, or this diff. The real value lives in
# Terraform state and in Secrets Manager; the CloudFront file reads
# random_password.alb_origin_verify.result directly (same state, same apply)
# and sets it as a custom origin header. Nobody needs to see it.
#
# ROTATION: add the new value as a SECOND entry in the listener rule's
# `values` list (ALB matches any of them), roll CloudFront onto the new
# header, then remove the old value. Swapping in place 403s every request
# for the duration of the CloudFront propagation.
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

  # The CMK, not the AWS-managed default, whose policy cannot carry the
  # `role/nt-*` explicit Deny (D36). This value is the ONLY thing standing
  # between a stranger's CloudFront distribution and our origin — the managed
  # prefix list on the ALB ingress rule admits every CloudFront distribution in
  # the world, so anyone who reads this header walks straight past the WAF.
  kms_key_id = aws_kms_key.secrets.arn

  # Secrets Manager bills ~$0.40/secret/month, so this is a deliberate
  # $0.40 — it exists so an on-call engineer can verify what the edge is
  # sending without reading Terraform state.
  #
  # 0 — immediate delete, no recovery window — and deliberately shorter than
  # the 7 days the application secrets use. A deleted secret RESERVES ITS NAME
  # for the whole window, so anything longer makes `destroy` + `apply` fail on
  # the second run. That trade is only correct because this value has no
  # recovery value: it is generated by Terraform, and "restoring" it means
  # regenerating it. Never copy this setting onto a secret a human typed.
  recovery_window_in_days = 0

  tags = { Component = "edge" }
}

resource "aws_secretsmanager_secret_version" "alb_origin_verify" {
  secret_id = aws_secretsmanager_secret.alb_origin_verify.id

  secret_string = jsonencode({
    header_name  = local.origin_header_name
    header_value = random_password.alb_origin_verify.result
  })
}

# The CloudFront managed prefix list, consumed by the ALB security group rule
# in network.tf. AWS maintains the ranges; we never track edge IPs by hand.
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

  # TLS 1.2 floor with TLS 1.3 offered. Nothing that talks to this origin is
  # a legacy client — it is CloudFront — so there is no reason to keep 1.0/1.1
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

  # The second of the two §6.5 locks. Without this, anyone can point their own
  # CloudFront distribution at origin-api.${local.domain}, arrive from the
  # same prefix list we just allowed, and serve our API with our WAF bypassed.
  condition {
    http_header {
      http_header_name = local.origin_header_name
      values           = [random_password.alb_origin_verify.result]
    }
  }
}

# Port 80 exists only so that plaintext can never serve a byte of this API.
#
# NOTE: the ALB security group admits :443 from the CloudFront prefix list and
# nothing else, so today this listener is unreachable — that is intentional
# and it is not dead config. CloudFront speaks HTTPS to the origin; the day
# somebody adds an :80 ingress rule "just to test something", this redirect is
# already there and the test cannot become a plaintext leak. An ALB listener
# costs nothing beyond the LCUs it never serves.
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
# ALIAS, not CNAME: an ALIAS to an ALB is free (Route 53 does not charge for
# alias queries to AWS targets), and it is the only way to point a name at an
# ALB whose IPs change under you.
#
# evaluate_target_health = false deliberately: with a single ALB there is no
# second record to fail over to, and health-evaluated aliases can NXDOMAIN a
# name during a deploy blip — which looks like DNS being broken rather than
# the app being briefly unhealthy.
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
  description = "Origin hostname for the CloudFront api distribution. Not user-facing — the api. name belongs to CloudFront."
}

output "alb_origin_header_name" {
  value       = local.origin_header_name
  description = "CloudFront must send this header with the value in the secret below, or the ALB returns 403."
}

output "alb_origin_header_secret_arn" { value = aws_secretsmanager_secret.alb_origin_verify.arn }
