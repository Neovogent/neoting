# --------------------------------------------------------------------------
# Security groups — referenced by ID, never by CIDR, so the chain is explicit:
# internet → alb → app → data. Nothing skips a link.
#
# The module owns the three tier groups and the rules BETWEEN them. Rules for
# anything bolted on later (Unleash, ClamAV) belong in the calling root and
# attach to these groups by ID, so deleting that feature's file removes its
# grant with it and this module is never edited to add a workload.
# --------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "nt-${var.env}-alb"
  description = "Public load balancer"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "nt-${var.env}-alb" }
}

# Runbook §6.5: the origin is internet-facing but reachable ONLY from
# CloudFront's edge, because "public origins that bypass CloudFront also
# bypass WAF" — and the WAF ACL is where the portal rate limits that back
# Gov §11.8 actually live. AWS owns the contents of this list, so edge IP
# ranges are never tracked by hand.
#
# This is half of the lock. The prefix list is shared by every CloudFront
# customer, so anyone could point their OWN distribution at our origin and
# arrive from an allowed address; the secret origin header that the ALB
# listener rule demands (alb.tf in the calling root) is the other half.
# Neither is sufficient alone.
#
# ⚠ QUOTA: see var.alb_ingress_prefix_list_id. This group has room for almost
# nothing else. New rules go on a different security group, or the quota gets
# raised first.
#
# To smoke-test the ALB directly before CloudFront exists, add a temporary
# ingress rule for your own /32 in a PR (runbook §2.2 — never a console click)
# and delete it in the same day's work.
resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  # ASCII ONLY. EC2 rejects a security-group rule description outside
  # [a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*] with InvalidParameterValue, and the "§"
  # this used to carry (runbook §6.5) is not in that set. It failed at APPLY,
  # not at plan — terraform validate cannot see an API-side character class.
  # Cite sections in comments, never in a field AWS validates.
  description    = "HTTPS from CloudFront edge locations only (runbook 6.5)"
  prefix_list_id = var.alb_ingress_prefix_list_id
  from_port      = 443
  to_port        = 443
  ip_protocol    = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To application tasks"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = var.app_port
  to_port                      = var.app_port
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "app" {
  name        = "nt-${var.env}-app"
  description = "ECS tasks (api, workers). No inbound except from the ALB."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "nt-${var.env}-app" }
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "From the load balancer only"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = var.app_port
  to_port                      = var.app_port
  ip_protocol                  = "tcp"
}

# Outbound to AWS APIs (Bedrock, Textract, SES, ECR). In an environment with no
# NAT this leaves over the task's own public IP; with NAT it leaves through the
# gateway. The rule is the same either way — what changes is the route table,
# not the security group.
resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  description       = "Outbound to AWS service endpoints"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "data" {
  name        = "nt-${var.env}-data"
  description = "RDS and ElastiCache. Reachable only from application tasks."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "nt-${var.env}-data" }
}

resource "aws_vpc_security_group_ingress_rule" "postgres_from_app" {
  security_group_id            = aws_security_group.data.id
  description                  = "PostgreSQL from application tasks"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_app" {
  security_group_id            = aws_security_group.data.id
  description                  = "Redis from application tasks"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}
