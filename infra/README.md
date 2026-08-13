# infra/ — Terraform (AWS eu-west-2)

Owner: **Shakib** (`.github/CODEOWNERS`). Changes are PRs, never console clicks — see AWS Foundation Runbook §2.2.

## Where we are

Neoting staging currently lives **inside the shared Neovogent account `252959251643` (alias `neovotech`)**, which also hosts Cedofinance, visa-processing and needz workloads in eu-west-1. Dedicated `neoting-dev/staging/prod` member accounts have been requested from Cloudvisor (the org payer).

Everything here is written so that **moving to a dedicated account is a variable change, not a rewrite** — that is the G8 test. Nothing is hardcoded to the shared account except `local.account_id`.

### Consequences of the shared account, and what compensates

| Constraint | Compensation in this config |
|---|---|
| Org is `CONSOLIDATED_BILLING` → **SCPs are unavailable** | `nt-region-guardrail` IAM policy attached to every Neoting principal. Weaker than an SCP (an account admin can detach it) but it constrains everything we run. D30. |
| Six other IAM principals hold admin in this account | KMS key policy and bucket policies carry an **explicit Deny** for any principal not matching `role/nt-*`. Explicit deny beats any IAM allow, so casual/accidental access is blocked. A determined admin can still rewrite those policies — but that act is now recorded by CloudTrail, which did not exist in this account before 13 Aug 2026. |
| Other workloads sit in eu-west-1 / us-east-2 | Everything Neoting is eu-west-2 only, enforced by the guardrail policy above. |

**This is a mitigation, not isolation.** The DPIA must describe the account as shared until the dedicated accounts land.

## Layout

```
infra/
  envs/
    staging/      this environment (shared account, eu-west-2)
    prod/         Infra Week (G8)
  modules/        network, data, compute, edge, storage, observability, email
```

## Bootstrap resources — deliberately NOT in Terraform state

- S3 `nt-tfstate-staging-252959251643` (versioned, encrypted, PAB on)

Chicken-and-egg: the backend cannot manage itself, and a `terraform destroy` that eats the state bucket is a bad afternoon. Created by CLI, documented here, left alone.

State locking is **S3-native** (`use_lockfile = true`, Terraform ≥ 1.11). The DynamoDB table `nt-tflock` created during bootstrap is **unused** — `dynamodb_table` is deprecated in the S3 backend. Safe to delete:
`aws dynamodb delete-table --table-name nt-tflock --region eu-west-2`

## Account-level resources (created 13 Aug 2026, Terraform TODO)

CloudTrail `neoting-audit` (multi-region, log-file validation), GuardDuty (eu-west-2 + eu-west-1), AWS Budgets `neoting-monthly-1300` and `neoting-pot-8000`, SES production-access request, Textract quota increases. These belong in `envs/account/` — not yet written.

## Usage

```bash
cd infra/envs/staging
set AWS_PROFILE=nt          # cmd     (PowerShell: $env:AWS_PROFILE="nt")
terraform init
terraform plan              # first run adopts existing resources via imports.tf
terraform apply
```

Credentials are never in the config: locally via `AWS_PROFILE`, in CI via the `nt-staging-ci-*` OIDC roles. If `init` says *"No valid credential sources found"*, the profile isn't exported.

The first plan should show **zero creates and zero destroys** for everything in `imports.tf`. If it wants to create something that already exists, the import ID is wrong — fix the import, never let it create a duplicate.

Once adopted, delete `imports.tf` (import blocks are one-shot by design).
