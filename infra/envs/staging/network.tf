# --------------------------------------------------------------------------
# Network (Kickoff 3.6) — infra/modules/network.
#
# COST DECISION (runbook Appendix B.3): staging runs with NO NAT gateway
# (~$36/mo + data). Fargate tasks sit in public subnets with a public IP and
# security groups that permit no inbound traffic; data subnets have no route
# off the VPC at all. Defensible only because staging is synthetic-data-only
# (G2). Prod sets enable_nat_gateway = true, which turns on the private tier
# and gives tasks a stable egress address, and adds interface endpoints.
#
# ⚠ THE PRIVATE TIER IS OFF HERE, SO module.network EMITS NO PRIVATE SUBNETS.
# Anything reading module.network.private_subnet_ids in this root gets an empty
# list, on purpose. Workloads place themselves in public_subnet_ids until the
# NAT exists.
#
# Security-group rules for bolted-on workloads (Unleash, ClamAV) live with
# those workloads and attach to these groups by ID — see unleash.tf and
# clamav.tf. The module owns only the alb → app → data chain.
# --------------------------------------------------------------------------

module "network" {
  source = "../../modules/network"

  env        = local.env
  account_id = local.account_id
  region     = local.region
  vpc_cidr   = local.vpc_cidr
  azs        = local.azs

  # Staging: no NAT, therefore no private tier. Both stay false together.
  enable_nat_gateway     = false
  enable_private_subnets = false

  flow_log_traffic_type   = "REJECT" # accepts are noise at this scale and cost money
  flow_log_retention_days = 30       # Governance §12.2: application logs / traces

  # The CloudFront managed prefix list, read once in alb.tf and passed here so
  # the edge and the origin lock cannot drift apart.
  alb_ingress_prefix_list_id = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id
  app_port                   = local.app_port
}
