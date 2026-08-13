output "db_instance_identifier" {
  value       = aws_db_instance.main.identifier
  description = "The DBInstanceIdentifier dimension every RDS alarm and dashboard widget needs."
}

output "db_endpoint" {
  value       = aws_db_instance.main.endpoint
  description = "host:port."
}

output "db_address" {
  value       = aws_db_instance.main.address
  description = "Host only. What a connection string wants."
}

output "db_port" {
  value       = aws_db_instance.main.port
  description = "5432 unless someone had a reason."
}

output "db_name" {
  value       = aws_db_instance.main.db_name
  description = "Initial database name."
}

output "db_arn" {
  value       = aws_db_instance.main.arn
  description = "For IAM resource scoping."
}

output "db_master_user_secret_arn" {
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
  description = <<-EOT
    The AWS-managed master credential. Read by migrations only - the runtime
    application must connect as the non-owning role, or RLS is decorative
    (Governance 5.2).
  EOT
}

output "redis_replication_group_id" {
  value       = aws_elasticache_replication_group.main.replication_group_id
  description = "For alarms keyed on the replication group."
}

output "redis_primary_endpoint_address" {
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
  description = "Primary node hostname. TLS is mandatory on this endpoint."
}

output "redis_member_clusters" {
  value       = aws_elasticache_replication_group.main.member_clusters
  description = <<-EOT
    Node IDs. Alarms use the CacheClusterId dimension, which is a NODE, not the
    replication group. A caller running a single node should wrap this in one()
    rather than [0]: if someone scales the group, one() fails at plan time and
    forces a revisit instead of silently alarming on one node out of three and
    calling that monitoring.
  EOT
}

output "redis_secret_arn" {
  value       = aws_secretsmanager_secret.redis.arn
  description = "JSON: host, port, auth_token, tls. Task definitions pull auth_token out of it with a :auth_token:: suffix."
}

output "redis_secret_name" {
  value       = aws_secretsmanager_secret.redis.name
  description = "/neoting/<env>/redis/connection."
}
