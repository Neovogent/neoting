# ==========================================================================
# ONE-SHOT STATE MOVES — module extraction, 14 Aug 2026.
#
# WHAT THIS FILE IS. The VPC, the document buckets and the database were
# applied while this root was flat. Extracting them into infra/modules/*
# changes their Terraform ADDRESSES but not the AWS resources behind them.
# Without a `moved` block, Terraform reads "aws_vpc.main is gone, and
# module.network.aws_vpc.main is new" and plans a destroy-and-create. On an RDS
# instance or a KMS key that is not a mistake you recover from by re-running.
#
# HOW TO CHECK IT WORKED. `terraform plan` after this refactor must report
#
#     Plan: 181 to add, 6 to change, 1 to destroy
#
# with the single destroy being the CloudFront-prefix-list swap on
# module.network.aws_vpc_security_group_ingress_rule.alb_https, which was
# already pending before the extraction and is unrelated to it. ANY other
# destroy or replacement means a `moved` block below is wrong. Fix the block.
# Do not apply the plan and do not "accept" it.
#
# WHY ONLY THESE ~37 RESOURCES. Roughly 70 addresses were in state at the time
# of the refactor; the rest of the configuration is written but not yet
# applied, so its addresses could be changed freely and needed no move. Every
# block below corresponds to a line that `terraform state list` printed on
# 14 Aug 2026 — nothing here is speculative or defensive.
#
# COUNT AND for_each RESOURCES MOVE WHOLE. `moved { from = aws_subnet.public
# to = module.network.aws_subnet.public }` carries [0], [1] and [2] with it.
# Per-instance blocks would be noise and an opportunity to mistype an index.
#
# WHEN THIS FILE CAN BE DELETED. After the move has been APPLIED against the
# staging state (not merely planned) and a subsequent `terraform plan` is clean
# of any state-move activity. `moved` blocks are consumed at apply time and are
# inert afterwards; leaving them costs nothing but noise, and deleting them
# before that apply re-arms the destroy this file exists to prevent.
#
# ⚠ DO NOT COPY THIS FILE INTO envs/prod/. Prod has never been applied flat,
# so it has nothing to move, and a `moved` block whose source address never
# existed there is at best dead weight.
# ==========================================================================

# --------------------------------------------------------------------------
# → module.network
# --------------------------------------------------------------------------
moved {
  from = aws_vpc.main
  to   = module.network.aws_vpc.main
}

moved {
  from = aws_internet_gateway.main
  to   = module.network.aws_internet_gateway.main
}

moved {
  from = aws_subnet.public
  to   = module.network.aws_subnet.public
}

moved {
  from = aws_subnet.data
  to   = module.network.aws_subnet.data
}

moved {
  from = aws_route_table.public
  to   = module.network.aws_route_table.public
}

moved {
  from = aws_route_table.data
  to   = module.network.aws_route_table.data
}

moved {
  from = aws_route_table_association.public
  to   = module.network.aws_route_table_association.public
}

moved {
  from = aws_route_table_association.data
  to   = module.network.aws_route_table_association.data
}

moved {
  from = aws_vpc_endpoint.s3
  to   = module.network.aws_vpc_endpoint.s3
}

moved {
  from = aws_flow_log.main
  to   = module.network.aws_flow_log.main
}

moved {
  from = aws_cloudwatch_log_group.flow_logs
  to   = module.network.aws_cloudwatch_log_group.flow_logs
}

moved {
  from = aws_iam_role.flow_logs
  to   = module.network.aws_iam_role.flow_logs
}

moved {
  from = aws_iam_role_policy.flow_logs
  to   = module.network.aws_iam_role_policy.flow_logs
}

moved {
  from = aws_security_group.alb
  to   = module.network.aws_security_group.alb
}

moved {
  from = aws_security_group.app
  to   = module.network.aws_security_group.app
}

moved {
  from = aws_security_group.data
  to   = module.network.aws_security_group.data
}

# The one resource that is both moved AND replaced in the same plan. Terraform
# applies the move to state first and then diffs at the new address, so this is
# reported as a replacement of the MODULE address. That is expected: the rule
# is swapping cidr_ipv4 0.0.0.0/0 for the CloudFront prefix list, and
# prefix_list_id forces a new rule.
moved {
  from = aws_vpc_security_group_ingress_rule.alb_https
  to   = module.network.aws_vpc_security_group_ingress_rule.alb_https
}

moved {
  from = aws_vpc_security_group_egress_rule.alb_to_app
  to   = module.network.aws_vpc_security_group_egress_rule.alb_to_app
}

moved {
  from = aws_vpc_security_group_ingress_rule.app_from_alb
  to   = module.network.aws_vpc_security_group_ingress_rule.app_from_alb
}

moved {
  from = aws_vpc_security_group_egress_rule.app_all
  to   = module.network.aws_vpc_security_group_egress_rule.app_all
}

moved {
  from = aws_vpc_security_group_ingress_rule.postgres_from_app
  to   = module.network.aws_vpc_security_group_ingress_rule.postgres_from_app
}

moved {
  from = aws_vpc_security_group_ingress_rule.redis_from_app
  to   = module.network.aws_vpc_security_group_ingress_rule.redis_from_app
}

# --------------------------------------------------------------------------
# → module.storage
#
# ⚠ THE KMS KEY IS THE ONE THAT MUST NOT GO WRONG. Destroying and recreating
# aws_kms_key.docs would leave every object in the docs and exports buckets
# permanently unreadable — ciphertext without its key is bytes. There is no
# restore path, not even from a versioned bucket.
# --------------------------------------------------------------------------
moved {
  from = aws_kms_key.docs
  to   = module.storage.aws_kms_key.docs
}

moved {
  from = aws_kms_alias.docs
  to   = module.storage.aws_kms_alias.docs
}

moved {
  from = aws_s3_bucket.this
  to   = module.storage.aws_s3_bucket.this
}

moved {
  from = aws_s3_bucket_versioning.this
  to   = module.storage.aws_s3_bucket_versioning.this
}

moved {
  from = aws_s3_bucket_public_access_block.this
  to   = module.storage.aws_s3_bucket_public_access_block.this
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.this
  to   = module.storage.aws_s3_bucket_server_side_encryption_configuration.this
}

moved {
  from = aws_s3_bucket_policy.this
  to   = module.storage.aws_s3_bucket_policy.this
}

# --------------------------------------------------------------------------
# → module.data
#
# ⚠ SECOND UNRECOVERABLE ONE. aws_db_instance.main carries
# skip_final_snapshot = true (correct for a disposable staging environment,
# G1/G2) — a destroy here takes the database with it and leaves NO snapshot.
# --------------------------------------------------------------------------
moved {
  from = aws_db_subnet_group.main
  to   = module.data.aws_db_subnet_group.main
}

moved {
  from = aws_db_parameter_group.main
  to   = module.data.aws_db_parameter_group.main
}

moved {
  from = aws_db_instance.main
  to   = module.data.aws_db_instance.main
}

moved {
  from = aws_elasticache_subnet_group.main
  to   = module.data.aws_elasticache_subnet_group.main
}

# The auth token moves with the cluster rather than staying in the root. It is
# a random_password, so a recreate would silently rotate the Redis credential
# and leave every running task authenticating with the old one.
moved {
  from = random_password.redis_auth
  to   = module.data.random_password.redis_auth
}

moved {
  from = aws_elasticache_replication_group.main
  to   = module.data.aws_elasticache_replication_group.main
}

moved {
  from = aws_secretsmanager_secret.redis
  to   = module.data.aws_secretsmanager_secret.redis
}

moved {
  from = aws_secretsmanager_secret_version.redis
  to   = module.data.aws_secretsmanager_secret_version.redis
}
