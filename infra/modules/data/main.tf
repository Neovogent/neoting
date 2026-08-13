# --------------------------------------------------------------------------
# RDS PostgreSQL + ElastiCache Redis (Kickoff 3.6, D23).
#
# Same shape in every environment, different size. The variables that matter
# are the ones that decide whether the environment survives an AZ failure and
# whether `terraform destroy` can take the data with it - db_multi_az,
# db_deletion_protection, db_skip_final_snapshot. Their defaults here are the
# staging answers (G1 disposable, G2 synthetic data) and every one of them is
# wrong for prod.
# --------------------------------------------------------------------------

locals {
  pg_major = split(".", var.db_engine_version)[0]

  # Derived rather than passed so a major upgrade cannot leave the parameter
  # group pointing at the previous family, which RDS reports as a vague
  # incompatibility at apply.
  db_parameter_group_family = coalesce(var.db_parameter_group_family, "postgres${local.pg_major}")

  redis_secret_name = coalesce(var.redis_secret_name, "/neoting/${var.env}/redis/connection")
}

resource "aws_db_subnet_group" "main" {
  name       = "nt-${var.env}"
  subnet_ids = var.subnet_ids
}

resource "aws_db_parameter_group" "main" {
  name   = "nt-${var.env}-pg${local.pg_major}"
  family = local.db_parameter_group_family

  # TLS is not optional, even in staging.
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  # Governance §5.1: any query over 100 ms p95 gets an EXPLAIN ANALYZE and an
  # issue. This is what makes that rule enforceable rather than aspirational.
  parameter {
    name  = "log_min_duration_statement"
    value = var.db_log_min_duration_statement
  }

  parameter {
    name  = "log_statement"
    value = "ddl"
  }
}

resource "aws_db_instance" "main" {
  identifier     = "nt-${var.env}"
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  db_name  = var.db_name
  username = var.db_master_username # owns the schema; the app does NOT use this account (see variables.tf)

  # AWS generates and rotates the master password into Secrets Manager, so it
  # never appears in Terraform state or in anyone's shell history.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = var.security_group_ids
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  backup_retention_period = var.db_backup_retention_period
  backup_window           = var.db_backup_window
  maintenance_window      = var.db_maintenance_window
  copy_tags_to_snapshot   = true

  performance_insights_enabled          = true
  performance_insights_retention_period = var.db_performance_insights_retention_period
  enabled_cloudwatch_logs_exports       = ["postgresql"]
  auto_minor_version_upgrade            = true
  apply_immediately                     = var.db_apply_immediately

  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = var.db_skip_final_snapshot
  final_snapshot_identifier = var.db_final_snapshot_identifier

  tags = { DataClass = "customer-document" }
}

# --------------------------------------------------------------------------
# Redis — BullMQ queues + cache.
# --------------------------------------------------------------------------

resource "aws_elasticache_subnet_group" "main" {
  name       = "nt-${var.env}"
  subnet_ids = var.subnet_ids
}

resource "random_password" "redis_auth" {
  length  = var.redis_auth_token_length
  special = false # ElastiCache auth tokens reject several punctuation characters
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "nt-${var.env}-redis"
  description          = "Neoting ${var.env} - BullMQ + cache"

  engine               = "redis"
  engine_version       = var.redis_engine_version
  node_type            = var.redis_node_type
  num_cache_clusters   = var.redis_num_cache_clusters
  parameter_group_name = var.redis_parameter_group_name
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = var.security_group_ids

  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result

  automatic_failover_enabled = var.redis_automatic_failover_enabled
  snapshot_retention_limit   = var.redis_snapshot_retention_limit
  maintenance_window         = var.redis_maintenance_window
  apply_immediately          = var.redis_apply_immediately
}

# The connection secret lives with the cluster rather than with the rest of the
# application secrets, because the auth token is generated here and this is the
# only place it can be written without passing a sensitive value up through the
# root module and back down again.
resource "aws_secretsmanager_secret" "redis" {
  name        = local.redis_secret_name
  description = "Redis auth token and endpoint for BullMQ + cache"

  # Encrypted under the Neoting CMK rather than the AWS-managed
  # `aws/secretsmanager` default, so it sits inside the same `role/nt-*`
  # explicit-Deny boundary as every other Neoting secret (D36). Predates the
  # secrets CMK, which is why it was on the default until now.
  kms_key_id = var.secrets_kms_key_arn
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id = aws_secretsmanager_secret.redis.id

  secret_string = jsonencode({
    host       = aws_elasticache_replication_group.main.primary_endpoint_address
    port       = 6379
    auth_token = random_password.redis_auth.result
    tls        = true
  })
}
