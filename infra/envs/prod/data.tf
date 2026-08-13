# ==========================================================================
# RDS PostgreSQL 16 + ElastiCache Redis (Kickoff 3.6, D23) —
# infra/modules/data.
#
# Every value below is restated rather than left to the module's defaults, for
# the reason data.tf gives in staging: the point of a shared module is that
# reading the CALL tells you what the environment is. It matters more here,
# because the module's defaults are the staging answers and the module's own
# variable descriptions say so — "Every one of them is wrong for prod, which
# is why they are variables and not locals."
#
# A reviewer should be able to diff envs/staging/data.tf against this file and
# see the entire production/pre-production difference in one screen. Four lines
# of that diff are the ones that matter: multi_az, deletion_protection,
# skip_final_snapshot, instance_class.
# ==========================================================================

locals {
  # ⚠ BUMP THIS BY HAND IF A DESTROY EVER HAS TO BE RE-RUN.
  #
  # RDS requires a final-snapshot identifier when skip_final_snapshot is false,
  # and the identifier must be unique in the account FOREVER — a snapshot that
  # already exists makes the destroy fail. The obvious fix, timestamp(), is a
  # trap: it changes on every plan, so it would show a perpetual diff on the
  # database and Terraform would want to replace... nothing, but nobody reading
  # the plan knows that at a glance, and a noisy plan on a production database
  # is how a real change gets waved through.
  #
  # A hand-bumped generation string is greppable, stable, and forces exactly
  # one moment of thought at exactly the moment it should be forced: the moment
  # somebody is about to destroy the production database.
  db_final_snapshot_generation = "2026-10"
}

module "data" {
  source = "../../modules/data"

  env                = local.env
  subnet_ids         = module.network.data_subnet_ids
  security_group_ids = [module.network.data_security_group_id]

  kms_key_arn         = module.storage.kms_key_arn
  secrets_kms_key_arn = aws_kms_key.secrets.arn

  db_engine_version = "16.14"

  # ------------------------------------------------------------------------
  # INSTANCE CLASS — db.m7g.large, and this is the single largest line on the
  # prod bill, so it gets a real justification rather than "prod is bigger".
  #
  # The module's own note is the argument: "Prod goes m7g: burstable credits
  # are a latency cliff you discover under load, not in a plan." That is not
  # theoretical for this workload. A t-class instance earns CPU credits at a
  # fixed rate and spends them under load; when the balance hits zero the
  # instance is throttled to its baseline — 20% of a vCPU on t4g.small. Neoting
  # generates exactly the traffic shape that drains credits: bulk document
  # ingestion arrives in bursts (a practice uploads a month of receipts at
  # once), each document is several writes plus RLS-filtered reads, and the
  # bank-matching pass is a join-heavy sweep. The failure is not an error, it
  # is every query getting five times slower with no alarm that says why, and
  # Governance §5.1's "100ms p95" budget evaporating.
  #
  # db.m7g.large is the SMALLEST non-burstable Graviton class: 2 vCPU, 8 GiB.
  # 8 GiB matters as much as the vCPU — it is roughly the whole working set at
  # pilot scale, which is what keeps the buffer cache hot and the p95 flat.
  #
  # WHAT IT COSTS (eu-west-2 on-demand, verify against the calculator before
  # quoting it to anyone):
  #   db.m7g.large single-AZ   ~$0.19/hr   ~$138/mo
  #   Multi-AZ (below)          ×2         ~$276/mo
  #   100 GiB gp3, mirrored     ~$0.115/GiB×2  ~$23/mo
  #   ----------------------------------------------------
  #   ~$300/month, about half of Appendix B.1's ~$600 October figure.
  #
  # THE CHEAPER OPTION, AND WHY IT IS NOT TAKEN: db.t4g.medium Multi-AZ is
  # ~$106/mo, saving ~$170/mo — a quarter of the October budget. It is the
  # right call for an environment that never sees a burst and the wrong one for
  # the environment that carries the pilot, because the failure it buys is
  # invisible until a customer is watching. If the pot gets tight, the honest
  # move is to shorten the pilot, not to make the pilot slower.
  #
  # RESERVED INSTANCES ARE THE REAL LEVER AND ARE DELIBERATELY NOT TAKEN YET: a
  # 1-year no-upfront RI on this class is roughly 30–40% off, i.e. ~$100/mo
  # saved. It is not taken because a reservation is a 12-month commitment on an
  # instance class chosen before the workload has ever run, and the six-month
  # envelope (D35) ends before the commitment does. Revisit after the pilot,
  # with a month of real Performance Insights data behind the decision.
  # ------------------------------------------------------------------------
  db_instance_class = "db.m7g.large"

  # 100 GiB baseline, autoscaling to 1 TiB. gp3's baseline 3,000 IOPS is
  # included at any size, so the number here buys capacity, not speed.
  # The ceiling exists so a runaway import cannot silently become a $2,000
  # storage bill — but it is high enough that hitting it means something is
  # genuinely wrong, not that the pilot succeeded.
  db_allocated_storage     = 100
  db_max_allocated_storage = 1000

  # ------------------------------------------------------------------------
  # THE THREE NON-NEGOTIABLES (Governance §17).
  # ------------------------------------------------------------------------

  # Roughly doubles the instance cost and is the difference between an AZ
  # failure being a page and being an outage. Also the precondition for a
  # zero-data-loss failover: the standby is a synchronous physical replica.
  db_multi_az = true

  # `terraform destroy` on this directory now FAILS, by design, and that is the
  # entire point.
  #
  # ⚠ THE TWO-STEP THIS IMPLIES, so nobody discovers it during an incident:
  # deliberately destroying production means (1) a PR setting this to false,
  # (2) apply, (3) destroy. Three reviewed steps to delete the customers' data.
  # If that feels obstructive, it is working.
  db_deletion_protection = true

  # staging skips the final snapshot because it holds synthetic data (G2).
  # Here, `true` would mean an accidental destroy is unrecoverable — every
  # document row, every approval, every audit record, gone with no artefact
  # left behind. The snapshot is the last line of defence after deletion
  # protection and PITR have both been defeated by a determined mistake.
  db_skip_final_snapshot       = false
  db_final_snapshot_identifier = "nt-${local.env}-final-${local.db_final_snapshot_generation}"

  # 35 days of PITR, the maximum, and Governance §17 makes it non-negotiable.
  # Storage for backups up to the size of the database is free; beyond that it
  # is ~$0.095/GiB-month, so 35 days of a 100 GiB database with modest churn is
  # single-digit dollars. This is the cheapest insurance on the whole bill.
  db_backup_retention_period = 35
  db_backup_window           = "02:00-03:00" # UTC, outside UK working hours
  db_maintenance_window      = "sun:03:30-sun:04:30"

  # 7 days is the free tier. 731 days (the long-term option) is billed per vCPU
  # per month and would be ~$14/mo here for retrospective analysis nobody has
  # asked for. Revisit if a performance incident ever needs more history than a
  # week — and note that the answer to that is usually the metric filters in
  # observability.tf, not a longer PI window.
  db_performance_insights_retention_period = 7

  # ⚠ FALSE IN PROD, and the opposite of staging.
  #
  # apply_immediately = true means a parameter change or an instance-class
  # change takes effect the moment `terraform apply` returns — which for
  # several attributes means an immediate reboot or a Multi-AZ failover, from
  # whatever laptop or pipeline ran the apply, at whatever time of day that
  # was. With false, the change is staged and applied in the maintenance
  # window above, at 03:30 on a Sunday.
  #
  # The cost of false, stated: an urgent change (say, raising max_connections
  # during an incident) waits, or gets forced through the console with
  # `--apply-immediately`, which then shows as drift on the next plan. That is
  # the right trade — the emergency path should be visibly exceptional.
  db_apply_immediately = false

  # ------------------------------------------------------------------------
  # REDIS — BullMQ queues + cache.
  #
  # Cluster mode stays DISABLED in every environment (BullMQ's key patterns
  # need hash-tag design to work in cluster mode). What changes in prod is that
  # there is a second node and a failover path.
  #
  # cache.t4g.medium × 2 ≈ $113/mo (eu-west-2, ~$0.0776/node-hour).
  #
  # WHY t4g HERE WHEN POSTGRES GETS m7g, since that looks inconsistent: the
  # burstable-credit argument does not transfer. Redis is single-threaded and,
  # at pilot volume, spends almost no CPU — it is memory- and network-bound.
  # The thing that hurts a Redis node is running out of RAM (BullMQ retains
  # completed and failed job records, and an unbounded `completed` set is the
  # classic way to fill one), and 3.09 GiB per node is roughly an order of
  # magnitude above the pilot working set. m7g.large × 2 would be ~$281/mo to
  # buy CPU this workload does not use.
  #
  # ⚠ WHAT MUST EXIST BEFORE THIS IS TRUE IN PRODUCTION: a CPU-credit-balance
  # alarm, and a memory alarm, in observability.tf — which is not built (see
  # main.tf's "what is not in this root"). Until then this sizing is a
  # reasoned bet with nothing watching it. Say so rather than assuming.
  # ------------------------------------------------------------------------
  redis_engine_version     = "7.1"
  redis_node_type          = "cache.t4g.medium"
  redis_num_cache_clusters = 2

  # Requires num_cache_clusters >= 2 — ElastiCache rejects the combination
  # outright otherwise, which is a useful coupling: you cannot accidentally
  # claim failover you have not paid for.
  redis_automatic_failover_enabled = true

  redis_parameter_group_name = "default.redis7"

  # 7 days, not staging's 1. Queues are replayable from the database, so this
  # is still not a recovery plan — it is the difference between reconstructing
  # a lost queue state from first principles and restoring it. Backup storage
  # up to the cluster size is free.
  redis_snapshot_retention_limit = 7

  redis_maintenance_window = "sun:04:30-sun:05:30" # after the RDS window, deliberately
  redis_apply_immediately  = false                 # prod batches changes into the window
}

# ==========================================================================
# ⚠ TWO THINGS THIS FILE CANNOT DO, BOTH OF WHICH MATTER MORE IN PROD.
#
# 1. THE RLS PRECONDITION. Postgres RLS is bypassed by the table owner, and on
#    RDS the master user carries rds_superuser, which FORCE ROW LEVEL SECURITY
#    does not constrain at all. The module's master user (nt_migrator) owns the
#    schema; the application MUST connect as the separate non-owning role whose
#    credential lives in db-app-role.tf. Until the migration in prisma/ creates
#    that role, every tenancy policy in prisma/ is decoration — and the failure
#    is silent, because a broken RLS policy returns MORE rows, never fewer.
#    A tenancy leak does not throw. See db-app-role.tf for the full state of
#    play and the four things that have to land in prisma/ (which is LAW, G7).
#
# 2. THE RDS-MANAGED MASTER SECRET IS NOT UNDER OUR CMK. `manage_master_user_password`
#    puts the master credential in Secrets Manager encrypted with the
#    AWS-MANAGED `aws/secretsmanager` key, whose policy cannot be edited and
#    therefore carries none of the `role/nt-*` explicit Deny that D36's whole
#    compensating-control story rests on. In a shared account with seven IAM
#    users, the production database master password is the one credential most
#    worth putting inside that boundary, and it is currently outside it.
#
#    The fix is `master_user_secret_kms_key_id` on the RDS instance, which
#    modules/data does not expose. That is an ADDITIVE variable on a shared
#    module (null default, staging unaffected) and it belongs in its own PR
#    against modules/data, not in a change that also stands up an environment.
#    Recorded here so it is not rediscovered during a security review.
#    ⚠ Changing it later RE-ENCRYPTS the secret rather than rotating it, so it
#    is safe to do after the fact — but do it before real customer data lands.
# ==========================================================================

output "db_endpoint" { value = module.data.db_endpoint }
output "db_instance_identifier" { value = module.data.db_instance_identifier }
output "db_master_secret_arn" { value = module.data.db_master_user_secret_arn }
output "redis_secret_arn" { value = module.data.redis_secret_arn }
