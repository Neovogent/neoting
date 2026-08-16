# infra/ — Terraform (AWS eu-west-2)

Owner: **Shakib** (`.github/CODEOWNERS`). Changes are PRs, never console clicks — see AWS Foundation Runbook §2.2.

## Where we are

Neoting staging currently lives **inside the shared Neovogent account `252959251643` (alias `neovotech`)**, which also hosts Cedofinance, visa-processing and needz workloads in eu-west-1. Dedicated `neoting-dev/staging/prod` member accounts have been requested from Cloudvisor (the org payer).

Everything here is written so that **moving to a dedicated account is a variable change, not a rewrite** — that is the G8 test. Nothing is hardcoded to the shared account except `local.account_id`.

### Consequences of the shared account, and what compensates

| Constraint | Compensation in this config |
|---|---|
| Org is `CONSOLIDATED_BILLING` → **SCPs are unavailable** | `nt-region-guardrail` IAM policy attached to every Neoting principal. Weaker than an SCP (an account admin can detach it) but it constrains everything we run. D30. Verified: `AvailablePolicyTypes` is `[]`, so this is a property of the org type, not a permissions problem we can escalate. |
| Six other IAM principals hold admin in this account | KMS key policy and bucket policies carry an **explicit Deny** for any principal not matching `role/nt-*`. Explicit deny beats any IAM allow, so casual/accidental access is blocked. A determined admin can still rewrite those policies — but that act is now recorded by CloudTrail, which did not exist in this account before 13 Aug 2026. |
| Other workloads sit in eu-west-1 / us-east-2 | Everything Neoting is eu-west-2 only, enforced by the guardrail policy above. |

**This is a mitigation, not isolation.** The DPIA must describe the account as shared until the dedicated accounts land. Full reasoning: `docs/adr/0005-aws-account-topology-and-slice-sequencing.md`.

### ⚠ The `role/nt-*` naming contract is load-bearing

Every deny guard in the bucket and KMS policies keys off `arn:aws:iam::252959251643:role/nt-*`. **Any new role that must touch Neoting S3 or KMS must be named `nt-*`, or it is denied.** The failure looks like a permissions bug and is actually a naming bug, which is why it belongs in a heading rather than a footnote.

## Layout

```
infra/
  envs/
    account/      applied. CloudTrail, GuardDuty, Budgets, Access Analyzer,
                  the public hosted zone, the state-bucket deny — account-scoped,
                  own state key
    staging/      applied (shared account, eu-west-2)
    prod/         written, NOT YET APPLIED — see "envs/prod/" below
  modules/
    network/      VPC, three subnet tiers, routing, NAT (optional), flow logs,
                  S3 gateway endpoint, the alb → app → data security-group chain
    storage/      documents CMK + the S3 buckets it protects, with their
                  policies, versioning, PAB and encryption defaults
    data/         RDS Postgres, ElastiCache Redis, subnet groups, Redis secret
    iam-policies/ the region guardrail, the secrets key policy and the CI
                  deploy inline policy — rendered per environment, creates
                  nothing
  README.md
```

### `envs/prod/`

Written 14 Aug 2026 and **not applied.** `terraform plan` reports **158 to add, 0 to change, 0 to destroy** — correct for an environment that does not exist yet. No `moved.tf`: prod has never been applied flat, so it has nothing to move.

⚠ **Production is in the SAME shared account as staging** (D36 — `neoting-prod` has been requested from Cloudvisor and has not been delivered). There is no blast-radius separation between staging and prod, and the DPIA must not claim there is. Moving to the dedicated account is intended to be a change to `local.account_id` and nothing else.

It calls the same three modules with production arguments, and diverges from staging in seven deliberate places:

| Divergence | Why |
|---|---|
| `10.30.0.0/16`, real NAT gateway, private task tier | Appendix B.3. Tasks have no public address at all; egress leaves through a stable allowlistable IP. **One** NAT, not three — a priced availability hole, flip is one line, +$66/mo. |
| Seven interface VPC endpoints (~$169/mo) | B.3 defers these in staging on cost and buys them in prod because keeping document and model traffic off the public internet is a residency argument (D30, Gov §11.9). |
| RDS `db.m7g.large`, Multi-AZ, deletion protection, final snapshot | Gov §17. Burstable credits are a latency cliff you find under load, not in a plan. |
| S3 cross-region replication to **eu-west-1** with a second CMK | Gov §17 + ADR 0007. KMS keys are regional, so the London key cannot encrypt a Dublin object. RTC on, for the RPO ≤ 15 min SLA. |
| Its own `nt-prod-region-guardrail` policy | ADR 0007 consequence 2 — a **narrow** carve-out for backup and replication in eu-west-1, not a blanket region allow. `envs/prod/policies/README.md` explains statement by statement. |
| **No `ci-plan` role at all** | `envs/staging/main.tf` says why prod must not copy the `refresh-secret-versions` grant. Prod plans and applies both run as `nt-prod-ci-deploy`, trusted only for the GitHub `prod` environment, so a reviewer approves before any production credential is minted. ⚠ That GitHub environment must be created by hand or the role is unassumable. |
| ECR repos `nt-prod/*`, not `nt/*` | ECR names are account-global and staging already owns `nt/*`. Same reason `nt-region-guardrail` and the GitHub OIDC provider are **read**, not created, in prod. |

**What prod deliberately does not have yet:** CloudFront + WAF, SES, AMP/AMG, Unleash, ClamAV. `envs/prod/main.tf` closes with the full list and the reason for each.

**The alarm estate landed 15 Aug 2026** (`envs/prod/observability.tf`, 46 resources, ~$8.60/mo) and with it the hard blocker on prod carrying a real document. Three things make it prod's rather than a copy of staging's:

- **Two SNS topics, `page` and `ticket`**, because staging's own file says one topic is wrong for prod — *"mixing 'a slow query happened' with 'the database is down' in one feed is how that channel gets muted."* Every alarm names a severity, and severity maps to a topic in exactly one place.
- **Replication alarms staging cannot have.** ADR 0007 replicates documents to eu-west-1 with RTC and Governance §17 puts an RPO of ≤ 15 min on it. `ReplicationLatency`, `OperationsFailedReplication` and `OperationsPendingReplication` are what stop that SLA being a hope. A *failed* replication is a page and not a ticket, because unlike a latency spike it never heals on its own — the object needs S3 Batch Replication or it stays single-copy forever.
- **No CPU-credit alarm.** staging has one because `db.t4g.small` is burstable; `db.m7g.large` is not, and that metric is never published. Copying it would have created an alarm parked in INSUFFICIENT_DATA forever — the exact thing that teaches people to ignore the console.

⚠ **It is still decoration until a topic has a confirmed subscriber.** Subscriptions are added out of band deliberately: a Terraform-created email subscription sits in `PendingConfirmation` while Terraform reports it created and the console shows a subscriber. Verify with `aws sns list-subscriptions-by-topic` and check nothing reads `PendingConfirmation`.

### What is a module, and what is deliberately not

Four modules, and the test each one passed was **"prod needs this in the same shape but a different size"** — which is where copy-paste actually costs you. `network` takes `enable_nat_gateway` (staging refuses the ~$36/mo; prod cannot) and grows a private subnet tier when it is on. `data` takes `db_multi_az`, `db_deletion_protection`, `db_skip_final_snapshot`, `db_instance_class` and the backup retention — staging is single-AZ and disposable (G1/G2), prod is neither. `storage` takes the bucket map, so prod adds a bucket without editing shared code. `iam-policies` is the odd one out — it **creates nothing** and renders text, because the documents it produces attach to a managed policy in one place, an inline role policy in another and a KMS key policy in a third, and a module that owned all three would need to know about roles and keys that are none of its business.

Everything else stays flat in `envs/staging/`, on purpose: `compute`, `alb`, `services`, `edge`, `observability`, `secrets`, `email`, `unleash`, `clamav`, `monitoring-backend`, `db-app-role`, `lifecycle`. They are either genuinely environment-specific (dashboards, alarm thresholds, the SES identity, the WAF ACL) or still in flux. Extracting them now would freeze an interface nobody has tested against a second caller, and a partial extraction that is verified beats a total one that is not.

**The extraction was verified by plan, not by reading.** `envs/staging/moved.tf` carries 37 one-shot `moved` blocks — one per address that `terraform state list` showed on 14 Aug 2026 — and the acceptance test was that `terraform plan` reported the *same* `181 to add, 6 to change, 1 to destroy` before and after, with the single destroy being the pre-existing CloudFront-prefix-list swap on the ALB ingress rule. Read the header of `moved.tf` before deleting it.

### The shared bucket-policy template

`modules/storage/policies/bucket.json.tftpl` is the `role/nt-*` deny guard, and it is **not** storage-module-private: `envs/staging/clamav.tf` renders the same file for the quarantine and AV-definitions buckets via `local.shared_bucket_policy_template`. It is referenced across the directory boundary rather than copied, because two copies of a deny guard is exactly the drift that silently opens a bucket while both files still look correct in review.

## State

| Key | Contents | Why separate |
|---|---|---|
| `staging/core.tfstate` | one environment | disposable by design (G1) |
| `prod/core.tfstate` | production | ⚠ same bucket, **different key**. A shared key would mean one `terraform destroy` in the wrong directory takes production with it. The bucket name still says "staging" because renaming it is a copy-and-repoint of every state file in it. |
| `account/core.tfstate` | CloudTrail, GuardDuty, Budgets | outlives every environment — a `destroy` on staging must not take the audit trail with it |

Split by **lifetime**, not by team or service. Locking is S3-native (`use_lockfile = true`, Terraform ≥ 1.11); distinct keys mean distinct lockfiles, so account and staging applies never block each other. Full reasoning: `docs/adr/0006-terraform-state-layout-and-oidc-role-scoping.md`.

### Bootstrap resources — deliberately NOT in Terraform state

- S3 `nt-tfstate-staging-252959251643` (versioned, encrypted, PAB on)

Chicken-and-egg: the backend cannot manage itself, and a `terraform destroy` that eats the state bucket is a bad afternoon. Created by CLI, documented here, left alone.

**Closed 15 Aug 2026:** the state bucket now carries the shared `role/nt-*` deny (`envs/account/tfstate.tf`), rendered from the same `modules/storage/policies/bucket.json.tftpl` as every other Neoting bucket. It is still not *adopted* into state — a bucket policy attaches by name and does not require owning the bucket, which is what made the gap closeable without unpicking the bootstrap decision.

⚠ Read the header of `tfstate.tf` before editing that policy or the shared template. This root's own state lives in the bucket it guards, so a deny that catches the applying principal would apply first and the state write would fail second. Two things keep it safe: every Terraform runner is on the allow list (`user/Mubashir` — there is no `shakib` IAM user — plus `role/nt-*`), and the template denies object actions only, never `s3:PutBucketPolicy`, so a bad policy is recoverable.

**Remaining gap:** the bucket is SSE-S3, not the Neoting CMK, so that deny is the only lock on state — there is no second, independent KMS-policy lock behind it as there is on the documents bucket.

## Usage

```bash
cd infra/envs/staging          # or infra/envs/account, or infra/envs/prod
export AWS_PROFILE=nt          # PowerShell: $env:AWS_PROFILE="nt"
terraform init
terraform plan
terraform apply
```

Credentials are never in the config: locally via `AWS_PROFILE`, in CI via the `nt-staging-ci-*` and `nt-prod-ci-deploy` OIDC roles. If `init` says *"No valid credential sources found"*, the profile isn't exported.

⚠ `terraform apply` in `envs/prod/` is a production change. RDS deletion protection and ALB deletion protection are on, so `destroy` there fails until a separate reviewed change clears them — that obstruction is the control, not a bug.

**Each directory is its own root module.** There is no `terraform apply` at `infra/` and one should not be invented — run them separately, account first when a change touches both.

### `envs/account/` — adopted 15 Aug 2026

Applied. The adoption ran as predicted: **10 imported, 0 added, 6 changed, 0 destroyed**, where five of the six changes were the provider's `default_tags` materialising on resources that carried no tags at all, and the sixth was the documented `neoting-pot-8000` `time_period_start` correction. `Project=neoting` is load-bearing for every cost figure we quote while the account is shared (D36), so those tag updates were the point, not noise.

`imports.tf` has been deleted — import blocks are one-shot by design, and leaving them behind tells the next reader these resources are still unmanaged. The hosted-zone adoption that followed in `dns.tf` was removed the same way.

Until this ran, the audit controls themselves were console artefacts, which was a hole in exactly the place the D36 compensating-control argument could least afford one. `account/core.tfstate` now exists.

## Still outstanding

- **`envs/prod/` is written but unapplied, and three things must land before it carries a real document.** (1) The alarm estate — `observability.tf` does not exist there, so nothing would notice a queue backing up, a failed S3 replication, or Redis running out of memory. (2) The `nt_app` non-owning database role in `prisma/` — until it exists the application connects as an RDS superuser and every RLS policy is decoration (`envs/prod/db-app-role.tf` lists the four things needed). (3) A bucket policy on the state bucket — prod's `random_password` values sit in a state file that carries no `role/nt-*` deny.
- **The prod GitHub environment does not exist yet.** `nt-prod-ci-deploy` trusts `repo:neovogent/neoting:environment:prod`, and GitHub will not mint a token with that `sub` until an environment named exactly `prod`, with required reviewers, exists on the repository. Until then the role is unassumable and every prod deploy fails at the credential step. It is a repository setting, not AWS.
- ~~**Two IAM policy documents are now duplicated between `envs/staging/policies/` and `envs/prod/policies/`.**~~ — extracted to `modules/iam-policies` on 15 Aug 2026. `envs/staging/policies/` is gone entirely; `envs/prod/policies/` keeps only `kms-dr.json.tftpl`, which has no staging twin and therefore nothing to drift against. What made prod different is now **input** rather than a second file: `dr_region` + `dr_buckets` for the guardrail, `state_key_prefix` for the CI role, `env` for the key-policy `Id`. Verified the way `moved.tf` was — `terraform plan` in `envs/staging` reports **no changes**, prod still plans `158 to add, 0 to change, 0 to destroy`, and every rendered document was diffed as normalised JSON against the file it replaced.
- ~~**⚠ `nt-staging-ci-deploy` can read and overwrite `prod/core.tfstate` and `account/core.tfstate`.**~~ — narrowed to `staging/` on 16 Aug 2026, **before** the first prod apply rather than after it. Prod's state holds `random_password` values in plaintext (the Redis auth token, the `nt_app` role password), so once prod existed this would have been a live path from the environment that runs on every push to main straight to production credentials. Closing it once it is real is incident response; closing it while it is theoretical is a one-word permission change. The plan showed exactly one statement moving, `.../\*` → `.../staging/\*`.

  ⚠ **Residual, and smaller but real:** `nt-staging-ci-plan` carries AWS-managed `ReadOnlyAccess`, which includes `s3:GetObject` account-wide, and the role matches `role/nt-*` so the state bucket's deny admits it. It can therefore still **read** `prod/core.tfstate`. It cannot write, and it only assumes on pull-request events — but the honest statement is that prod state is readable by a staging principal until `ReadOnlyAccess` is replaced with a scoped policy. Tracked here rather than fixed in the same change, because swapping a managed policy for a hand-written one on the role that gates every PR plan is its own change with its own blast radius.
- **`modules/data` can now put the RDS-managed master secret under our CMK — but the call sites deliberately don't yet, and one of them never can.** `master_user_secret_kms_key_arn` exists as of 15 Aug 2026, defaulting to `null`. Two AWS behaviours, both verified against the RDS User Guide and the live account, decide how it may be used:
  - **The key is immutable after creation.** *"After RDS is managing the database credentials for a DB instance, you can't change the KMS key that is used to encrypt the secret."* So this is a **create-time** decision, not something a later apply fixes. `nt-staging` already exists on the AWS-managed key (verified: `KeyManager: AWS`) and cannot be moved by editing the variable — the only recovery is turning credential management off and on again, which mints a new secret at a new ARN and breaks every task definition referencing the old one. **Staging stays as it is.**
  - **⚠ The key policy must exempt AWS services or rotation fails silently.** Creation works on the caller's own permissions (`kms:DescribeKey`, `kms:Decrypt`, `kms:GenerateDataKey`, `kms:CreateGrant`), but RDS rotates this secret every 7 days as a *service* principal, where `aws:PrincipalArn` matches no `role/nt-*`. `StringNotLike` on a missing key is true, and an explicit deny beats the grant. `envs/prod/policies/kms-secrets.json.tftpl` drops the `aws:PrincipalIsAWSService` carve-out on purpose — sound for every secret we write ourselves, and wrong for this one, which is the single case where a service really does encrypt a secret on its own behalf. The apply would succeed and `SecretStatus` would flip to `impaired` a week later, still readable, silently unrotated.

  **Decided 15 Aug 2026: prod gets a dedicated CMK.** `aws_kms_key.rds_master_secret` (~$1/mo) carries the `aws:PrincipalIsAWSService` exemption that this one secret needs, and `aws_kms_key.secrets` keeps its absolute deny for the twenty-odd secrets that do not. Confining the exemption to the one key that genuinely needs it was the point — the alternative was weakening a deliberate deny for everything under it. Wired at `envs/prod/data.tf`; full reasoning and the verification command are at the key in `envs/prod/secrets.tf`.

  ⚠ **Verify it seven days after the first apply, not at apply time.** A broken key policy here does not fail the apply — the secret is created, everything looks right, and rotation silently stops a week later. `aws rds describe-db-instances --db-instance-identifier nt-prod --query 'DBInstances[0].MasterUserSecret'` must read `SecretStatus: active`, not `impaired`.
- **`modules/` are unversioned local paths.** `source = "../../modules/network"` means a prod call site and a staging call site always run the same code, so a module edit made for prod plans against staging too. That is the right default while there is one environment and one owner; it stops being right the moment prod carries real data, and the fix then is a tag or a pinned ref, not discipline.
- ~~**Route 53 hosted zone `Z08402112LR2AWM4XBVST`**~~ — adopted into `envs/account/dns.tf` on 15 Aug 2026. Staging is unaffected: `data "aws_route53_zone" "primary"` resolves against live AWS, not against whoever's state holds the resource, so no cross-state dependency was created. The zone is account-scoped because D5 splits it between two environments (prod on the apex, staging on `staging.`) and it outlives both. `prevent_destroy` is on; the records inside stay owned by the environment that creates them.
- **The staging hostname has been decided but not moved.** Shakib settled the split on 15 Aug 2026: production takes the apex `neoting.neovogent.com`, staging moves to `staging.neoting.neovogent.com`. Staging is currently live on `api.neoting.neovogent.com` — healthy, in the CloudFront alias, on the ACM cert — so the move is a certificate + distribution + Route 53 change against a working environment and belongs in its own PR. This unblocks prod's `edge.tf` and `email.tf`, which were held only by the undecided name.
- ~~**Budget notifications go to one personal inbox.**~~ — both budgets now also publish to `nt-staging-alerts` (16 Aug 2026). Governance §13.5 calls a surprising bill an alerting failure, and an alert reaching exactly one mailbox fails the moment that person is on a plane. The email subscriber stays alongside the topic rather than being replaced.

  ⚠ **This is a cross-state reference by literal ARN**, deliberately: the topic lives in `envs/staging`'s state, and a `terraform_remote_state` data source would couple the audit baseline's apply to an environment that is explicitly disposable (G1). The other half of the contract — `AllowAWSBudgetsToPublish`, scoped to `arn:aws:budgets::<account>:*` — is in `envs/staging/observability.tf` and names the same string. **Renaming the topic breaks this silently**, because Budgets does not report a failed publish anywhere a human sees it. Move both files in one PR.

  It targets staging's topic and **not** `nt-prod-page`, on purpose: Budgets is account-scoped, there is one $1,300 budget for the whole shared account (D36), and a spend threshold at 2am is a ticket rather than an incident.
- **The remaining alerting gap is subscribers, not topics.** `nt-staging-alerts`, `nt-prod-page` and `nt-prod-ticket` all exist and all have correct publish policies. None is verified to have a confirmed subscriber. Check with `aws sns list-subscriptions-by-topic --topic-arn <arn>` and treat any `PendingConfirmation` as unsubscribed. Runbook §10.1 wants an SNS topic plus a role address. One human inbox is a single point of failure for the alert that tells us the pot is emptying.
- ~~**IAM Access Analyzer is not enabled**~~ — enabled 15 Aug 2026 in both eu-west-2 and eu-west-1 (`envs/account/access-analyzer.tf`), free, `ACTIVE`. It is the only control in the repo that answers "given everything actually attached right now, who can reach Neoting's data?" rather than restating a policy we wrote ourselves. `ACCOUNT_UNUSED_ACCESS` is deliberately **not** on: it bills per IAM principal across the whole account, and all but nine of the roles here belong to three other products. ⚠ Findings are not routed anywhere — they surface in the console and EventBridge only, and wiring them to SNS belongs with the alerting work.
- **Security Hub is still absent, and it is now the open decision rather than the open omission.** Unlike Access Analyzer it is not free and it is not ours alone: enabling it subscribes the entire shared account, so standards checks run against Cedofinance, visa-processing and needz resources, billed to Neoting, generating findings this repo has no authority to fix. It becomes obviously correct once the dedicated `neoting-*` accounts land.
- **SES production access** — replied 14 Aug 2026, awaiting AWS (case `178662887400793`). Outbound email stays blocked until granted; inbound is unaffected. `sesv2 get-account` will keep reporting DENIED until it is actually granted — check the case, not the API. See `docs/runbooks/aws-support-cases.md`.
- **Textract quota increases** — replied 14 Aug 2026, awaiting AWS. Verification 8.4 and ADR 0003 unblock when they are granted.

Historic note: the DynamoDB lock table `nt-tflock` from bootstrap **no longer exists** — `dynamodb list-tables` returns `[]`. Earlier revisions of this file told you to delete it; that work is done.
