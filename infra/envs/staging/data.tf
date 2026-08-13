# --------------------------------------------------------------------------
# RDS PostgreSQL 16 + ElastiCache Redis (Kickoff 3.6, D23)
# --------------------------------------------------------------------------

resource "aws_db_subnet_group" "main" {
  name       = "nt-${local.env}"
  subnet_ids = aws_subnet.data[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = "nt-${local.env}-pg16"
  family = "postgres16"

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
    value = "100"
  }

  parameter {
    name  = "log_statement"
    value = "ddl"
  }
}

resource "aws_db_instance" "main" {
  identifier     = "nt-${local.env}"
  engine         = "postgres"
  engine_version = "16.14"
  instance_class = "db.t4g.small" # ~$26/mo; prod goes m7g and Multi-AZ

  allocated_storage     = 50
  max_allocated_storage = 200 # storage autoscaling, so a runaway import doesn't wedge staging
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.docs.arn

  db_name  = "neoting"
  username = "nt_migrator" # owns the schema; the app does NOT use this account (see note below)

  # AWS generates and rotates the master password into Secrets Manager, so it
  # never appears in Terraform state or in anyone's shell history.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.data.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false
  multi_az               = false # prod = true

  # Governance §17 / Kickoff 3.6: PITR 35 days is not a staging luxury —
  # it is how we prove the restore drill works before prod carries real data.
  backup_retention_period = 35
  backup_window           = "02:00-03:00" # UTC, outside UK working hours
  maintenance_window      = "sun:03:30-sun:04:30"
  copy_tags_to_snapshot   = true

  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  enabled_cloudwatch_logs_exports       = ["postgresql"]
  auto_minor_version_upgrade            = true
  apply_immediately                     = true

  # Staging is disposable by design (G1) and holds synthetic data only (G2).
  # Prod flips both of these.
  deletion_protection = false
  skip_final_snapshot = true

  tags = { DataClass = "customer-document" }
}

# --------------------------------------------------------------------------
# ⚠ RLS depends on a database role that Terraform cannot create.
#
# Postgres RLS is bypassed by the table owner. If the application connects as
# the schema owner, every policy in prisma/ is decorative and the tenancy
# guarantee (Governance §5.2) does not exist. The migration role above owns the
# schema; the application must connect as a separate, non-owning role:
#
#   CREATE ROLE nt_app LOGIN PASSWORD '...';
#   GRANT USAGE ON SCHEMA public TO nt_app;
#   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nt_app;
#   ALTER DEFAULT PRIVILEGES IN SCHEMA public
#     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nt_app;
#   ALTER TABLE <each tenant table> FORCE ROW LEVEL SECURITY;
#
# This belongs in the first Prisma migration, and the CI tenancy suite
# (Governance §15.4) must assert that nt_app cannot bypass RLS.
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# Redis — BullMQ queues + cache.
# Cluster mode DISABLED on purpose: BullMQ's key patterns need hash-tag design
# to work in cluster mode, and that is complexity nobody has asked for yet.
# --------------------------------------------------------------------------

resource "aws_elasticache_subnet_group" "main" {
  name       = "nt-${local.env}"
  subnet_ids = aws_subnet.data[*].id
}

resource "random_password" "redis_auth" {
  length  = 48
  special = false # ElastiCache auth tokens reject several punctuation characters
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "nt-${local.env}-redis"
  description          = "Neoting ${local.env} - BullMQ + cache"

  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "cache.t4g.micro"
  num_cache_clusters   = 1
  parameter_group_name = "default.redis7"
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.data.id]

  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.docs.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result

  automatic_failover_enabled = false # single node in staging; prod = true with 2+
  snapshot_retention_limit   = 1
  maintenance_window         = "sun:04:30-sun:05:30"
  apply_immediately          = true
}

resource "aws_secretsmanager_secret" "redis" {
  name        = "/neoting/${local.env}/redis/connection"
  description = "Redis auth token and endpoint for BullMQ + cache"
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

output "db_endpoint" { value = aws_db_instance.main.endpoint }
output "db_master_secret_arn" { value = aws_db_instance.main.master_user_secret[0].secret_arn }
output "redis_secret_arn" { value = aws_secretsmanager_secret.redis.arn }
