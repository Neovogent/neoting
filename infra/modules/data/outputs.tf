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
    Node IDs, read back from the created group. Alarms use the CacheClusterId
    dimension, which is a NODE, not the replication group. A caller running a
    single node should wrap this in one() rather than [0]: if someone scales the
    group, one() fails at plan time and forces a revisit instead of silently
    alarming on one node out of three and calling that monitoring.

    ⚠ UNUSABLE AS A for_each KEY ON AN ENVIRONMENT THAT DOES NOT EXIST YET.
    This is a resource attribute, so on a first apply it is unknown at plan
    time — and a for_each over it yields NO instances rather than an error.
    The alarms simply are not in the plan, the apply succeeds, and the
    environment comes up with no Redis monitoring at all. Measured on the first
    envs/prod plan, 15 Aug 2026. Use redis_member_cluster_ids_expected below for
    anything that has to exist on the first apply.
  EOT
}

output "redis_member_cluster_ids_expected" {
  # Derived entirely from INPUTS, so it is known at plan time on a brand-new
  # environment where member_clusters is not. ElastiCache names the nodes of a
  # cluster-mode-disabled replication group `<group-id>-001`, `-002`, ... in
  # order, and that naming is stable for the life of the group.
  value = [
    for i in range(1, var.redis_num_cache_clusters + 1) :
    format("nt-%s-redis-%03d", var.env, i)
  ]

  description = <<-EOT
    The node IDs this group WILL have, computed from the inputs rather than read
    back from the resource. Use this for alarm for_each so the alarms exist on
    the first apply; use redis_member_clusters when you need what AWS actually
    created.

    ⚠ It mirrors the naming convention rather than observing it. If the
    replication_group_id in main.tf ever stops following the nt-<env>-redis
    pattern, this silently produces node IDs that match nothing, and the alarms
    keyed on them go to INSUFFICIENT_DATA — monitoring that looks present and
    measures nothing. The two are asserted against each other after apply; see
    the output postcondition in envs/prod/observability.tf.
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
