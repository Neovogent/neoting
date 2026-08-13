# --------------------------------------------------------------------------
# RDS PostgreSQL 16 + ElastiCache Redis (Kickoff 3.6, D23) —
# infra/modules/data.
#
# Every value below is the STAGING answer. The module's defaults happen to be
# the same values, but they are restated here rather than relied on: the point
# of a shared module is that reading this file tells you what staging IS,
# without opening the module to find out what it defaulted to. Prod's call will
# differ on multi_az, deletion_protection, skip_final_snapshot and instance
# class, and a reviewer needs to be able to diff the two call sites directly.
# --------------------------------------------------------------------------

module "data" {
  source = "../../modules/data"

  env                = local.env
  subnet_ids         = module.network.data_subnet_ids
  security_group_ids = [module.network.data_security_group_id]

  kms_key_arn         = module.storage.kms_key_arn
  secrets_kms_key_arn = aws_kms_key.secrets.arn

  db_engine_version        = "16.14"
  db_instance_class        = "db.t4g.small" # ~$26/mo; prod goes m7g and Multi-AZ
  db_allocated_storage     = 50
  db_max_allocated_storage = 200 # storage autoscaling, so a runaway import doesn't wedge staging

  db_multi_az = false # prod = true

  # Governance §17 / Kickoff 3.6: PITR 35 days is not a staging luxury —
  # it is how we prove the restore drill works before prod carries real data.
  db_backup_retention_period = 35
  db_backup_window           = "02:00-03:00" # UTC, outside UK working hours
  db_maintenance_window      = "sun:03:30-sun:04:30"

  db_performance_insights_retention_period = 7
  db_apply_immediately                     = true

  # Staging is disposable by design (G1) and holds synthetic data only (G2).
  # Prod flips both of these.
  db_deletion_protection = false
  db_skip_final_snapshot = true

  # Cluster mode DISABLED on purpose: BullMQ's key patterns need hash-tag
  # design to work in cluster mode, and that is complexity nobody has asked
  # for yet.
  redis_engine_version             = "7.1"
  redis_node_type                  = "cache.t4g.micro"
  redis_num_cache_clusters         = 1
  redis_automatic_failover_enabled = false # single node in staging; prod = true with 2+
  redis_parameter_group_name       = "default.redis7"
  redis_snapshot_retention_limit   = 1
  redis_maintenance_window         = "sun:04:30-sun:05:30"
  redis_apply_immediately          = true
}

# --------------------------------------------------------------------------
# ⚠ RLS depends on a database role that Terraform cannot create.
#
# Postgres RLS is bypassed by the table owner. If the application connects as
# the schema owner, every policy in prisma/ is decorative and the tenancy
# guarantee (Governance §5.2) does not exist. The module's master username
# (nt_migrator) owns the schema; the application must connect as a separate,
# non-owning role:
#
#   CREATE ROLE nt_app LOGIN PASSWORD '...';
#   GRANT USAGE ON SCHEMA public TO nt_app;
#   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nt_app;
#   ALTER DEFAULT PRIVILEGES IN SCHEMA public
#     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nt_app;
#   ALTER TABLE <each tenant table> FORCE ROW LEVEL SECURITY;
#
# This belongs in the first Prisma migration, and the CI tenancy suite
# (Governance §15.4) must assert that nt_app cannot bypass RLS. The credential
# it uses is in db-app-role.tf.
# --------------------------------------------------------------------------

output "db_endpoint" { value = module.data.db_endpoint }
output "db_master_secret_arn" { value = module.data.db_master_user_secret_arn }
output "redis_secret_arn" { value = module.data.redis_secret_arn }
