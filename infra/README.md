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
    account/      CloudTrail, GuardDuty, Budgets — account-scoped, own state key
    staging/      applied (shared account, eu-west-2)
    prod/         written, NOT YET APPLIED — see "envs/prod/" below
  modules/
    network/      VPC, three subnet tiers, routing, NAT (optional), flow logs,
                  S3 gateway endpoint, the alb → app → data security-group chain
    storage/      documents CMK + the S3 buckets it protects, with their
                  policies, versioning, PAB and encryption defaults
    data/         RDS Postgres, ElastiCache Redis, subnet groups, Redis secret
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

**What prod deliberately does not have yet:** CloudFront + WAF, SES, the CloudWatch alarm estate, AMP/AMG, Unleash, ClamAV. `envs/prod/main.tf` closes with the full list and the reason for each. The consequential one: **no observability**, which is a hard blocker on prod carrying a single real document.

### What is a module, and what is deliberately not

Three modules, and the test each one passed was **"prod needs this in the same shape but a different size"** — which is where copy-paste actually costs you. `network` takes `enable_nat_gateway` (staging refuses the ~$36/mo; prod cannot) and grows a private subnet tier when it is on. `data` takes `db_multi_az`, `db_deletion_protection`, `db_skip_final_snapshot`, `db_instance_class` and the backup retention — staging is single-AZ and disposable (G1/G2), prod is neither. `storage` takes the bucket map, so prod adds a bucket without editing shared code.

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

**Known gap:** the state bucket has **no bucket policy**, so it lacks the explicit `Deny` for principals outside `role/nt-*` that every other Neoting bucket carries. In a shared account with seven IAM users, state is a high-value target — it holds resource configuration and, for some resource types, secret material. A policy can be added without adopting the bucket into state.

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

### Adopting `envs/account/`

That directory ships with `imports.tf`, containing declarative `import` blocks for resources that already exist in AWS. The first plan **adopts** rather than creates.

Expect **zero creates and zero destroys**. Do *not* expect a completely empty diff: the imported resources currently carry no tags at all, and the provider's `default_tags` will add `Project`/`Env`/`Owner`/`ManagedBy` to each. Those are in-place tag updates and they are wanted — `Project=neoting` is load-bearing for every cost figure we quote while the account is shared (D36). If the plan wants to *create* something that already exists, the import ID is wrong: fix the import, never let it create a duplicate.

Delete `imports.tf` once adoption has applied. Import blocks are one-shot by design.

## Still outstanding

- **`envs/prod/` is written but unapplied, and three things must land before it carries a real document.** (1) The alarm estate — `observability.tf` does not exist there, so nothing would notice a queue backing up, a failed S3 replication, or Redis running out of memory. (2) The `nt_app` non-owning database role in `prisma/` — until it exists the application connects as an RDS superuser and every RLS policy is decoration (`envs/prod/db-app-role.tf` lists the four things needed). (3) A bucket policy on the state bucket — prod's `random_password` values sit in a state file that carries no `role/nt-*` deny.
- **The prod GitHub environment does not exist yet.** `nt-prod-ci-deploy` trusts `repo:neovogent/neoting:environment:prod`, and GitHub will not mint a token with that `sub` until an environment named exactly `prod`, with required reviewers, exists on the repository. Until then the role is unassumable and every prod deploy fails at the credential step. It is a repository setting, not AWS.
- **Two IAM policy documents are now duplicated between `envs/staging/policies/` and `envs/prod/policies/`.** They are genuinely different policies (prod's guardrail carries the ADR 0007 carve-out) but their shared halves must stay in step and nothing enforces that. The fix is a shared `modules/iam-policies` rendered per environment; see `envs/prod/policies/README.md`.
- **`modules/data` cannot put the RDS-managed master secret under our CMK.** `master_user_secret_kms_key_id` is not exposed, so production's database master password sits under the AWS-managed `aws/secretsmanager` key, outside the `role/nt-*` deny boundary that D36's whole compensating-control story rests on. Additive module variable, own PR.
- **`modules/` are unversioned local paths.** `source = "../../modules/network"` means a prod call site and a staging call site always run the same code, so a module edit made for prod plans against staging too. That is the right default while there is one environment and one owner; it stops being right the moment prod carries real data, and the fix then is a tag or a pinned ref, not discipline.
- **Route 53 hosted zone `Z08402112LR2AWM4XBVST`** is created outside Terraform and consumed by `envs/staging/email.tf` as a `data` source. A plan fails outright if it is ever absent or renamed. Adopting it into `envs/account/` would close that.
- **Budget notifications go to one personal inbox.** Runbook §10.1 wants an SNS topic plus a role address. One human inbox is a single point of failure for the alert that tells us the pot is emptying.
- **IAM Access Analyzer is not enabled** (`list-analyzers` returns `[]`). In a shared account with seven users it is the cheapest way to find unintended cross-principal access. Security Hub is also absent — probably Infra Week, but it should be a decision rather than an omission.
- **SES production access was DENIED**, not pending — case `178662887400793`. Outbound email is blocked until that is appealed; inbound is unaffected. See `docs/adr/0002-*` and `envs/staging/email.tf`.
- **Textract quota increases are still open** (`CASE_OPENED`, raised 13 Aug).

Historic note: the DynamoDB lock table `nt-tflock` from bootstrap **no longer exists** — `dynamodb list-tables` returns `[]`. Earlier revisions of this file told you to delete it; that work is done.
