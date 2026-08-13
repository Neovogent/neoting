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
    staging/      the one live environment (shared account, eu-west-2)
  README.md
```

**There is no `modules/` directory, and `envs/prod/` does not exist yet.** Earlier revisions of this file described both as though they did. They are the same follow-up: extracting the flat staging config into reusable modules is what stops `prod` being a copy-paste, and it has to be done with `moved` blocks whose entire deliverable is a `terraform plan` reporting *0 to add, 0 to change, 0 to destroy*. That is a focused, reviewable PR of its own, and mixing it into a change that also adds resources would make both unreviewable.

## State

| Key | Contents | Why separate |
|---|---|---|
| `staging/core.tfstate` | one environment | disposable by design (G1) |
| `account/core.tfstate` | CloudTrail, GuardDuty, Budgets | outlives every environment — a `destroy` on staging must not take the audit trail with it |

Split by **lifetime**, not by team or service. Locking is S3-native (`use_lockfile = true`, Terraform ≥ 1.11); distinct keys mean distinct lockfiles, so account and staging applies never block each other. Full reasoning: `docs/adr/0006-terraform-state-layout-and-oidc-role-scoping.md`.

### Bootstrap resources — deliberately NOT in Terraform state

- S3 `nt-tfstate-staging-252959251643` (versioned, encrypted, PAB on)

Chicken-and-egg: the backend cannot manage itself, and a `terraform destroy` that eats the state bucket is a bad afternoon. Created by CLI, documented here, left alone.

**Known gap:** the state bucket has **no bucket policy**, so it lacks the explicit `Deny` for principals outside `role/nt-*` that every other Neoting bucket carries. In a shared account with seven IAM users, state is a high-value target — it holds resource configuration and, for some resource types, secret material. A policy can be added without adopting the bucket into state.

## Usage

```bash
cd infra/envs/staging          # or infra/envs/account
export AWS_PROFILE=nt          # PowerShell: $env:AWS_PROFILE="nt"
terraform init
terraform plan
terraform apply
```

Credentials are never in the config: locally via `AWS_PROFILE`, in CI via the `nt-staging-ci-*` OIDC roles. If `init` says *"No valid credential sources found"*, the profile isn't exported.

**Each directory is its own root module.** There is no `terraform apply` at `infra/` and one should not be invented — run them separately, account first when a change touches both.

### Adopting `envs/account/`

That directory ships with `imports.tf`, containing declarative `import` blocks for resources that already exist in AWS. The first plan **adopts** rather than creates.

Expect **zero creates and zero destroys**. Do *not* expect a completely empty diff: the imported resources currently carry no tags at all, and the provider's `default_tags` will add `Project`/`Env`/`Owner`/`ManagedBy` to each. Those are in-place tag updates and they are wanted — `Project=neoting` is load-bearing for every cost figure we quote while the account is shared (D36). If the plan wants to *create* something that already exists, the import ID is wrong: fix the import, never let it create a duplicate.

Delete `imports.tf` once adoption has applied. Import blocks are one-shot by design.

## Still outstanding

- **`modules/` extraction and `envs/prod/`** — the follow-up described under Layout.
- **Route 53 hosted zone `Z08402112LR2AWM4XBVST`** is created outside Terraform and consumed by `envs/staging/email.tf` as a `data` source. A plan fails outright if it is ever absent or renamed. Adopting it into `envs/account/` would close that.
- **Budget notifications go to one personal inbox.** Runbook §10.1 wants an SNS topic plus a role address. One human inbox is a single point of failure for the alert that tells us the pot is emptying.
- **IAM Access Analyzer is not enabled** (`list-analyzers` returns `[]`). In a shared account with seven users it is the cheapest way to find unintended cross-principal access. Security Hub is also absent — probably Infra Week, but it should be a decision rather than an omission.
- **SES production access was DENIED**, not pending — case `178662887400793`. Outbound email is blocked until that is appealed; inbound is unaffected. See `docs/adr/0002-*` and `envs/staging/email.tf`.
- **Textract quota increases are still open** (`CASE_OPENED`, raised 13 Aug).

Historic note: the DynamoDB lock table `nt-tflock` from bootstrap **no longer exists** — `dynamodb list-tables` returns `[]`. Earlier revisions of this file told you to delete it; that work is done.
