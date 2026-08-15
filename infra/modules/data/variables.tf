variable "env" {
  type        = string
  description = "Environment slug. Drives the instance identifier, the subnet and parameter group names, and the secret path."
}

variable "subnet_ids" {
  type        = list(string)
  description = "Data-tier subnets. These must be the tier with no route off the VPC - passing the public tier here is the single fastest way to expose a database."

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "RDS and ElastiCache subnet groups need at least two subnets in different AZs, even when the instance is single-AZ."
  }
}

variable "security_group_ids" {
  type        = list(string)
  description = "Security groups for both RDS and ElastiCache. The data-tier group, which admits only the application tier."
}

variable "kms_key_arn" {
  type        = string
  description = "CMK for storage-at-rest on RDS and ElastiCache. The documents key, so that everything holding customer data sits behind the same role/nt-* deny guard (D36)."
}

variable "secrets_kms_key_arn" {
  type        = string
  description = <<-EOT
    CMK for the Redis connection secret. Separate from kms_key_arn because
    credentials and documents are different data classes with different blast
    radii - a grant that lets a task read documents should not also let it
    decrypt every secret in the environment.
  EOT
}

variable "master_user_secret_kms_key_arn" {
  type        = string
  default     = null
  description = <<-EOT
    CMK for the RDS-MANAGED master user password secret. null (the default)
    leaves it under the AWS-managed `aws/secretsmanager` key, which is OUTSIDE
    the role/nt-* explicit-Deny boundary that D36's compensating-control story
    rests on.

    ⚠ READ BOTH OF THESE BEFORE SETTING IT. They are properties of the AWS
    API, not of this module, and both were verified against the RDS docs and
    the live account on 15 Aug 2026.

    1. THE KEY IS IMMUTABLE AFTER CREATION. The RDS User Guide states it four
       times over: "After RDS is managing the database credentials for a DB
       instance, you can't change the KMS key that is used to encrypt the
       secret." So this is a CREATE-TIME decision. Getting it wrong is not a
       later `terraform apply` away - the recovery is to modify the instance
       to turn credential management OFF and then ON again, which mints a new
       secret at a new ARN and breaks every task definition referencing the
       old one. staging (nt-staging) is already created on the AWS-managed
       key and cannot be moved by editing this value.

    2. THE KEY POLICY MUST EXEMPT AWS SERVICES, OR ROTATION BREAKS QUIETLY.
       Creation works with the caller's own permissions - the docs require
       kms:DescribeKey, kms:Decrypt, kms:GenerateDataKey and kms:CreateGrant
       on the CALLING principal, and RDS then holds a grant. But RDS rotates
       this secret every 7 days by default, and at rotation the request comes
       from the RDS service principal, where aws:PrincipalArn does not match
       role/nt-*. An absolute `StringNotLike` deny therefore catches it: a
       missing condition key makes StringNotLike true, and an explicit deny
       in the key policy overrides the grant.

       The failure is NOT the apply. The apply succeeds, the secret is
       created, and seven days later SecretStatus flips to `impaired` - the
       credential still reads, it just silently stops rotating. That is the
       worst shape a security control can fail in.

       A key used here needs the same `BoolIfExists aws:PrincipalIsAWSService
       = false` carve-out that modules/storage/policies/bucket.json.tftpl
       already has. envs/prod/policies/kms-secrets.json.tftpl deliberately
       DROPS that carve-out, on reasoning that is correct for every secret we
       write ourselves and does not hold for this one - it is the single case
       where a service really does encrypt a secret on its own behalf.
  EOT
}

# --------------------------------------------------------------------------
# POSTGRES.
#
# The defaults below are the STAGING shape: single-AZ, disposable (G1),
# synthetic data only (G2). Every one of them is wrong for prod, which is why
# they are variables and not locals.
# --------------------------------------------------------------------------
variable "db_engine_version" {
  type        = string
  default     = "16.14"
  description = "Postgres version. The major is parsed out of this for the parameter-group family, so a major upgrade is one edit."

  validation {
    condition     = can(regex("^[0-9]+(\\.[0-9]+)?$", var.db_engine_version))
    error_message = "db_engine_version must be <major> or <major>.<minor> - the major is parsed out of it for the parameter-group family."
  }
}

variable "db_instance_class" {
  type        = string
  default     = "db.t4g.small"
  description = "~$26/mo on t4g.small. Prod goes m7g: burstable credits are a latency cliff you discover under load, not in a plan."
}

variable "db_allocated_storage" {
  type        = number
  default     = 50
  description = "GiB. gp3 baseline."
}

variable "db_max_allocated_storage" {
  type        = number
  default     = 200
  description = "GiB. Storage autoscaling, so a runaway import does not wedge the environment."
}

variable "db_multi_az" {
  type        = bool
  default     = false
  description = "false in staging, true in prod. Roughly doubles the instance cost and is the difference between an AZ failure being a page and being an outage."
}

variable "db_deletion_protection" {
  type        = bool
  default     = false
  description = "false in staging because it is disposable by design (G1) and `terraform destroy` must actually complete. true in prod, always."
}

variable "db_skip_final_snapshot" {
  type        = bool
  default     = true
  description = "true in staging (synthetic data, G2). true in prod means a destroy is unrecoverable."
}

variable "db_final_snapshot_identifier" {
  type        = string
  default     = null
  description = "Required by RDS when skip_final_snapshot is false. Must be unique in the account, so prod should suffix it with a timestamp at the call site."
}

variable "db_backup_retention_period" {
  type        = number
  default     = 35
  description = <<-EOT
    Days of PITR. 35 - the maximum - even in staging, and that is deliberate:
    Governance 17 / Kickoff 3.6 make the restore drill a thing we prove BEFORE
    prod carries real data. A staging retention of 1 would make the drill
    unprovable exactly where it is free to run.
  EOT

  validation {
    condition     = var.db_backup_retention_period >= 1 && var.db_backup_retention_period <= 35
    error_message = "Backup retention must be 1-35 days. Zero disables backups, which no Neoting environment may do."
  }
}

variable "db_backup_window" {
  type        = string
  default     = "02:00-03:00"
  description = "UTC, outside UK working hours."
}

variable "db_maintenance_window" {
  type        = string
  default     = "sun:03:30-sun:04:30"
  description = "UTC. Must not overlap the backup window."
}

variable "db_performance_insights_retention_period" {
  type        = number
  default     = 7
  description = "7 days is the free tier. Anything longer is billed per vCPU per month."
}

variable "db_apply_immediately" {
  type        = bool
  default     = true
  description = "true in staging so a change is testable in the same session. Prod should leave modifications to the maintenance window."
}

variable "db_name" {
  type        = string
  default     = "neoting"
  description = "Initial database name."
}

variable "db_master_username" {
  type        = string
  default     = "nt_migrator"
  description = <<-EOT
    ⚠ THIS ROLE OWNS THE SCHEMA, AND THE APPLICATION MUST NOT USE IT.

    Postgres RLS is bypassed by the table owner. If the application connects as
    the schema owner, every policy in prisma/ is decorative and the tenancy
    guarantee (Governance 5.2) does not exist. The app connects as a separate
    non-owning role created by migration - see db-app-role.tf in the calling
    root - and the CI tenancy suite (Governance 15.4) asserts it cannot bypass
    RLS.
  EOT
}

variable "db_parameter_group_family" {
  type        = string
  default     = null
  description = "Overrides the family derived from db_engine_version. Leave null unless AWS names a family that does not follow postgres<major>."
}

variable "db_log_min_duration_statement" {
  type        = string
  default     = "100"
  description = "Milliseconds. Governance 5.1: any query over 100 ms p95 gets an EXPLAIN ANALYZE and an issue. This is what makes that rule enforceable rather than aspirational."
}

# --------------------------------------------------------------------------
# REDIS — BullMQ queues + cache.
#
# Cluster mode DISABLED on purpose in every environment: BullMQ's key patterns
# need hash-tag design to work in cluster mode, and that is complexity nobody
# has asked for yet. What changes between environments is node size and whether
# there is a replica to fail over to.
# --------------------------------------------------------------------------
variable "redis_engine_version" {
  type        = string
  default     = "7.1"
  description = "ElastiCache Redis version."
}

variable "redis_node_type" {
  type        = string
  default     = "cache.t4g.micro"
  description = "Prod needs headroom for the BullMQ working set, not just the cache."
}

variable "redis_num_cache_clusters" {
  type        = number
  default     = 1
  description = "1 in staging. Prod needs 2 or more, which is also the precondition for automatic failover."
}

variable "redis_automatic_failover_enabled" {
  type        = bool
  default     = false
  description = "Requires redis_num_cache_clusters >= 2. false with a single node; ElastiCache rejects the combination outright."
}

variable "redis_parameter_group_name" {
  type        = string
  default     = "default.redis7"
  description = "AWS-managed default. Cluster mode stays disabled."
}

variable "redis_snapshot_retention_limit" {
  type        = number
  default     = 1
  description = "Days. Queues are replayable from the database, so this is a convenience, not a recovery plan."
}

variable "redis_maintenance_window" {
  type        = string
  default     = "sun:04:30-sun:05:30"
  description = "UTC. Placed after the RDS window so the two do not land together."
}

variable "redis_apply_immediately" {
  type        = bool
  default     = true
  description = "true in staging. Prod should batch changes into the maintenance window."
}

variable "redis_auth_token_length" {
  type        = number
  default     = 48
  description = "ElastiCache accepts 16-128 characters."
}

variable "redis_secret_name" {
  type        = string
  default     = null
  description = "Overrides the derived /neoting/<env>/redis/connection path. Leave null."
}
