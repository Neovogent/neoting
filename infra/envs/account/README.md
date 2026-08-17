# infra/envs/account — account-scoped controls

Owner: **Shakib** (`.github/CODEOWNERS`). Changes are PRs, never console clicks — AWS Foundation Runbook §2.2.

## What lives here

The three controls that are properties of AWS account `252959251643` itself rather than of any one environment:

| Resource | Live since | File |
|---|---|---|
| CloudTrail `neoting-audit` — multi-region, global service events, log-file validation | 13 Aug 2026 | `cloudtrail.tf` |
| Its destination bucket `neoting-cloudtrail-252959251643` (+ versioning, SSE, PAB, policy) | 13 Aug 2026 | `cloudtrail.tf` |
| GuardDuty detectors in **eu-west-2** and **eu-west-1** | 13 Aug 2026 | `guardduty.tf` |
| AWS Budgets `neoting-monthly-1300` and `neoting-pot-8000` | 13 Aug 2026 | `budgets.tf` |

All of it was created by console/CLI during the 13 Aug 2026 foundation session and carried as **"Terraform TODO"** in `infra/README.md`. This directory is the adoption.

## Why it exists, and why it is not optional

`infra/README.md` justifies running Neoting inside a shared account (D36) with one sentence: *"Everything here is written so that moving to a dedicated account is a variable change, not a rewrite — that is the G8 test."* The compensating-control table leans hardest on CloudTrail: the answer to *"six other IAM principals hold admin in this account"* is *"a determined admin can still rewrite those policies — but that act is now recorded by CloudTrail."*

Until this directory existed, the audit controls that argument depends on were console artefacts — undeclared, unreviewed, and undetectable if switched off. That was the gap. This closes it.

## Why it has its own state

`account/core.tfstate`, not `staging/core.tfstate`, in the same bootstrap bucket:

- **Lifecycle.** Staging is disposable by design (G1). `terraform destroy` on a disposable environment must not be able to take the account's audit trail with it.
- **Blast radius.** These resources are account-wide by definition. A `-target`ed or mistaken staging apply should not be able to touch them.
- **Ownership.** When `envs/prod/` lands it needs the same trail and the same budgets. If they lived in staging's state, prod would either duplicate them or fight staging for ownership. Neither is a state you want during Infra Week.
- **Locking.** A distinct key means a distinct S3 lockfile, so account applies and environment applies never block each other.

The bucket is shared only because it is bootstrap infrastructure that cannot manage itself (see `infra/README.md`); a second state bucket buys nothing.

## The eu-west-1 exception

`guardduty.tf` declares a detector in **eu-west-1** via the `aws.dr` aliased provider. This is the only non-eu-west-2 provider in the repo. It is permitted because:

1. **ADR 0007** names Ireland as the DR region — D30's single surviving named fallback, since the UK has exactly one AWS region.
2. **GuardDuty is a detective control.** It reads CloudTrail management events, VPC flow logs and DNS query logs and emits findings. It stores and processes **no customer documents**, so it moves no personal data out of the UK.
3. **eu-west-1 is already live in this account** (ADR 0007 records Cedofinance, visa-processing and needz running there), and it is where our DR copies will land. An unmonitored region in a shared account is where an attacker would prefer to operate.

Nothing else may be added to that provider without amending ADR 0007.

## Usage — the import-then-delete workflow

```bash
cd infra/envs/account
export AWS_PROFILE=nt        # PowerShell: $env:AWS_PROFILE="nt"
terraform init
terraform plan               # adopts via imports.tf — read the output carefully
terraform apply
git rm imports.tf && git commit   # one-shot by design
```

### What a correct first plan looks like

- **0 to create, 0 to destroy.** Every resource is covered by an import block in `imports.tf`. If the plan wants to *create* something, the import ID is wrong — fix the ID, never let it create a duplicate. A duplicate CloudTrail is a second copy of every management event, billed.
- **A small number of in-place tag additions.** This is expected and correct. The live trail, bucket and both detectors carry no tags at all; the `default_tags` block in `main.tf` adds `Project`/`Env`/`Owner`/`ManagedBy`, plus `DataClass=audit-log` and `Component=audit`. Under D36 cost attribution is per-tag, so `Project=neoting` on these resources is the difference between a visible line item and an invisible one. Budgets do not take tags.
- **No other changes.** Every argument in these files was read back from the live account on 13 Aug 2026. Anything else in the diff means live state has drifted since — investigate before applying.

Import blocks are inert after adoption. Leaving `imports.tf` in place would tell the next reader these resources are still unmanaged, which is the opposite of true.

## Deliberately not managed here

- **`Default-Services-Monitor`** (Cost Explorer anomaly detection) and `Default-Services-Subscription`. Created 2023-11-28, over two years before Neoting, notifying an address belonging to another Neovogent product. Shared-account furniture (D36) — adopting it would mean a Neoting `terraform destroy` deletes someone else's cost alerting. Neoting's own anomaly monitor is a create in a later PR (runbook Step 10).
- **The Terraform state bucket** `nt-tfstate-staging-252959251643`. Bootstrap; cannot manage itself. See `infra/README.md`.
- **SES production access and Textract quota increases.** Support-ticket flows, not resources. No Terraform representation exists. (SES: granted 17 Aug 2026, case resolved; both Textract cases still open.)

## Gaps — deliberately left open, each one a follow-up PR

These are real defects found while reading the live configuration. None is fixed here, because an adoption PR whose plan is *"0 create, 0 destroy"* is reviewable and one that also changes behaviour is not. Fix them in visible, separate diffs.

| # | Gap | Why it matters | Severity |
|---|---|---|---|
| 1 | **Neither budget has a cost filter.** Both track the entire shared account. | Cedofinance, visa-processing and needz spend counts against Neoting's $8,000 pot. Every figure these budgets report is somebody else's bill plus ours — directly contradicting Governance §13.5 / D36. Needs the `Project` cost allocation tag **activated first** (runbook Step 8; up to 24 h, not retroactive), or the filter silently matches nothing and both budgets read $0. | **High** |
| 2 | ~~**`neoting-pot-8000` starts 2025-08-01.**~~ **CLOSED 14 Aug 2026** — corrected to `2026-08-01`. Worth recording what the fix did and did not do: because AWS recurs an annual budget from its start month, the *current* period was already 2026-08-01 → 2027-07-31, so the figure was right by accident rather than wrong by a year. The file now states the intent instead of depending on that coincidence. The reported number did not move, and gap 1 is why. | — | ~~High~~ |
| 3 | **CloudTrail bucket has no lifecycle policy.** | Unbounded growth on a multi-region trail. Runbook Step 1.8 specifies a 400-day lifecycle to Glacier; Governance §12.2 sets the retention classes. Cheap now, a cost leak and a retention-compliance problem later. | Medium |
| 4 | **Budget alerts go to one personal Gmail, no SNS topic.** | Runbook Step 10.1 wants `eng@`/`ops@` **plus** SNS. A single human inbox is a single point of failure for the alert that says the pot is emptying. | Medium |
| 5 | **Trail logs use SSE-S3, not a CMK.** | In a shared account a CMK key policy could deny the other five admins, the way `alias/nt-staging-docs` does for documents (ADR 0008). Cost the KMS request volume before committing — a multi-region trail writes a lot of small objects. | Medium |
| 6 | **GuardDuty feature toggles are not codified.** | `aws_guardduty_detector_feature` does not support import blocks, so declaring them would have put creates in the adoption plan. Live as of 13 Aug 2026, both regions: CloudTrail, DNS logs, flow logs, S3 data events, EKS audit logs, EBS malware protection, RDS login events, Lambda network logs **enabled**; runtime monitoring, EKS runtime monitoring, AI protection, AI analyst **disabled**. Note that `ECS_FARGATE_AGENT_MANAGEMENT` being off means our Fargate tasks get no runtime monitoring — a conscious cost trade, but an undocumented one until now. | Low |
| 7 | **No AWS Access Analyzer.** | Runbook Step 1.8 and Step 10 line item 10 list it alongside CloudTrail and GuardDuty in the audit baseline. It is free. It was never created. | Low |
| 8 | **SSE-C block on the trail bucket is invisible to Terraform.** | The live bucket sets `BlockedEncryptionTypes: [SSE-C]`; AWS provider 5.60 has no schema for it. Harmless on a no-op plan, but any apply that rewrites the encryption resource drops it silently. Re-verify with `aws s3api get-bucket-encryption` after the first apply. | Low |

## Verified against live AWS

Every value in these files was read back from account `252959251643` on 13 Aug 2026 using read-only calls: `cloudtrail describe-trails` / `get-trail` / `get-event-selectors` / `get-trail-status`, `guardduty list-detectors` / `get-detector`, `budgets describe-budgets` / `describe-notifications-for-budget` / `describe-subscribers-for-notification`, `ce get-anomaly-monitors` / `get-anomaly-subscriptions`, and `s3api get-bucket-{location,policy,versioning,encryption}` / `get-public-access-block`.

Two absences worth recording because they are decisions, not omissions: the trail reports `HasCustomEventSelectors: false` and `HasInsightSelectors: false`, so no `event_selector` or `insight_selector` block is declared — data events and Insights are both metered, and both are priced against volume this account has plenty of. See the block comment in `cloudtrail.tf`.
