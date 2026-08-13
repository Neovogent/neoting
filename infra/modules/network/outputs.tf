output "vpc_id" {
  value       = aws_vpc.main.id
  description = "VPC ID. Target groups and any workload security group need it."
}

output "vpc_cidr_block" {
  value       = aws_vpc.main.cidr_block
  description = "Echoed back so callers can write DNS-resolver egress rules (VPC base + 2) without restating the CIDR."
}

output "public_subnet_ids" {
  value       = aws_subnet.public[*].id
  description = "Public tier, one per AZ. The ALB and (in a NAT-less environment) the Fargate tasks live here."
}

output "private_subnet_ids" {
  value       = aws_subnet.private[*].id
  description = "Private tier, one per AZ. Empty list when the tier is off - a caller can therefore write coalescelist(private, public) and get the right answer in both environments."
}

output "data_subnet_ids" {
  value       = aws_subnet.data[*].id
  description = "Data tier, one per AZ. RDS and ElastiCache subnet groups only."
}

output "public_route_table_id" {
  value       = aws_route_table.public.id
  description = "For any additional route or endpoint association the caller needs."
}

output "data_route_table_id" {
  value       = aws_route_table.data.id
  description = "For any additional route or endpoint association the caller needs."
}

output "private_route_table_ids" {
  value       = aws_route_table.private[*].id
  description = "One per private subnet, empty when the tier is off."
}

output "nat_gateway_public_ips" {
  value       = aws_eip.nat[*].public_ip
  description = "Stable egress addresses. Empty in a NAT-less environment - that is the tell that a third party's IP allowlist cannot be satisfied from here."
}

output "alb_security_group_id" {
  value       = aws_security_group.alb.id
  description = "Attach the load balancer to this."
}

output "app_security_group_id" {
  value       = aws_security_group.app.id
  description = "Attach application tasks to this."
}

output "data_security_group_id" {
  value       = aws_security_group.data.id
  description = "Attach RDS and ElastiCache to this. Also the attachment point for any extra ingress a bolted-on workload needs (see security-groups.tf)."
}

output "flow_log_group_name" {
  value       = aws_cloudwatch_log_group.flow_logs.name
  description = "Metric filters over rejected traffic attach here."
}

output "flow_log_group_arn" {
  value       = aws_cloudwatch_log_group.flow_logs.arn
  description = "Metric filters over rejected traffic attach here."
}
