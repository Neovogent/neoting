# NEOTING — AWS Foundation Runbook (Kickoff §3)

**Version 1.1 · 13 August 2026 · Confidential**
*Changelog v1.0 → v1.1: legal entity resolved (NEOVOGENT AI SOLUTIONS UK LTD, 15946429) — §0.3 P-a closed; AWS spend envelope fixed at **$8,000 across 6 months** — Appendix B rewritten as a burn profile with per-account budget numbers and the credit-tracking caveat, Step 10 budgets made concrete, Step 7 AMP/AMG deferred to Infra Week per Guideline §8.5; **Step 6.2 corrected** — S3 SSE-KMS cannot carry a per-workspace encryption context, replacement design + ADR raised.*
Subordinate to the source-of-truth pair (SoT v1.4 · Governance v1.4) and the Team Engineering Guideline v1.1. It changes no locked decision; where it appears to, the pair wins and this file is wrong.

**Scope.** Everything needed to satisfy Kickoff Requirements §3.1–3.10, plus the AWS-side of §2.1–2.5 (DNS/SES), §4.10 (GitHub OIDC into AWS), and W0 verification items 8.1–8.5. Owner throughout: **Shakib (Eng lead)**, except where a row names Ops/CEO.

**Authority this runbook executes:**

| Decision | What it forces on this runbook |
|---|---|
| **D30** | UK-first. Every resource in **eu-west-2 (London)**. Only two named non-UK fallbacks: SES inbound receiving in eu-west-1 (verification 8.2) and the cross-region DR backup target. Anything else = versioned amendment, never a config change. |
| **D23** | ECS Fargate (api, web, workers) · CloudFront + AWS WAF (tightest on the OTP portal) · ElastiCache Redis · RDS Postgres 16 · S3/KMS · self-hosted Unleash · **all Terraform**. |
| **D22 / D28** | Claude via **Bedrock eu-west-2**, three tiers; Transcribe streaming en-GB. Contingency = Anthropic API under EU terms, ADR-logged. |
| **D20** | Textract `AnalyzeExpense` / `AnalyzeDocument` in eu-west-2. |
| **D24** | OTel → Managed Prometheus + Managed Grafana; CloudWatch logs; Sentry EU. |
| **D33 / Gov §13.5** | **No paid service goes live without a budget line, a usage metric, and an alert.** That is a gate, not a preference. |
| **G1 / G8** | Bootstrap runs free/disposable until Infra Week; AWS work is *deferred, not skipped*, and app code must not change when it lands. |
| **G2** | **Synthetic data only** on every environment until ICO registration (1.2) + DPIA (1.3) are done. Applies to staging and to prod. |

---

## 0. Read this first

### 0.1 The sequencing call (bootstrap vs the 7-day sprint)

Guideline G1 defers AWS to Infra Week. Sprint Plan §1 (P1) fires AWS org + Bedrock access requests on D0, and S3 builds **one staging environment** in Terraform on D2–D4. Both are true; they are different slices. Resolve it like this and note it in an ADR:

| Slice | When | Contents |
|---|---|---|
| **Slice A — control plane** (free, no running compute) | **Night one / D0** | Org, accounts, SSO, billing + budgets, Terraform state, Bedrock/Textract/Transcribe access + quota requests, DNS delegation, SES identities + production-access request. All of it is clocks-and-paperwork: start it before anything else, it costs ~£0. |
| **Slice B — staging only** | **Sprint D2–D4 (S3)** | VPC, RDS, ElastiCache, ECS api+workers, S3/KMS, SES wiring, CloudFront + basic WAF, secrets, AWS Budgets. One environment. `apps/web` stays on protected Vercel previews (G6/G10) for the sprint. |
| **Slice C — Infra Week** (G8 trigger: legal entity + spend approved) | Post-sprint | Production re-apply of the same modules, full WAF rulesets, Managed Prometheus/Grafana, Sentry, self-hosted Unleash, ClamAV service, full nine-stage CI (Gov §14), full D33 per-vendor telemetry. |

The measure of having done bootstrap right (G8): **the flip changes config and pipelines, never application code.**

### 0.2 Naming, tagging, accounts

```
Account aliases   neoting-mgmt · neoting-dev · neoting-staging · neoting-prod
Region            eu-west-2 everywhere (us-east-1 only for CloudFront ACM certs + WAF CLOUDFRONT scope)
Resource prefix   nt-<env>-<purpose>          nt-staging-api, nt-prod-docs
S3 buckets        nt-<env>-<purpose>-<account-id>   (globally unique, no dates)
Secrets           /neoting/<env>/<service>/<name>
KMS aliases       alias/nt-<env>-<dataclass>  (rds, docs, secrets, logs)
Terraform state   nt-tfstate-<env>-<account-id>  +  lock table nt-tflock
Flags (Unleash)   domain.change-description   default off (Gov §8)
```

Mandatory tags on everything, via Terraform `default_tags`:
`Project=neoting` · `Env=dev|staging|prod` · `Owner=eng` · `Component=<module>` · `DataClass=public|internal|customer-document|pii` · `ManagedBy=terraform`.
`DataClass` is not decoration — it is how §12.2 retention jobs and §13.5 cost attribution find their targets later.

### 0.3 Prerequisites before you open the console

| # | Prereq | Owner | Note |
|---|---|---|---|
| P-a | ✅ **RESOLVED 13 Aug 2026 — legal entity (Kickoff 1.1)** | CEO | **NEOVOGENT AI SOLUTIONS UK LTD**, company no. **15946429**, incorporated 10 Sep 2024, active. Registered office: Suite 5, The Cloisters, 11–12 George Road, Edgbaston, Birmingham, B15 1NP. This exact string goes on the AWS payer account, the AWS DPA (1.4), ICO registration (1.2), TrueLayer, Meta, Twilio, and the pilot agreements. UK-incorporated, so **no UK GDPR Art. 27 representative is required**. Confirmation statement due 23 Sep 2026 — a lapsed filing shows up in TrueLayer's compliance review. |
| P-b | Corporate payment card + billing address + VAT/tax details | CEO/Ops | Required at payer-account creation. |
| P-c | **Root email addresses — one per account, distribution lists, not personal inboxes** | Ops | `aws-root-mgmt@`, `aws-root-dev@`, `aws-root-staging@`, `aws-root-prod@` on a domain you control. Never a personal Gmail; never reuse across accounts (AWS forbids it). |
| P-d | Team password manager live (Kickoff 5.3) | Ops | Root passwords + MFA recovery codes go here and nowhere else. |
| P-e | Phone number that can receive the account-verification call | CEO/Ops | |
| P-f | Two TOTP authenticators available (or hardware keys) | Shakib | Root MFA per account; a single-device MFA on a payer account is a single point of failure. |
| P-g | Local tooling | Shakib | `aws` CLI v2, `terraform` ≥ 1.9, `session-manager-plugin`, `dig`, `jq`. |

> **Do not skip P-a.** Every DPA, ICO registration, TrueLayer/Meta/Twilio contract and the AWS bill must name the same entity (Kickoff 1.1, 1.4).

---

## Step 1 — AWS Organization, accounts, identity, billing (Kickoff 3.1) ⛔

**Blocks: everything.** Target: 90 minutes, night one.

### 1.1 Create the management (payer) account
1. Sign up at aws.amazon.com with root email `aws-root-mgmt@…`, account name **neoting-mgmt**, entity name exactly as P-a.
2. Complete billing, tax registration (UK VAT number if the entity has one), identity verification.
3. Set **account alias** (`neoting-mgmt`) so the sign-in URL is not a 12-digit number.

**The management account runs no workloads.** Organizations, Identity Center, billing, CloudTrail org trail, budgets. Nothing else.

### 1.2 Harden root (all four accounts, as each is created)
- Root MFA on — virtual TOTP minimum, hardware key preferred on mgmt + prod. Store the seed/recovery in the password manager (P-d).
- **Delete every root access key.** There must be zero.
- Set a strong unique root password (password manager).
- Fill **Alternate contacts** (Billing / Operations / Security) — Security should be a monitored inbox: this is where AWS sends abuse and vulnerability notices.
- Enable "IAM users and roles can access Billing information" in Account settings.
- After Identity Center exists, root is used **only** for the ~6 tasks that require it. Log every such use in `docs/adr/` or the ops log.

### 1.3 Enable Organizations
Console → AWS Organizations → Create organization → **All features** (not consolidated-billing-only; SCPs need all features).

Create OUs:
```
Root
├── Security        (future: log-archive, audit — leave empty now)
├── Workloads
│   ├── NonProd     → neoting-dev, neoting-staging
│   └── Prod        → neoting-prod
└── Suspended       (parking OU with a deny-all SCP, for account decommissioning)
```

### 1.4 Create member accounts
Organizations → Add account → **Create account** for each of `dev`, `staging`, `prod`, with the P-c root emails, then move each to its OU.

For each new member account immediately: 1.2 hardening (root MFA, no keys, alternate contacts) and set the account alias.

> AWS auto-creates `OrganizationAccountAccessRole` in each member account, assumable from mgmt. Keep it; it is your break-glass path if Identity Center breaks.

### 1.5 Service control policies — this is where D30 becomes enforceable
Attach at Root (so mgmt is covered too), three policies:

**SCP-1 `deny-outside-uk-region`** — the residency guardrail.
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenyOutsideApprovedRegions",
    "Effect": "Deny",
    "NotAction": [
      "iam:*", "organizations:*", "sts:*", "route53:*", "route53domains:*",
      "cloudfront:*", "waf:*", "wafv2:*", "shield:*", "globalaccelerator:*",
      "support:*", "trustedadvisor:*", "health:*", "account:*", "artifact:*",
      "budgets:*", "ce:*", "cur:*", "aws-portal:*", "billing:*", "tax:*",
      "sso:*", "sso-directory:*", "identitystore:*", "notifications:*"
    ],
    "Resource": "*",
    "Condition": {
      "StringNotEquals": { "aws:RequestedRegion": ["eu-west-2", "us-east-1"] }
    }
  }]
}
```
`us-east-1` is allowed **only** because CloudFront certificates (ACM) and `CLOUDFRONT`-scope WAFv2 web ACLs can exist nowhere else. Fence it:

**SCP-2 `deny-workloads-in-us-east-1`**
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "NoDataServicesOutsideLondon",
    "Effect": "Deny",
    "Action": [
      "rds:*", "ec2:*", "ecs:*", "ecr:*", "elasticache:*", "s3:CreateBucket",
      "dynamodb:*", "secretsmanager:*", "bedrock:*", "textract:*",
      "transcribe:*", "ses:*", "sqs:*", "elasticloadbalancing:*", "aps:*", "grafana:*"
    ],
    "Resource": "*",
    "Condition": { "StringEquals": { "aws:RequestedRegion": "us-east-1" } }
  }]
}
```
If verification 8.2 forces SES inbound into eu-west-1, amend SCP-1 to allow `eu-west-1` **for `ses:*` only**, in a separate statement, with the ADR referenced in the policy description. That keeps the exception visible in the guardrail itself rather than buried in Terraform.

**SCP-3 `protect-security-baseline`** — deny for everyone except a named break-glass role:
`cloudtrail:StopLogging|DeleteTrail|UpdateTrail`, `guardduty:Delete*|Disable*`, `config:Delete*|Stop*`, `s3:PutBucketPublicAccessBlock` (removal), `kms:ScheduleKeyDeletion|DisableKey`, `organizations:LeaveOrganization`, and `account:CloseAccount`.

Test each SCP against a member account before you rely on it (assume the OrganizationAccountAccessRole and try a `ec2 describe-regions --region eu-central-1`; expect an explicit deny).

### 1.6 IAM Identity Center (SSO for humans) — no IAM users, ever
1. Enable Identity Center **in eu-west-2** (the instance is region-bound; choosing wrong means recreating it).
2. Identity source: the built-in store is fine for six people. Create users: shakib, abdullah, shamim, moyen, mubashir, shadman (the G9 reserves get **standing access from day one** — G9 says access granted during an emergency is not an emergency plan).
3. **Enforce MFA** for all users; "require MFA every time" for the admin permission set.
4. Permission sets:

| Permission set | Policy | Session | Assigned |
|---|---|---|---|
| `NT-Admin` | `AdministratorAccess` | 1 h | Shakib → all accounts; Mubashir → dev/staging (G9 reserve) |
| `NT-Engineer` | `PowerUserAccess` + explicit deny on `iam:*` write, `kms:ScheduleKeyDeletion` | 8 h | Abdullah → dev, staging |
| `NT-ReadOnly` | `ReadOnlyAccess` (+ deny `s3:GetObject` on customer-document buckets) | 8 h | Shamim, Moyen, Shadman → staging |
| `NT-Billing` | `Billing` + `ce:*`, `budgets:*` | 4 h | CEO/Ops → mgmt |
| `NT-BreakGlass` | `AdministratorAccess` | 1 h | Unassigned; assignment is an audited manual act |

5. Configure the CLI: `aws configure sso` → profiles `nt-dev`, `nt-staging`, `nt-prod`, `nt-mgmt`. **No long-lived access keys exist anywhere for humans** (Gov §11.5 in spirit; machine access is OIDC only — Step 2.4).

### 1.7 Billing & the first budget (the D33 minimum)
In **mgmt**:
- Enable **Cost Explorer** (24 h to populate), and **Cost Allocation Tags** — activate `Project`, `Env`, `Component`, `DataClass` as user-defined cost allocation tags the day they first appear on a resource (they only become filterable *after* activation, so do it now).
- **AWS Budgets** (this is Kickoff 3.1's "billing alerts", expanded properly in Step 10): one org-wide monthly cost budget + one per member account, alerting at **50 / 80 / 100% of actual and 100% of forecast**, to an SNS topic and to `eng@`/`ops@`.
- Enable **Cost Anomaly Detection** with an AWS-services monitor and a daily-summary subscription.
- Turn on **Invoice/Bill delivery to Ops** and check the entity name on the first invoice matches P-a.

### 1.8 Audit baseline (do it before any workload exists)
- **Organization CloudTrail** in mgmt, applied to all accounts and all regions, writing to `nt-mgmt-cloudtrail-<acct>` (KMS-encrypted, versioned, public access blocked, 400-day lifecycle to Glacier). Enable **log file validation**.
- **GuardDuty** enabled org-wide with auto-enable for new accounts (≈ low £/month at this size; it is the cheapest early-warning you will buy).
- **IAM Access Analyzer** at org scope (finds any resource shared outside the org — including an accidentally public S3 bucket holding client documents).
- Account-level **S3 Block Public Access** ON in all four accounts.
- **EBS encryption by default** ON in eu-west-2 in all four accounts.

### 1.9 Done when
- [ ] Four accounts exist, correct OUs, aliases set, root MFA'd with zero root access keys.
- [ ] SCP-1 verified by a real denied call in a non-approved region.
- [ ] Every human signs in through Identity Center; no IAM users exist.
- [ ] Org CloudTrail writing; GuardDuty green; Access Analyzer active.
- [ ] Budgets firing to a real inbox (test with a £0.01 threshold budget, then delete it).

---

## Step 2 — Terraform state bootstrap + CI identity (Kickoff 3.2, 4.10)

### 2.1 The chicken-and-egg
State backend cannot be created by the Terraform that uses it. Create it with the CLI, once per account, then never touch it by hand again.

```bash
# repeat per account with the matching SSO profile
export AWS_PROFILE=nt-staging ENV=staging
ACCT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="nt-tfstate-${ENV}-${ACCT}"

aws s3api create-bucket --bucket "$BUCKET" --region eu-west-2 \
  --create-bucket-configuration LocationConstraint=eu-west-2
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"},"BucketKeyEnabled":true}]}'
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration '{"Rules":[{"ID":"expire-noncurrent","Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":90}}]}'

```
**No DynamoDB lock table.** Terraform ≥ 1.11 locks state natively in S3 (`use_lockfile = true`); the S3 backend's `dynamodb_table` parameter is deprecated. One less resource to create, own, and pay for.
Add a bucket policy denying `s3:*` when `aws:SecureTransport = false`. Enable S3 server access logging or CloudTrail data events on the state bucket — state files contain resource metadata and occasionally secrets material.

### 2.2 Repository layout (`infra/`, owned by Shakib per Guideline §2)
```
infra/
  modules/
    network/        vpc, subnets, nat, endpoints, security groups
    data/           rds, elasticache, parameter groups, subnet groups
    compute/        ecs cluster, services, task defs, ecr, autoscaling
    edge/           acm, cloudfront, waf, alb, route53 records
    storage/        s3 buckets, kms keys, lifecycle, replication
    observability/  log groups, amp, amg, otel collector, alarms
    email/          ses identities, dkim, receipt rules, mx
    security/       iam roles, oidc provider, secrets manager scaffolding
    cost/           budgets, anomaly monitors, cur export
  envs/
    dev/            main.tf backend.tf terraform.tfvars
    staging/
    prod/
  bootstrap/        the CLI script above, checked in for reproducibility
```
Rules: modules take no defaults that differ per environment; every module output is explicit; provider and module versions pinned; `required_version` pinned; `default_tags` set in the provider block (§0.2). `infra/` is a LAW-adjacent path in CODEOWNERS (`@shakib`) — changes are PRs, never console clicks. Anything created by hand in the console during W0 gets an issue titled "import to Terraform" and dies within the sprint.

### 2.3 Backend config
```hcl
terraform {
  required_version = ">= 1.11"
  backend "s3" {
    bucket       = "nt-tfstate-staging-<acct>"
    key          = "staging/core.tfstate"
    region       = "eu-west-2"
    use_lockfile = true   # S3-native locking; dynamodb_table is deprecated
    encrypt      = true
  }
  required_providers { aws = { source = "hashicorp/aws", version = "~> 5.60" } }
}
```
No `profile` in the backend block — credentials come from `AWS_PROFILE` locally and OIDC in CI. Hardcoding a local profile name breaks the CI path.
Split state by blast radius: `core.tfstate` (network + data), `app.tfstate` (compute + edge), `obs.tfstate`. A single monolithic state makes every apply a production risk.

### 2.4 GitHub OIDC → AWS (no static CI keys — Kickoff 4.10)
In each of dev/staging/prod:
```hcl
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [var.github_oidc_thumbprint]   # verify current value at apply time
}
```
Role trust policy — scope it to the repo **and** the ref, or any fork PR can assume it:
```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::<acct>:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:<org>/neoting:ref:refs/heads/main"
    }
  }
}
```
Two roles per account: `nt-<env>-ci-deploy` (ECR push, ECS deploy, `prisma migrate deploy` via a task, read the deploy secrets) and `nt-<env>-ci-plan` (read-only + state access, for PR plans). Staging deploys from `main`; **prod deploy role additionally requires a GitHub Environment with required reviewers** — that is the "one-click promote" of D23/Gov §14.9.

### 2.5 Done when
- [ ] `terraform init && terraform plan` runs clean in `envs/staging` from a fresh clone with only an SSO login.
- [ ] A GitHub Actions job assumes `nt-staging-ci-plan` and prints the caller identity. Zero AWS secrets in GitHub secrets besides nothing (the role ARN is not a secret).
- [ ] Kickoff §7.5 satisfied: zero secrets in the repo, OIDC works.

---

## Step 3 — Bedrock model access (Kickoff 3.3 ⛔ · verifications 8.1, 8.3)

**Start this on night one — access enablement is per account and can take hours to days.** Blocks W2 calibration and every LLM task.

### 3.1 Request access, per account
For **dev, staging, prod** separately (access does not inherit through the org):
Console → Bedrock (eu-west-2) → **Model access** → Manage model access → enable the Anthropic Claude models corresponding to `MODELS` in Gov §9.1: **Opus 4.8 · Sonnet 4.6 · Haiku 4.5**. Submit the use-case questionnaire if prompted (describe: UK accounting document processing, structured extraction and classification, human-in-the-loop approval, no training on customer data).

Then verify from the CLI, don't trust the console tick:
```bash
export AWS_PROFILE=nt-dev
aws bedrock list-foundation-models --region eu-west-2 \
  --by-provider anthropic --query 'modelSummaries[].[modelId,inferenceTypesSupported]' --output table
aws bedrock list-inference-profiles --region eu-west-2 --output table
```

### 3.2 ⚠ The residency question you must answer here, not later
Record the answer for **each of the three models**:

1. Is it available for **on-demand invocation in eu-west-2 directly**? → clean, D30-compliant, proceed.
2. Is it available **only via a cross-region inference profile** (an `eu.anthropic.*` profile)? → those profiles route requests across **multiple EU regions**, not the UK. Under **D30 that is processing outside the UK and is not one of the two named fallbacks** — so it is a **versioned amendment to the SoT, a CEO/legal decision, not an engineering config choice**. Escalate the same day.
3. Not available at all in-region? → contingency per D22/4.13: Anthropic API under EU processing terms, ADR logged, guardrail recomputed.

This is the single highest-consequence finding in the whole AWS foundation. Do not let it be discovered in W3.

### 3.3 Verify effort/thinking parameters (verification 8.3)
For each model, make one real call exercising the effort/thinking-budget parameter and record the exact parameter name, enum values, and whether it is supported at all:
```bash
aws bedrock-runtime converse \
  --region eu-west-2 --model-id <resolved-id> \
  --messages '[{"role":"user","content":[{"text":"Reply with the single word: ok"}]}]' \
  --inference-config '{"maxTokens":16,"temperature":0}'
```
Feed the result straight into `apps/api/src/modules/chat-framework/models.ts` `TASKS` (Gov §9.1). Where a model lacks the parameter, map that entry to a thinking-token budget or a plain call — **the task→(model, effort) map is the contract**, per 8.3.

### 3.4 Pricing → the guardrail (verification 8.1)
Pull actual eu-west-2 per-1k-token input/output prices for all three models and compute the blended per-document figure against SoT §16's composition (Textract ~£0.008/page + Haiku triage + Sonnet coding call with prompt caching + amortised Opus). **If it exceeds £0.02/document, the guardrail is recomputed and ADR-logged — it is not silently exceeded.**

### 3.5 IAM, logging, and cost telemetry
- Task role policy: `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, `bedrock:Converse*` scoped to the **exact model ARNs** (never `Resource: "*"` — that is how a demoted tier silently invokes an unevaluated model, which Gov §9.1 forbids).
- Enable **Bedrock model invocation logging** → CloudWatch Logs + S3. ⚠ This captures prompts and completions, i.e. document content: put it in a KMS-encrypted bucket with a **90-day lifecycle** to match Gov §12.2 ("Model I/O payloads (pseudonymised) — 90 days"), tag `DataClass=pii`, and confirm the PII-minimisation posture (§11.6) before enabling it in prod.
- CloudWatch metrics `InvocationLatency`, `InputTokenCount`, `OutputTokenCount` per model → Grafana panels (Step 7) and the per-firm budget logic (Gov §9.7).

### 3.6 Done when
- [ ] All three models invocable in **dev** at minimum (staging/prod may still be pending) — this is what unblocks S2.
- [ ] ADR `0001-bedrock-eu-west-2-availability.md` written: availability per model, invocation route (in-region vs inference profile), effort parameter names, measured pricing, guardrail arithmetic, contingency triggered or not.
- [ ] `models.ts` reflects reality, not the plan.
- [ ] Fixture mode in `DocumentExtractor` works regardless (Sprint §8 kill-switch: lanes stay green if access lags).

---

## Step 4 — Textract & Transcribe quotas (Kickoff 3.4 · verifications 8.4, 8.5)

1. **Confirm service availability in eu-west-2** for `AnalyzeExpense`, `AnalyzeDocument` (TABLES/QUERIES) and Transcribe **streaming en-GB**. If either is absent in-region, that is a D30 escalation on the same footing as 3.2 — not a quiet region change.
2. Read current quotas: Service Quotas console → Textract → note `AnalyzeExpense` TPS (sync), async job concurrency, and pages-per-document limits; Transcribe → concurrent streaming transcriptions.
3. Compute pilot demand: 10 pilot practices × expected documents/day × peak factor (month-end burst is the real number — SoT §15.6 k6 profile assumes 10× soak). Request raises where headroom < 3× peak. **Raises take days — file them in W0 even if you think you don't need them.**
4. Smoke test with a real (synthetic) UK invoice:
```bash
aws textract analyze-expense --region eu-west-2 \
  --document '{"S3Object":{"Bucket":"nt-dev-docs-<acct>","Name":"samples/invoice-01.pdf"}}' \
  > out.json && jq '.ExpenseDocuments[0].SummaryFields | length' out.json
```
5. Record per-page price for the guardrail (feeds 3.4). Transcribe: run verification 8.5's **10 real en-GB utterances** and record a pass/fail floor.
6. IAM: task role gets `textract:AnalyzeExpense|AnalyzeDocument|Start*|Get*` and `transcribe:StartStreamTranscription` only, scoped where scoping is possible.
7. Both services get a budget line + usage metric + alert **before any traffic** (D33 go-live gate): Textract pages/day and Transcribe minutes/day as CloudWatch metrics, anomaly alert at > 3× the 7-day baseline (Gov §13.5).

---

## Step 5 — DNS, TLS and SES (Kickoff 2.1–2.5, 3.5 ⛔ · verification 8.2)

**Blocks email intake (W3), notifications, OTP-adjacent email.** SES production access review is ~1–2 days: submit night one.

### 5.1 Delegate the domain (2.1 ⛔)
1. In **prod** (the account that will own the public zone): Route 53 → create public hosted zone `neoting.neovogent.com`. Copy the 4 NS records.
2. At the `neovogent.com` DNS provider, add the NS delegation for the `neoting` subdomain.
3. Verify: `dig NS neoting.neovogent.com +short` returns the Route 53 nameservers.
4. Cross-account: dev/staging use `dev.neoting.neovogent.com` / `staging.neoting.neovogent.com` subzones delegated from the prod zone, or a role in prod that the staging pipeline assumes for record writes. Decide once and Terraform it — ad-hoc console records are how DNS rots.

### 5.2 Certificates (2.5)
- **Regional ACM cert in eu-west-2** for the ALB: `*.neoting.neovogent.com`.
- **ACM cert in us-east-1** for CloudFront (the only permitted us-east-1 resource besides WAF) covering `app.` (workspace), `api.`, `portal.` — or a wildcard.
- DNS validation, records created by Terraform in the same apply. Auto-renewal requires those records to survive: never delete them.

### 5.3 SES outbound identity (2.3, 3.5 ⛔)
1. SES (eu-west-2) → **Create identity → Domain** `neoting.neovogent.com`, **Easy DKIM** (RSA_2048) → publish the 3 CNAMEs (Terraform).
2. **Custom MAIL FROM** subdomain `mail.neoting.neovogent.com` (+ MX and SPF TXT) so SPF aligns for DMARC.
3. DMARC: `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:dmarc@…` → tighten to `p=quarantine` once reports are clean. Chase-adjacent and onboarding email must not land in spam.
4. **Configuration set** with event destination (bounce/complaint/delivery → SNS → CloudWatch/queue) — bounce and complaint handling is exactly what the production-access reviewer asks about.
5. **Request production access** (sandbox exit) **per account**. In the request state: transactional-only email (document-processing notifications, supplier statement-gap requests, onboarding), no marketing, double-opt-in not applicable, bounce/complaint handling via SNS with automatic suppression, expected initial volume. Staging can stay in sandbox with verified test addresses if the reviewer pushes back — production access is only strictly required for prod.
6. Repeat identity setup for `neoting.com` the day it is acquired (D5/2.2) — **both `doc@` addresses must route identically through cutover** (SoT §21 risk row).

### 5.4 Inbound receiving (2.4 · verification 8.2) — the region trap
1. **Verify SES inbound receiving exists in eu-west-2.** Console → SES → Email receiving; or attempt to create a receipt rule set in-region.
2. If yes: MX record for `neoting.neovogent.com` → `inbound-smtp.eu-west-2.amazonaws.com` (priority 10). Receipt rule set:
   - Rule scoped to recipient `doc@neoting.neovogent.com`
   - Actions in order: **spam/virus verdict check** → **S3 action** writing to `nt-<env>-receipts-<acct>` (KMS-encrypted, `DataClass=customer-document`) → **SNS notification** (or S3 EventBridge) that feeds the ingestion queue (SoT §15: SES inbound → S3 → routing pipeline).
   - Bucket policy allows `ses.amazonaws.com` to `s3:PutObject` with `aws:Referer`/`aws:SourceAccount` conditions; KMS key policy allows SES to encrypt.
3. If eu-west-2 receiving is **unavailable**: this is the D30 named fallback — receive in **eu-west-1**. ⚠ Confirm whether the S3 receipt action requires a bucket in the same region as the receipt rule. If it does, the compliant pattern is: minimal landing bucket in eu-west-1 (`DataClass=customer-document`, **24-hour lifecycle expiry**, no other reader) → event-triggered copy into the eu-west-2 receipt bucket → delete source. Governance §12.1 says "receipt bucket stays eu-west-2"; that is satisfied by the landing bucket being a transit hop, and the ADR must say so explicitly.
4. Test end-to-end (Kickoff §7.4): send a real email to `doc@` → object appears in the receipt bucket → an ingest record is produced.

### 5.5 Done when
- [ ] `dig` confirms delegation; certs issued and validated.
- [ ] DKIM/SPF/DMARC pass on a test send (check headers at a Gmail/Outlook recipient).
- [ ] Production-access request submitted (record the case ID).
- [ ] ADR `0002-ses-inbound-region.md`: eu-west-2 or the eu-west-1 fallback with the transit-hop design.
- [ ] Test email → receipt bucket → ingest record (Kickoff §7.4 ✓).

---

## Step 6 — Core infra modules (Kickoff 3.6) — Terraform, staging first

Apply order matters: `network → storage/kms → data → security/secrets → compute → edge`.

### 6.1 Network (`modules/network`)
- VPC `10.20.0.0/16` (staging) / `10.30.0.0/16` (prod) — **non-overlapping**, so peering or a shared services VPC is possible later without renumbering.
- 3 AZs (`eu-west-2a/b/c`). Public subnets (ALB, NAT), private-app subnets (ECS tasks), private-data subnets (RDS, ElastiCache). `/20` app, `/24` data.
- **NAT:** one NAT gateway in staging (cost), one per AZ in prod (availability). NAT is a meaningful line item (~£30/month each plus data processing) — this is why the endpoints below matter.
- **VPC endpoints:** S3 **gateway** endpoint (free, do it always) + DynamoDB gateway. Interface endpoints for `ecr.api`, `ecr.dkr`, `logs`, `secretsmanager`, `kms`, `bedrock-runtime`, `textract`, `transcribe`, `sts`. Each interface endpoint costs ~£7/month per AZ — but it keeps document content and model traffic **off the public internet**, which is a residency and security posture argument (D30, Gov §11.9), not just a NAT-bill argument. Enable private DNS.
- Security groups, least privilege, referenced by SG-id not CIDR: `alb-sg` (443 from CloudFront prefix list) → `ecs-api-sg` (app port from alb-sg) → `rds-sg` (5432 from ecs-*-sg only) and `redis-sg` (6379 from ecs-*-sg only). **No 0.0.0.0/0 ingress anywhere except the ALB, and the ALB only from the CloudFront managed prefix list.**
- VPC Flow Logs → CloudWatch, 30-day retention (matches Gov §12.2 "application logs / traces 30 days").
- **No bastion, no SSH.** ECS Exec (SSM) for debugging, disabled in prod by default and audited when enabled.

### 6.2 Storage & keys (`modules/storage`)
KMS customer-managed keys (rotation on, aliases per §0.2): `nt-<env>-docs`, `nt-<env>-rds`, `nt-<env>-secrets`, `nt-<env>-logs`.

**⚠ Per-workspace encryption context (SoT §15, Gov §5.2) — the literal design does not work. Decide this in W0.**

SoT §15 and Gov §5.2 say "each workspace has its own KMS encryption context". With **S3 server-side encryption (SSE-KMS) you cannot supply an arbitrary encryption context** — S3 sets it itself from the bucket/object ARN. The two ways to honour the wording literally both break something:

| Option | Why it fails here |
|---|---|
| One CMK per workspace | $1/key/month × every client workspace, plus a hard account key limit. Doesn't scale past a few hundred clients. |
| Client-side encryption (S3 Encryption Client), where you *do* control the context | **Breaks Textract.** Textract reads objects from S3 itself for the async multi-page path; it cannot decrypt client-side-encrypted objects. You'd be forced to inline bytes, which caps you at the sync-API size limit and kills the 300-page statement path (SoT Stage 2). |

**The design that actually holds the guarantee:** one CMK per environment (`nt-<env>-docs`), **workspace-prefixed object keys** `w/<businessId>/…`, and isolation enforced where it is already enforced everywhere else — IAM/bucket-policy conditions on the prefix, per-request presigned URLs scoped to a single object, RLS-scoped services deciding which key any caller may ever name, and delegated OTP sessions restricted to the granted item IDs (Gov §5.2). That is a *stronger* control than an encryption context, because it gates access at request time rather than at decrypt time. Enable **S3 Bucket Keys** on the docs bucket while you are there — it cuts KMS request charges by up to ~99% on a read-heavy document store.

**Action:** ADR `0008-s3-workspace-isolation.md` recording the constraint and the chosen design, and raise a one-line amendment to Gov §5.2 / SoT §15 wording at the next version bump so the doc describes what is actually built. Do not let this sit as a silent divergence — tenancy language that overstates the mechanism is worse than none.

Buckets (all: versioning on, public access blocked, TLS-only policy, `DataClass` tagged, access logging or CloudTrail data events on):

| Bucket | Purpose | Lifecycle / notes |
|---|---|---|
| `nt-<env>-docs-<acct>` | Original documents — **immutable source of truth** | Versioned; keys workspace-prefixed `w/<businessId>/…`; consider Object Lock (governance mode) in prod; no lifecycle deletion — retention is 6 years (Gov §12.2) enforced by application jobs |
| `nt-<env>-receipts-<acct>` | SES inbound raw email | 30-day expiry after successful ingest |
| `nt-<env>-exports-<acct>` | Generated exports/ZIPs | 30-day expiry; virus-scanned before download link issue |
| `nt-<env>-logs-<acct>` | ALB/CloudFront/S3 access logs | 30–90 day expiry |
| `nt-<env>-quarantine-<acct>` | ClamAV failures | Restricted read; alert on put |

Cross-region replication of `docs` → the DR region (D30's second named fallback; EU by necessity since the UK has one AWS region). Set it up in the same PR that sets up RDS backups so DR is one decision, not two half-decisions.

### 6.3 Data (`modules/data`)
**RDS Postgres 16:**
- Private data subnets, `publicly_accessible = false`, KMS-encrypted with `nt-<env>-rds`.
- Staging: `db.t4g.medium`, single-AZ. Prod: `db.m7g.large`+, **Multi-AZ**.
- **Backup retention 35 days** (PITR — Kickoff 3.6, Gov §17), preferred backup/maintenance windows outside UK business hours.
- Parameter group: `rds.force_ssl=1`, `log_min_duration_statement=100` (feeds Gov §5.1's "any query > 100 ms gets an EXPLAIN"), `log_statement=ddl`, sensible `work_mem`.
- Performance Insights on (7-day free tier), Enhanced Monitoring 60 s.
- Master credentials in **Secrets Manager with managed rotation**; the app never uses the master user.
- **⚠ RLS-critical (Gov §5.2):** create a dedicated application role that is **not the table owner and not superuser**, because Postgres RLS is bypassed by table owners unless `FORCE ROW LEVEL SECURITY` is set. Migration role owns the schema; app role only gets DML. Get this wrong and the entire tenancy guarantee is decorative. Add it to the CI tenancy suite (§15.4) as an assertion, not a comment.
- Nightly logical backup (`pg_dump`) job → DR-region bucket, encrypted (Gov §17).

**ElastiCache Redis (BullMQ + cache):**
- Redis OSS 7.x, **cluster mode disabled** (primary + replica) unless someone is prepared to own hash-tag key design — BullMQ's key patterns are unhappy in cluster mode. Staging may run a single node.
- Encryption at rest (KMS) + **in transit (TLS)** + AUTH token in Secrets Manager.
- Private data subnets, `redis-sg` only. Automatic failover in prod.
- Key convention is enforced in code, not infra: `nt:{practiceId|_}:{businessId}:{domain}:{id}` (Gov §6) — every key carries the workspace segment.

### 6.4 Compute (`modules/compute`)
- **ECR** repos: `nt/api`, `nt/web`, `nt/workers`. Scan-on-push, immutable tags, lifecycle policy keeping the last 30 images.
- **ECS cluster** `nt-<env>` on Fargate, Container Insights on.
- Services: `api` (2 tasks min), `workers` (BullMQ consumers, separate service so they scale on queue depth not on HTTP), `web` (added at Infra Week — Vercel covers the sprint per G6).
- **Two roles per task, and the distinction matters:** *execution role* (pull from ECR, write logs, read the secrets injected at start) vs *task role* (what the app itself may do at runtime: S3 docs bucket, KMS with workspace context, Bedrock model ARNs, Textract, Transcribe, SES send, Secrets Manager reads). Never merge them.
- Secrets injected via the task definition `secrets` block from Secrets Manager — **never** plaintext `environment` values (Gov §11.5).
- Log driver `awslogs` → `/nt/<env>/<service>`, **30-day retention** (Kickoff 3.7).
- Autoscaling: api on CPU/ALB request count; workers on a custom CloudWatch metric of queue depth/age (Gov §13.2 alerts on queue age > 5 min — scale before the alert).
- Health checks: `/healthz` (liveness) and `/readyz` (DB + Redis reachable). Deployment circuit breaker with **rollback enabled** — this is the "auto-rollback on health regression" of Gov §14.9/§16.
- Migrations: a one-off ECS task running `pnpm prisma migrate deploy` in the deploy pipeline (Gov §1.3 — `migrate deploy` is the only migration command outside local machines).

### 6.5 Edge (`modules/edge`)
- **Internal ALB** (or internet-facing but locked to the CloudFront managed prefix list + a secret origin header the ALB rule requires). Public origins that bypass CloudFront also bypass WAF.
- **CloudFront distributions:** `app.` (workspace, SSR/Next), `api.` (no cache for mutations; cache reference data by policy), `portal.` (**the lightest surface in the product** — SoT §14; aggressive static caching, minimal JS).
- Security headers via CloudFront response-headers policy: HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, restrictive `Permissions-Policy`, and CSP (nonce-based CSP is emitted by the app; the portal ships the tightest CSP — Gov §11.9).
- **WAF (CLOUDFRONT scope, us-east-1)** — one web ACL per distribution, not one shared:
  - Managed rule groups: `AWSManagedRulesCommonRuleSet`, `KnownBadInputs`, `SQLiRuleSet`, `AmazonIpReputationList`, `AnonymousIpList` (count-mode first on the workspace to avoid blocking accountants behind corporate proxies).
  - **Portal ruleset is the tightest (D23):** rate-based rule ~100 req/5 min per IP on `/portal/*`; a much tighter rate-based rule on OTP request/verify paths to back the Gov §11.8 limits (3 per number/10 min, 10 per IP/hour) at the edge as well as in the app; body-size limits; block non-GET/POST.
  - **Do not geo-block.** Chase links are deliberately forwardable (SoT Stage 8.3) and a client may open one abroad.
  - Logging → Kinesis Firehose → S3, with a Grafana/Athena view; alarm on blocked-request spikes.
- Route 53 alias records → CloudFront; health checks on the api origin.

### 6.6 Secrets & events
- **Secrets Manager** paths per §0.2. Rotation enabled on RDS master; per-integration tokens (Xero/QBO/TrueLayer/Twilio/Meta) live in the DB vault table encrypted (SoT §18), *not* in Secrets Manager — Secrets Manager holds the platform credentials, the vault table holds per-tenant OAuth tokens.
- **EventBridge Scheduler** for the chase policy engine cadence, consent-reconfirmation sweeps (90-day, Stage 7), retention jobs (Gov §12.2), nightly backups, and the nightly integration agent (SoT §19.1).
- SQS queues only where AWS events need buffering (S3 → ClamAV, SES → ingestion). BullMQ on Redis remains the application job spine (D23).

### 6.7 Done when
- [ ] `terraform apply` in `envs/staging` from zero produces a reachable, TLS-terminated, WAF-fronted staging stack.
- [ ] A task can read document objects **only under the `w/` prefix**, and an unprefixed `ListBucket` is denied (test both deliberately). *Corrected: this row previously demanded a per-workspace encryption context, which §6.2 above proves S3 cannot provide — the two rows contradicted each other. ADR 0008 records the replacement design and the honest limit: the IAM layer bounds the namespace, not the tenant.*
- [ ] The app DB role cannot bypass RLS (assert in the tenancy suite).
- [ ] Kickoff §7.3 satisfied: staging deployed by CI with real sandboxes wired.

---

## Step 7 — Observability (Kickoff 3.7 · D24)

1. **CloudWatch log groups** created by Terraform (never auto-created by services — auto-created groups have infinite retention and no KMS): `/nt/<env>/<service>`, **30-day retention**, encrypted with `nt-<env>-logs`.
2. **Amazon Managed Prometheus (AMP) + Managed Grafana (AMG) are Infra Week, not the sprint** — Guideline §8.5 already defers them, and under the $8,000/6-month envelope (Appendix B) they are ~$40–70/month you do not need while one staging environment exists. **CloudWatch dashboards + metric alarms satisfy Kickoff §7.6 now** ("dashboards live: error rate, p95, queue age, token spend") at a few dollars a month. When AMP/AMG land: one workspace per environment, AMG authenticated via **IAM Identity Center** (Step 1.6) so Grafana access follows the same identity as everything else; AMG bills per active user per month (~$9 editor / ~$5 viewer — verify), AMP per sample ingested and stored. **Emit OTel from day one regardless** — the collector's `remote_write` target is config; the instrumentation is not, and retrofitting trace propagation across BullMQ later is a rewrite. Metric-cardinality discipline starts now: never label a metric with a document ID, user ID, or workspace ID.
3. **ADOT / OTel collector** as a sidecar in each ECS task (or a daemon service), receiving OTLP from the app and `remote_write`-ing to AMP with SigV4. Traces: OTel spans across route → service → LLM call → DB → queue → adapter, propagating `traceId` into job handlers, webhooks, email-in and SMS sends (Gov §13.1). One `trace_id` per entry point, travelling everywhere — wire this now, because retrofitting trace propagation across BullMQ later is a rewrite.
4. **Sentry (EU region)** — org + per-app DSNs (Kickoff 4.9), scrubber verified against the `(SECRET|TOKEN|KEY|PASSWORD)` pattern **and** against PII (Gov §11.5/§11.6) before it points at anything but dev.
5. **Dashboards that must exist at W0 (Kickoff §7.6), even at zero traffic:** error rate · p95 latency · queue age · **token spend**. Add the pipeline set as the modules land: extraction p95, correction rate, routing accuracy, chase response time, publish-failure rate, DLQ size, `ai.fallback.count`, eval drift (Gov §13.1).
6. **Alarms → SNS → the on-call channel** (Gov §13.2): error rate > 2% over 5 min · p95 > 1 s over 10 min (non-LLM) · extraction p95 > 5 min over 30 min · queue age > 5 min · DLQ non-empty > 4 h · token-spend anomaly > 3× baseline · SMS delivery failure spike · integration token expiring unhandled · failed backup. **Route them to a channel a human actually watches** — Gov §13.2's parenthetical ("not a dead channel") is the requirement.

---

## Step 8 — ClamAV scanning path (Kickoff 3.8)

A build item, no external account. It sits at a fixed position in the upload pipeline (Gov §11.4): magic-byte sniff → extension allowlist → size cap per channel → **virus scan** → EXIF/HEIC normalisation → PDF safety → ZIP explode with caps.

**Recommended shape:** S3 `docs`/`receipts` PutObject → EventBridge → SQS → **ECS Fargate scanner service** (container with clamd, kept warm) → tags the object `av-status=clean|infected` → clean objects emit the domain event that starts extraction; infected objects move to `nt-<env>-quarantine-<acct>` and raise an operator alert plus a plain-language message to the submitter (SoT Stage 1).

- Definitions: a scheduled `freshclam` job publishes the signature DB to a private S3 prefix; scanner tasks pull on start and refresh hourly. Never let tasks hit the public mirrors on every start.
- Lambda is viable for small files but the cold-start + 500 MB definition load makes an always-warm Fargate service simpler at accountant-batch sizes (100 MB uploads, ZIPs).
- **The extraction pipeline must not read an object that is not tagged clean.** Enforce it in the worker, and test it with the EICAR test file in CI.

---

## Step 9 — Self-hosted Unleash (Kickoff 3.9 · D23)

- ECS service `nt-<env>-unleash` + a dedicated database on the existing RDS instance (separate DB, separate role — not the app DB).
- Internal-only admin UI: behind CloudFront + WAF with Identity Center-fronted auth, or accessible only via the private network. It is a kill-switch console; treat it like one.
- Client SDK tokens in Secrets Manager; the app reads flags through one wrapper module.
- **Bootstrap parity (Guideline §8.5):** until this exists, a local flags file **behind the same interface**. The G8 test is that flipping to the server changes config only.
- Conventions (Gov §8): naming `domain.change-description`, default **off** in production, owner + removal date per flag, stale > 90 days = tech debt issue. Standing kill switches required per AI feature, per extraction vendor, per ledger adapter, and **per outbound channel (SMS, email, WhatsApp intake)**.

---

## Step 10 — Central usage & cost monitoring (Kickoff 3.10 · D33 · Gov §13.5)

*"A surprising bill is an alerting failure, not a billing surprise."* Build this **before** traffic, not after the first invoice.

1. **AWS Budgets** — set to the real envelope (Appendix B), not a round number:
   - **One `ANNUALLY`-period budget of $8,000 starting Aug 2026** = the cumulative burn tracker against the approved pot; alerts at 50/80/100%. Budgets has no six-month period, so the annual budget with a fixed start is how you see "how much of the pot is gone".
   - **Monthly budgets per account:** dev $100 · staging $250 · prod $900 (from the month prod stands up) · mgmt $25 — alerts at **50/80/100% of actual and 100% of forecast** → SNS + email.
   - **Per-service budgets with cost filters:** Bedrock, Textract, Transcribe, SES.
   - ⚠ **If the $8,000 is credits, uncheck "Credits" in each budget's included cost types.** Otherwise credits net the tracked cost to ~$0 and every alert stays silent until the pot is empty — the single most common way a credit-funded project discovers its burn rate. Also record the credit **expiry date**; unspent credits with a hard expiry change sequencing decisions.
2. **Cost Anomaly Detection** — a monitor per service dimension; alerts on usage > 3× the 7-day baseline (the same rule Gov §9.7 applies to AI spend).
3. **CUR 2.0 export → S3 → Athena → Grafana** (AMG has an Athena datasource). That is what makes per-service, per-tag, month-to-date spend a dashboard rather than a console visit. Activate the cost-allocation tags from §0.2 first, or the breakdown is blank.
4. **Non-AWS vendors** are the same discipline via application metrics, since AWS Budgets cannot see them: Twilio (SMS count, Verify checks), TrueLayer (calls), Meta, Sentry. The app emits usage counters as OTel metrics; a monthly **budget envelope** per vendor lives in config — warn at 80%, page at 100%. Enable Twilio's own provider-side spend triggers as belt-and-braces.
5. **Per-firm attribution** where the meter allows: AI tokens and SMS already are (Gov §9.7 Redis budgets `nt:{practiceId}:_:ai:budget:{date}`).
6. **The go-live gate, checked in the go-live review alongside the DPA:** *no paid service is enabled without its budget line, usage metric, and alert wired.* Keep the checklist in `docs/runbooks/` and tick it per vendor.
7. **Bootstrap corollary (G1/Gov §13.5):** free-tier meters (GitHub Actions minutes, Vercel build minutes, any Neon/Upstash quota) get a named owner and a weekly glance at the Friday demo until this replaces them.

---

## Step 11 — Security baseline before real data

These are not optional extras; they are what makes the pilot legal and the pen test (5.2, booked by W8) survivable.

- [ ] Org CloudTrail + GuardDuty + Access Analyzer live (Step 1.8).
- [ ] Zero IAM users; zero static access keys; OIDC for CI (Step 2.4).
- [ ] SCPs enforcing region and protecting the security baseline (Step 1.5).
- [ ] All S3 public access blocked at account level; TLS-only bucket policies.
- [ ] KMS CMKs with rotation on, and an **explicit `Deny` for any principal outside `role/nt-*`** in every key policy (D36's compensating control). *Corrected: "workspace encryption context enforced by key policy" was not achievable — see §6.2 and ADR 0008.*
- [ ] Secrets Manager only; **no secrets in the repo, in env files, or in Vercel** (Guideline §7.2 — the frontend needs none by design).
- [ ] RDS not publicly accessible, `force_ssl`, app role cannot bypass RLS.
- [ ] WAF in front of every public surface, tightest on the portal.
- [ ] **G2 gate: synthetic data only until ICO registration (1.2) + DPIA (1.3) are complete.** Prod carrying real client documents before those exist is the one mistake this runbook cannot undo.
- [ ] AWS DPA accepted under the correct legal entity (Kickoff 1.4 — one umbrella covering Textract, Bedrock, Transcribe, SES, RDS, S3), and Bedrock's no-training posture confirmed in writing (D19).

---

## Step 12 — The W0 gate: evidence, not assertions

### 12.1 Kickoff §7 "W0 done" — AWS-relevant rows

| Row | Evidence required |
|---|---|
| 7.3 Staging deployed by CI with real sandboxes wired, incl. **Bedrock dev access** | A CI run URL that deployed staging; a Bedrock invocation from a staging task |
| 7.4 Both `doc@` domains verified in SES; test email → receipt bucket → ingest record | The S3 object key + the ingest record ID |
| 7.5 Zero secrets in repo; all in Secrets Manager; OIDC from GitHub Actions works | Secret-scan output on the diff + a successful OIDC job log |
| 7.6 Dashboards live (error rate, p95, queue age, token spend) at zero traffic | Grafana screenshot in the Friday demo |

### 12.2 ADR register to write in W0 (`docs/adr/`)
Each one line to a page, per Kickoff §8's "each gets a one-line ADR":

| ADR | Subject | Source | Status |
|---|---|---|---|
| 0001 | Bedrock eu-west-2: model availability, invocation route (in-region vs inference profile), effort parameters, measured pricing vs the £0.02 guardrail | 8.1 / 8.3 | ✅ Accepted |
| 0002 | SES inbound receiving region + receipt-bucket topology | 8.2 | ✅ Accepted |
| 0003 | Textract `AnalyzeExpense` quotas + per-page pricing at pilot volume | 8.4 | ⏳ **Blocked** — verification 8.4 is not closed. The quota-increase requests are still `CASE_OPENED` (raised 13 Aug), so there are no measured quotas to write down. Writing it now would be fiction. |
| 0004 | Transcribe streaming en-GB quality floor (10 utterances) | 8.5 | ⏳ **Blocked** — verification 8.5 not run. |
| 0005 | AWS account topology, SCP set, and the Slice A/B/C sequencing (§0.1 of this runbook) | 3.1 / G1 / G8 | ✅ Accepted — also records that the G8 trigger fired on 13 Aug (D34 + D35) |
| 0006 | Terraform state layout + OIDC role scoping | 3.2 / 4.10 | ✅ Accepted |
| 0007 | DR region choice for the cross-region backup target (D30's last named fallback) | Gov §17 | ✅ **Accepted** — ratified 14 Aug 2026: eu-west-1 (Ireland), backup and replication targets only, nothing processes there. One follow-up stays open and it is the acceptance test, not the build: the quarterly restore drill has not run, so RTO ≤ 4 h is asserted rather than measured |
| 0008 | S3 encryption topology: request-time gating, not per-workspace keys | §6.2 / Gov §5.2 / SoT §15 | ✅ Accepted — cited by both governing documents, which is why it could not stay unwritten |

### 12.3 Escalations this runbook expects to generate
1. **Bedrock cross-region inference profiles vs D30** (Step 3.2) — CEO/legal, same day, versioned amendment or contingency route.
2. **SES inbound region** (Step 5.4) — engineering, but the ADR must state the transit-hop design.
3. **Legal entity (1.1)** — everything above names it; if it's not resolved night one, the payer account and every DPA sit on the wrong name.
4. **AWS spend approval** (SoT §22 open decision 2) — Slice B costs real money; Slice A is ~£0. Do not stall Slice A waiting for Slice B's approval.

---

## Appendix A — Night-one running order (the two hours that matter)

Sequenced by clock length, not by comfort. Everything here is Slice A: free, and everything else waits on it.

| # | Action | Clock started |
|---|---|---|
| 1 | Legal entity named (P-a) | Unblocks all contracts |
| 2 | Payer account + Organization + dev/staging/prod accounts | Everything |
| 3 | **Bedrock model-access requests in all three accounts** (Step 3.1) | Hours–days ⛔ |
| 4 | **SES production-access requests** (Step 5.3) | 1–2 days ⛔ |
| 5 | **DNS delegation of `neoting.neovogent.com`** (Step 5.1) | Hours ⛔ |
| 6 | Textract/Transcribe quota raises if headroom < 3× peak (Step 4) | Days |
| 7 | Identity Center + permission sets; everyone signs in once | Team unblocked |
| 8 | Budgets + Cost Anomaly Detection + Cost Explorer + tag activation | D33 gate |
| 9 | Terraform state buckets + lock tables + OIDC roles | All infra |
| 10 | Org CloudTrail + GuardDuty + Access Analyzer | Audit baseline |

Non-AWS clocks that start the same evening and are longer than all of the above — **Meta business verification (4.2), Twilio UK sender registration (4.1), TrueLayer production review (4.3), ICO (1.2)** — are Kickoff §9's critical path. AWS is not the long pole; do not let it consume the evening that those need.

## Appendix B — The $8,000 / 6-month envelope (approved 13 Aug 2026)

**The pot:** $8,000 (≈ £6,300) covering **13 Aug 2026 → ~13 Feb 2027**. Flat, that is $1,333/month — but the burn is nothing like flat, and planning against the average is how you run out in month five.

### B.1 Burn profile — the constraint is months 4–6, not the sprint

| Period | Shape | Est. /mo | Cumulative |
|---|---|---|---|
| Aug–Sep (W0–W8) | Staging only. Dev = local Docker Compose (G1), web = Vercel (G6) | **$130–170** | ~$300 |
| Oct (W9–W12) | Staging + prod stands up; pen-test window | **~$600** | ~$900 |
| Nov (W13–W14) | Prod + pilot onboarding, 10 practices | **~$1,100** | ~$2,000 |
| Dec–Feb | Pilot running: prod Multi-AZ, real document volume, Bedrock/Textract/SMS meters live | **~$1,300–1,500** | **~$6,300** |

Leaves **~$1,700 (21%) headroom**. The sprint is cheap; **prod-with-pilot-traffic is where the pot goes.** Every design decision that keeps *prod* cheap is worth ten that shave staging.

### B.2 Staging monthly, itemised (eu-west-2, verify against the pricing calculator)

| Item | ~$/mo | Note |
|---|---|---|
| RDS `db.t4g.small`, single-AZ, 50 GB gp3, 35-day PITR | 30 | PITR retention is non-negotiable (Gov §17); instance size is |
| ElastiCache `cache.t4g.micro` | 12 | Cluster mode **disabled** (BullMQ) |
| ECS Fargate — api 2 × 0.5 vCPU, workers 1 × 0.5 vCPU, **Spot for workers** | 30–40 | Spot is fine for staging; never for prod api |
| ALB | 18 | |
| CloudFront + one shared WAF web ACL | 10–15 | CloudFront's 1 TB/month free tier absorbs staging entirely |
| S3 + KMS (4 CMKs, Bucket Keys on) + Secrets Manager | 20 | One JSON secret per service, not one per value — Secrets Manager bills per secret |
| CloudWatch logs + dashboards + alarms | 15–25 | ⚠ **The sleeper line item.** Structured JSON at debug level on every request can quietly out-cost RDS. Info level in staging, sampled debug, 30-day retention |
| GuardDuty | 5–10 | Cheapest insurance you will buy |
| **Total** | **~$140–170** | |

### B.3 The four cost decisions made because of this envelope

1. **No interface VPC endpoints in staging** (~$8/endpoint/AZ/month; 8 of them ≈ $60). Gateway S3 endpoint only — it's free. Add the interface endpoints in **prod**, where keeping document and model traffic off the public internet is a residency/security argument (D30, Gov §11.9), not a bill.
2. **No NAT gateway in staging** (~$36/month + data). Staging Fargate tasks run in public subnets with `assign_public_ip = true` and security groups that allow **no inbound**; public IPv4 is ~$3.60/task/month. Defensible only because staging is synthetic-data-only (G2). **Prod gets a real NAT** — one to start, one per AZ when availability demands it.
3. **AMP + AMG deferred to Infra Week** (Step 7, Guideline §8.5) — CloudWatch dashboards satisfy Kickoff §7.6 for ~$3/month.
4. **Basic (free) AWS Support.** Developer support at $29/month is 2% of the pot for a response target you can get from documentation.

### B.4 Usage meters — small now, the whole game later

| Meter | W2 calibration | Pilot (10 firms) |
|---|---|---|
| Textract `AnalyzeExpense` (~$0.01/page) | 500-doc corpus × a few runs ≈ **$15–30 total** | The dominant per-document cost |
| Bedrock (three tiers) | Tens of dollars | Governed by the **< £0.02/document** guardrail (D28) + per-firm daily budgets |
| Transcribe streaming | Verification 8.5 = pennies | Low |

Two things follow. First, **W2 calibration is affordable — run it properly, more than once.** Second, the £0.02/document guardrail is not an abstract target here: at pilot volume it is the difference between the pot lasting six months and four. Wire the Step 10 dashboards before the meters turn on, not after the first invoice.

## Appendix C — What this runbook deliberately does not do

- **Does not create production workloads.** Prod account exists; prod infra is Slice C (Infra Week, G8).
- **Does not host `apps/web` on AWS during the sprint.** Vercel previews with Deployment Protection (G6/G10/R16) cover it; ECS web lands at Infra Week with zero app-code change.
- **Does not touch real customer data anywhere** (G2), and cannot until ICO + DPIA (1.2/1.3) are done.
- **Does not replace Governance §14's nine-stage CI** — thin CI (G3) holds until Infra Week.

*— End of AWS Foundation Runbook v1.0 —*
