variable "env" {
  type        = string
  description = "Environment slug. Drives every nt-<env>-* name; the role/nt-* naming contract (D36) depends on it."

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.env))
    error_message = "env must be lowercase alphanumeric with hyphens - it lands in resource names and IAM ARNs."
  }
}

variable "account_id" {
  type        = string
  description = "AWS account ID. Used as the aws:SourceAccount confused-deputy condition on the flow-log role."
}

variable "region" {
  type        = string
  description = "Region, for the S3 gateway endpoint service name. eu-west-2 only (D30 UK residency)."
}

variable "vpc_cidr" {
  type        = string
  description = "VPC CIDR. staging 10.20.0.0/16, prod 10.30.0.0/16 - NEVER overlap, a peering or a TGW later is impossible if they do."
}

variable "azs" {
  type        = list(string)
  description = "Availability zones. One public and one data subnet per AZ; one private subnet per AZ when the private tier is on."

  validation {
    condition     = length(var.azs) > 0 && length(var.azs) <= 6
    error_message = "azs must name between one and six availability zones."
  }
}

# --------------------------------------------------------------------------
# THE COST/RISK DIAL THAT ACTUALLY DIFFERS BETWEEN ENVIRONMENTS.
#
# staging runs with NO NAT gateway (~$36/mo fixed + data processing, runbook
# Appendix B.3). Fargate tasks sit in public subnets with a public IP and
# security groups that permit no inbound traffic; the data tier has no route
# off the VPC at all. That is defensible ONLY because staging is
# synthetic-data-only (G2).
#
# Prod sets enable_nat_gateway = true, which turns the private tier on
# implicitly (a NAT with nothing behind it is $36/mo of decoration) and gives
# tasks a stable egress address with no public IP of their own.
# --------------------------------------------------------------------------
variable "enable_nat_gateway" {
  type        = bool
  default     = false
  description = "Create NAT gateways and default-route the private tier through them. Implies enable_private_subnets."
}

variable "single_nat_gateway" {
  type        = bool
  default     = false
  description = "One NAT for the whole VPC instead of one per AZ. Cheaper, but the NAT's AZ becomes a single point of failure for all egress - acceptable in a pre-production environment, not in prod."
}

variable "enable_private_subnets" {
  type        = bool
  default     = false
  description = "Create the private application tier. Forced on when enable_nat_gateway is true. With NAT off the tier exists but has no default route, which is a legitimate fully-isolated shape."
}

variable "flow_log_traffic_type" {
  type        = string
  default     = "REJECT"
  description = "REJECT only: accepts are noise at this scale and cost money per GB ingested. Prod may want ALL once there is a budget line for it."

  validation {
    condition     = contains(["ACCEPT", "REJECT", "ALL"], var.flow_log_traffic_type)
    error_message = "flow_log_traffic_type must be ACCEPT, REJECT or ALL."
  }
}

variable "flow_log_retention_days" {
  type        = number
  default     = 30
  description = "Governance 12.2: application logs and traces are kept 30 days."
}

variable "alb_ingress_prefix_list_id" {
  type        = string
  description = <<-EOT
    Managed prefix list allowed to reach the ALB on 443. Passed in rather than
    read here because the caller already reads it for the edge (CloudFront), and
    two data sources for the same list is two things to keep in step.

    QUOTA WARNING: a managed prefix list consumes its max_entries - 55 for
    cloudfront/origin-facing - against the default 60 rules per security group,
    not one. The ALB security group therefore has room for almost nothing else.
  EOT
}

variable "app_port" {
  type        = number
  default     = 3000
  description = "Container port the ALB forwards to. Both halves of the alb <-> app security-group pair are derived from it, so they cannot drift apart."
}
