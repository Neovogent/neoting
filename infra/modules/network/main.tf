# --------------------------------------------------------------------------
# Network (Kickoff 3.6).
#
# Three tiers, and which of them exist is the only thing that differs between
# environments:
#
#   public   /20 per AZ. Default route to the IGW. In staging this is where
#            Fargate tasks run, with a public IP and no inbound rules.
#   private  /20 per AZ, off by default. Exists when there is a NAT to route
#            it through - see var.enable_nat_gateway for the cost argument.
#   data     /24 per AZ. No route off the VPC in either direction, in every
#            environment. RDS and ElastiCache only.
#
# Everything else here (IGW, route tables, flow logs, the S3 gateway endpoint,
# the three security groups) is identical in shape across environments and
# differs only in size, which is exactly why it is a module.
# --------------------------------------------------------------------------

locals {
  # A NAT with no private tier behind it is $36/mo of decoration, so asking for
  # one turns the tier on rather than failing a validation the caller then has
  # to satisfy twice. Terraform 1.7 cannot cross-reference variables inside a
  # validation block, so this is also the only place the rule can live.
  private_subnet_count = (var.enable_private_subnets || var.enable_nat_gateway) ? length(var.azs) : 0

  nat_gateway_count = var.enable_nat_gateway ? (var.single_nat_gateway ? 1 : length(var.azs)) : 0
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "nt-${var.env}" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "nt-${var.env}" }
}

# App tier: /20 per AZ.
resource "aws_subnet" "public" {
  count = length(var.azs)

  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = false # tasks opt in explicitly via assign_public_ip

  tags = {
    Name = "nt-${var.env}-public-${var.azs[count.index]}"
    Tier = "public"
  }
}

# Data tier: /24 per AZ, no route to the internet in either direction.
resource "aws_subnet" "data" {
  count = length(var.azs)

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 48 + count.index)
  availability_zone = var.azs[count.index]

  tags = {
    Name = "nt-${var.env}-data-${var.azs[count.index]}"
    Tier = "data"
  }
}

# Private app tier: /20 per AZ, created only when the environment has somewhere
# for it to route.
#
# ⚠ THE OFFSET IS NOT ARBITRARY AND MUST NOT BE "TIDIED" TO 3, 4, 5. The data
# tier is carved with newbits 8 at netnum 48-50, i.e. 10.x.48.0/24 through
# 10.x.50.0/24 - which sits INSIDE the /20 that netnum 3 would claim
# (10.x.48.0/20). Starting at 8 puts the private tier at 10.x.128.0/20 onward
# and leaves the whole 10.x.48.0/20 block to the data tier and to future
# small-prefix tiers. cidrsubnet does not warn about overlap; the VPC API
# rejects it at apply, which is a slow way to learn this.
resource "aws_subnet" "private" {
  count = local.private_subnet_count

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, 8 + count.index)
  availability_zone = var.azs[count.index]

  tags = {
    Name = "nt-${var.env}-private-${var.azs[count.index]}"
    Tier = "private"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "nt-${var.env}-public" }
}

resource "aws_route_table_association" "public" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Deliberately no 0.0.0.0/0 route: the database tier cannot reach the internet
# and the internet cannot reach it.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "nt-${var.env}-data" }
}

resource "aws_route_table_association" "data" {
  count          = length(var.azs)
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

# --------------------------------------------------------------------------
# NAT — the ~$36/mo/gateway line that staging refuses and prod cannot.
#
# One route table PER private subnet even when there is a single NAT, so that
# scaling from single_nat_gateway = true to one-per-AZ is an edit to the route
# target rather than a re-association of every subnet in the VPC.
# --------------------------------------------------------------------------
resource "aws_eip" "nat" {
  count = local.nat_gateway_count

  domain = "vpc"
  tags   = { Name = "nt-${var.env}-nat-${var.azs[count.index]}" }
}

resource "aws_nat_gateway" "main" {
  count = local.nat_gateway_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = { Name = "nt-${var.env}-nat-${var.azs[count.index]}" }

  # The IGW must exist before the NAT can route through it. Terraform does not
  # infer this edge, and without it apply fails intermittently on a fresh VPC.
  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "private" {
  count = local.private_subnet_count

  vpc_id = aws_vpc.main.id
  tags   = { Name = "nt-${var.env}-private-${var.azs[count.index]}" }
}

# Separate from the route table so that private subnets with NAT off are a
# legitimate fully-isolated tier rather than a broken one.
resource "aws_route" "private_nat" {
  count = var.enable_nat_gateway ? local.private_subnet_count : 0

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[var.single_nat_gateway ? 0 : count.index].id
}

resource "aws_route_table_association" "private" {
  count = local.private_subnet_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# Gateway endpoint: free, and keeps document traffic off the public internet.
#
# The private route tables are concatenated rather than listed, so the endpoint
# picks them up automatically in an environment that has them and the list is
# byte-identical in one that does not.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"

  route_table_ids = concat(
    [aws_route_table.public.id, aws_route_table.data.id],
    aws_route_table.private[*].id,
  )

  tags = { Name = "nt-${var.env}-s3" }
}
