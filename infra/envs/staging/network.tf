# --------------------------------------------------------------------------
# Network (Kickoff 3.6)
#
# COST DECISION (runbook Appendix B.3): staging runs with NO NAT gateway
# (~$36/mo + data). Fargate tasks sit in public subnets with a public IP and
# security groups that permit no inbound traffic; data subnets have no route
# off the VPC at all. Defensible only because staging is synthetic-data-only
# (G2). Prod gets a real NAT and interface endpoints.
# --------------------------------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "nt-${local.env}" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "nt-${local.env}" }
}

# App tier: /20 per AZ.
resource "aws_subnet" "public" {
  count = length(local.azs)

  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(local.vpc_cidr, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false # tasks opt in explicitly via assign_public_ip

  tags = {
    Name = "nt-${local.env}-public-${local.azs[count.index]}"
    Tier = "public"
  }
}

# Data tier: /24 per AZ, no route to the internet in either direction.
resource "aws_subnet" "data" {
  count = length(local.azs)

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(local.vpc_cidr, 8, 48 + count.index)
  availability_zone = local.azs[count.index]

  tags = {
    Name = "nt-${local.env}-data-${local.azs[count.index]}"
    Tier = "data"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "nt-${local.env}-public" }
}

resource "aws_route_table_association" "public" {
  count          = length(local.azs)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Deliberately no 0.0.0.0/0 route: the database tier cannot reach the internet
# and the internet cannot reach it.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "nt-${local.env}-data" }
}

resource "aws_route_table_association" "data" {
  count          = length(local.azs)
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

# Gateway endpoint: free, and keeps document traffic off the public internet.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id, aws_route_table.data.id]

  tags = { Name = "nt-${local.env}-s3" }
}

resource "aws_flow_log" "main" {
  vpc_id               = aws_vpc.main.id
  traffic_type         = "REJECT" # rejects only — accepts are noise at this scale and cost money
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow_logs.arn
  iam_role_arn         = aws_iam_role.flow_logs.arn
}

resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/nt/${local.env}/vpc-flow-logs"
  retention_in_days = 30 # Governance §12.2: application logs / traces
}

resource "aws_iam_role" "flow_logs" {
  name = "nt-${local.env}-flow-logs"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  name = "write-logs"
  role = aws_iam_role.flow_logs.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"]
      Resource = "${aws_cloudwatch_log_group.flow_logs.arn}:*"
    }]
  })
}

# --------------------------------------------------------------------------
# Security groups — referenced by ID, never by CIDR, so the chain is explicit:
# internet → alb → app → data. Nothing skips a link.
# --------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "nt-${local.env}-alb"
  description = "Public load balancer"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "nt-${local.env}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the internet (tighten to the CloudFront prefix list when the distribution lands)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To application tasks"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "app" {
  name        = "nt-${local.env}-app"
  description = "ECS tasks (api, workers). No inbound except from the ALB."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "nt-${local.env}-app" }
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "From the load balancer only"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

# Outbound to AWS APIs (Bedrock, Textract, SES, ECR) over the public IP,
# since there is no NAT in staging.
resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  description       = "Outbound to AWS service endpoints"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "data" {
  name        = "nt-${local.env}-data"
  description = "RDS and ElastiCache. Reachable only from application tasks."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "nt-${local.env}-data" }
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
