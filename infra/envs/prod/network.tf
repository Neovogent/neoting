# --------------------------------------------------------------------------
# Network (Kickoff 3.6) — infra/modules/network.
#
# THE DIFFERENCE FROM STAGING IS ONE BOOLEAN, AND IT CHANGES THE SHAPE OF THE
# WHOLE ENVIRONMENT. `enable_nat_gateway = true` turns on the private tier
# (the module forces it — a NAT with nothing behind it is $36/mo of
# decoration), which means:
#
#   * Fargate tasks run in PRIVATE subnets with assign_public_ip = false. In
#     staging they sit in public subnets with a public IP because there is no
#     NAT; here they have no public address at all and nothing on the internet
#     can address them, route or no route.
#   * Egress leaves through a stable, allowlistable IP (module output
#     `nat_gateway_public_ips`). That matters the first time a third party —
#     TrueLayer, an accounting practice's firewall — asks for a source IP.
#     Staging cannot answer that question; prod can.
#   * The S3 gateway endpoint automatically picks up the private route tables
#     (the module concatenates them), so document traffic to S3 never touches
#     the NAT and is never billed per GB through it.
#
# COST (Appendix B.3, "Prod gets a real NAT"): ~$33/mo fixed for the gateway
# plus $0.045/GB processed. At pilot document volume the data charge is small
# but not zero — every Bedrock, Textract and ECR byte that does NOT have an
# interface endpoint goes through here, which is most of the reason
# endpoints.tf exists.
#
# ⚠ ONE NAT, NOT THREE, AND THE MODULE'S OWN VARIABLE DESCRIPTION DISAGREES
# WITH THAT CHOICE. `single_nat_gateway` is documented in
# modules/network/variables.tf as "acceptable in a pre-production environment,
# not in prod". Runbook Appendix B.3 is the more specific instruction and it
# wins here: "Prod gets a real NAT — one to start, one per AZ when
# availability demands it."
#
# So this is a KNOWN, PRICED availability hole, not an oversight:
#   * The NAT lives in eu-west-2a. If that AZ fails, tasks in 2b and 2c lose
#     ALL egress — Bedrock, Textract, SES, Twilio, Xero — even though RDS has
#     failed over cleanly and the ALB is still serving. The environment will
#     look half-alive, which is the worst kind of outage to diagnose.
#   * The fix is deleting one line (`single_nat_gateway = true`). It costs
#     ~$66/mo more and the module already creates one route table per private
#     subnet precisely so that flip is a route-target change and not a
#     re-association of every subnet in the VPC.
#   * "Availability demands it" means: the first paying customer, or the first
#     time an AZ event actually bites. Not "when someone remembers".
# --------------------------------------------------------------------------

module "network" {
  source = "../../modules/network"

  env        = local.env
  account_id = local.account_id
  region     = local.region
  vpc_cidr   = local.vpc_cidr
  azs        = local.azs

  enable_nat_gateway = true
  single_nat_gateway = true # see the banner above — priced, not forgotten

  # Redundant with enable_nat_gateway (the module forces the tier on), stated
  # anyway so that reading this call tells you prod HAS a private tier without
  # having to know the module's coupling rule.
  enable_private_subnets = true

  # REJECT, not ALL, and in prod that deserves a sentence rather than a copy of
  # staging's "accepts are noise".
  #
  # ALL flow logs on a three-AZ VPC carrying document traffic is real money:
  # CloudWatch ingest is ~$0.57/GB and flow logs are chatty per-flow records,
  # not per-request. Appendix B.2 already flags CloudWatch as "the sleeper line
  # item" that "can quietly out-cost RDS". REJECT captures what security
  # actually reviews — connections that were refused, i.e. something probing a
  # boundary — and costs pennies.
  #
  # What it gives up, honestly: no evidence of a SUCCESSFUL exfiltration path.
  # If prod ever has an incident that needs "what did this task talk to", this
  # setting is why the answer is missing, and the answer is to flip this to ALL
  # for the duration of the investigation. Budget it before turning it on
  # permanently.
  flow_log_traffic_type   = "REJECT"
  flow_log_retention_days = 30 # Governance §12.2: application logs / traces

  # The CloudFront managed prefix list, read in alb.tf and passed here so the
  # edge lock and the origin lock cannot drift apart.
  alb_ingress_prefix_list_id = data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.id
  app_port                   = local.app_port
}

output "vpc_id" { value = module.network.vpc_id }
output "private_subnet_ids" { value = module.network.private_subnet_ids }
output "public_subnet_ids" { value = module.network.public_subnet_ids }

output "nat_gateway_public_ips" {
  value       = module.network.nat_gateway_public_ips
  description = "The stable egress address(es). This is what a third party's IP allowlist gets — one entry today, three the day single_nat_gateway goes false, so tell them it is a list."
}
