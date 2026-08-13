# ==========================================================================
# Interface VPC endpoints — the line item staging refuses and prod buys.
#
# Runbook Appendix B.3, decision 1, verbatim:
#
#   "No interface VPC endpoints in staging (~$8/endpoint/AZ/month; 8 of them
#    ≈ $60). Gateway S3 endpoint only — it's free. Add the interface endpoints
#    in PROD, where keeping document and model traffic off the public internet
#    is a residency/security argument (D30, Gov §11.9), not a bill."
#
# THE ARGUMENT, SO NOBODY LATER TRIMS THIS TO SAVE MONEY. With a NAT and no
# endpoints, every Textract page and every Bedrock prompt leaves the VPC,
# traverses the public internet to a public AWS endpoint, and comes back. The
# bytes are TLS-encrypted throughout, so this is not a confidentiality hole in
# the cryptographic sense. What it is:
#
#   * A RESIDENCY story with a gap in it. D30 promises UK-only processing. "It
#     went over the public internet to a London endpoint and we believe it
#     stayed in the UK" is a weaker sentence in a DPIA than "it never left the
#     VPC". With endpoints, the document's path to Textract is an ENI in our
#     own subnet. That is the difference between an assertion and a topology.
#   * A dependency on the NAT and on internet reachability for the paths that
#     matter most — model inference and extraction ARE the product (SoT §4).
#   * A missing enforcement point. A VPC endpoint policy can say "only
#     principals in this account", which no amount of IAM on our side can say
#     about a public endpoint.
#
# ⚠ COST, STATED PLAINLY AND NOT ROUNDED DOWN.
#   7 services × 3 AZs × $0.011/ENI-hour × 730h ≈ $168.63/month, FIXED,
#   whether a byte flows or not. Plus $0.01/GB processed.
#
# That is materially more than Appendix B.3's "8 of them ≈ $60" estimate,
# because that estimate priced one ENI per service and this creates three —
# one per AZ, matching the private subnets. The alternative is not free either:
# with ENIs in only two AZs, tasks in the third resolve the regional endpoint
# name to an ENI in another AZ and pay $0.01/GB cross-AZ each way, on top of a
# soft dependency between AZs that defeats part of the point of three of them.
#
# THE LEVERS, if the October bill has to come down:
#   * Drop to 2 AZs for endpoints only: −$56/month, adds cross-AZ transfer.
#   * Drop `kms` (data keys are cached by the S3 Bucket Key, so KMS call volume
#     is low and it is a control-plane call, not document bytes): −$24/month.
#   * Drop `logs` (log records are our own JSON, not customer documents; they
#     are the least residency-sensitive traffic here): −$24/month.
#   * DO NOT drop `bedrock-runtime` or `textract`. Those two carry the actual
#     customer document content and they are the reason this file exists.
# ==========================================================================

locals {
  # ⚠ ecr.api AND ecr.dkr ARE BOTH REQUIRED AND THEY ARE NOT INTERCHANGEABLE.
  # ecr.api is the control plane (GetAuthorizationToken, DescribeImages);
  # ecr.dkr is the Docker registry protocol (manifest + layer pulls). An image
  # pull with only one of them fails partway, which reads like a broken image.
  #
  # AND NEITHER IS SUFFICIENT WITHOUT THE S3 GATEWAY ENDPOINT: ECR stores layer
  # blobs in an AWS-owned S3 bucket and the pull fetches them from S3 directly.
  # The gateway endpoint comes free with modules/network and is already
  # attached to the private route tables — if someone ever "tidies" it away,
  # every task in this environment stops starting.
  interface_endpoints = {
    "ecr.api"         = "ECR control plane - auth token, image metadata"
    "ecr.dkr"         = "ECR Docker registry - manifests and layer pulls (layers themselves come from S3 via the gateway endpoint)"
    "logs"            = "CloudWatch Logs - the awslogs driver on every task"
    "secretsmanager"  = "Secret injection at task start (Gov §11.5) and runtime reads"
    "kms"             = "Envelope encryption for documents, secrets and the DR replica"
    "bedrock-runtime" = "Model inference. THE residency-critical one (D30, ADR 0001) - customer document text goes over this"
    "textract"        = "Extraction. THE other residency-critical one - the document image itself goes over this"
  }
}

# --------------------------------------------------------------------------
# One security group for all seven endpoints.
#
# Ingress is 443 from the APP security group by reference, not by CIDR. A CIDR
# rule for the VPC would also admit the data tier and anything else that lands
# in this VPC later; referencing the group means only application tasks can
# reach the endpoints, and the grant follows the group rather than the address
# space.
#
# No egress rules at all: security groups are stateful, so the response to an
# allowed inbound request is allowed out without a rule. An egress rule here
# would be decoration — and decoration on a security group is how a reviewer
# loses the ability to tell which rules matter.
# --------------------------------------------------------------------------
resource "aws_security_group" "vpc_endpoints" {
  name        = "nt-${local.env}-vpc-endpoints"
  description = "Interface VPC endpoints. Reachable only from application tasks."
  vpc_id      = module.network.vpc_id

  tags = { Name = "nt-${local.env}-vpc-endpoints" }
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_app" {
  security_group_id            = aws_security_group.vpc_endpoints.id
  description                  = "HTTPS from application tasks"
  referenced_security_group_id = module.network.app_security_group_id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
}

# --------------------------------------------------------------------------
# The endpoints.
#
# private_dns_enabled = true is what makes this invisible to the application:
# `bedrock-runtime.eu-west-2.amazonaws.com` resolves inside the VPC to these
# ENIs, so no SDK configuration, no custom endpoint URL, no code change. It
# depends on the VPC having DNS support and DNS hostnames — modules/network
# sets both true, and turning either off breaks every endpoint here at once.
#
# ⚠ THE FAILURE MODE TO RECOGNISE. If an endpoint is misconfigured or its
# policy denies a call, the SDK does NOT fall through to the public endpoint —
# private DNS has already replaced the address. The symptom is a connection
# timeout or an AccessDenied that names no obvious cause, from a task that
# worked yesterday. Diagnosis order: (1) is the ENI in the task's subnet,
# (2) does the endpoint SG admit the app SG, (3) does the endpoint POLICY
# below allow the call. Do not start by suspecting IAM.
# --------------------------------------------------------------------------
resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_endpoints

  vpc_id            = module.network.vpc_id
  service_name      = "com.amazonaws.${local.region}.${each.key}"
  vpc_endpoint_type = "Interface"

  # One ENI per private subnet. This is the $168/month, and it is also the
  # reason a single-AZ event does not take model inference down with it.
  subnet_ids          = module.network.private_subnet_ids
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  # The enforcement point a public endpoint cannot give us: this endpoint
  # serves principals in OUR account and nobody else's. In an account shared
  # with three unrelated products (D36) that is narrower than it looks — it
  # does not separate us from them — but it does mean an endpoint left
  # reachable by a future peering or a mistaken route cannot be used by an
  # outside principal at all.
  #
  # Deliberately NOT scoped to role/nt-* here, unlike the bucket and key
  # policies. Those guard DATA. This guards a network path, and the paths are
  # also used by AWS-side integrations (ECR pulls on behalf of the ECS agent)
  # whose principal ARN shape is not ours to predict. Getting that wrong fails
  # at task start, not at plan.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowThisAccountOnly"
      Effect    = "Allow"
      Principal = "*"
      Action    = "*"
      Resource  = "*"
      Condition = {
        StringEquals = { "aws:PrincipalAccount" = local.account_id }
      }
    }]
  })

  tags = {
    Name      = "nt-${local.env}-${replace(each.key, ".", "-")}"
    Component = "network"
    Purpose   = each.value
  }
}

output "interface_endpoint_ids" {
  value       = { for k, v in aws_vpc_endpoint.interface : k => v.id }
  description = "Seven interface endpoints at ~$168/mo fixed. If this map shrinks, read the cost banner in this file first."
}
