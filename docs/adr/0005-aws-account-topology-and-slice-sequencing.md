# ADR 0005 — AWS account topology, the absent SCP set, and Slice A/B/C sequencing

**Status:** Accepted · **Date:** 13 August 2026 · **Decider:** Shakib (eng)
**Records:** D36, G1, G8, runbook §0.1 · **Constrains:** D30

---

## Context

Two things had to be decided together, because each one's answer changes the other: **which AWS accounts Neoting runs in**, and **what gets built when**.

The runbook asks for this explicitly (§0.1): *"Guideline G1 defers AWS to Infra Week. Sprint Plan §1 (P1) fires AWS org + Bedrock access requests on D0, and S3 builds one staging environment in Terraform on D2–D4. Both are true; they are different slices. Resolve it like this and note it in an ADR."* This is that ADR.

## Part 1 — Account topology

### What was measured, not assumed

| Fact | Verified value |
|---|---|
| Organisation | `o-4w28uo5lvn` |
| Feature set | `CONSOLIDATED_BILLING` |
| `AvailablePolicyTypes` | **`[]` — empty** |
| Management (payer) account | `776016087896`, `aws@cloudvisor.eu` (the reseller) |
| Neoting's account | `252959251643`, shared |
| IAM users in that account | **7** — `cedofinances`, `jabidhasan`, `Khandokar`, `mahdi`, `mehedi`, `Minju`, and `Mubashir` (ours) |

**Service Control Policies are not merely unused — they are unavailable.** `AvailablePolicyTypes` being empty is the API confirming that a consolidated-billing organisation cannot attach SCPs at all. This is not a permissions problem we can escalate; it is a property of the organisation type, and the organisation belongs to the reseller.

### Decision

**Run in the shared account now; keep every control Terraform-defined so that moving is a variable change.**

D30's region guardrail, which an SCP would have enforced organisation-wide and irremovably, is instead an **IAM policy (`nt-region-guardrail`) attached to every Neoting principal**. Say the difference out loud rather than letting it blur: an SCP cannot be removed by an account admin, and this can. Six other administrators exist in this account. The control is real and it constrains everything we run — but it is a fence, not a wall.

Compensating controls, all verified live:

- **Explicit `Deny` in the bucket and KMS key policies** for any principal not matching `role/nt-*` (plus the named human and root). Explicit deny beats any IAM allow, so casual and accidental cross-product access is blocked outright.
- **CloudTrail `neoting-audit`** — multi-region, log-file validation on. A multi-region sweep across 19 regions confirmed it is the **only** trail in the entire account: no audit trail existed here before 13 Aug 2026.
- **GuardDuty** in exactly two regions, eu-west-2 and eu-west-1, and nowhere else.

So a determined admin can still rewrite those policies — but that act is now recorded, where previously it would not have been.

### The `role/nt-*` naming contract is load-bearing

Every deny guard keys off `arn:aws:iam::252959251643:role/nt-*`. **Any new role that must touch Neoting S3 or KMS must be named `nt-*` or it is denied.** This is easy to trip over and silent when you do — the failure looks like a permissions bug, not a naming bug.

### The honest limit

**This is mitigation, not isolation.** The DPIA must describe the account as shared until dedicated `neoting-dev/staging/prod` accounts land. They have been requested from Cloudvisor. Everything is Terraform so that migration is a variable change, per `infra/README.md` — with one gap that had to be closed before that claim was true (see Consequences).

## Part 2 — Slice sequencing

The apparent contradiction between G1 ("AWS is deferred to Infra Week") and Sprint Plan P1 ("build staging on D2–D4") dissolves once the work is cut by cost rather than by calendar:

| Slice | When | Contents |
|---|---|---|
| **A — control plane** | Night one / D0 | Org, accounts, SSO, billing + budgets, Terraform state, Bedrock/Textract/Transcribe access and quota requests, DNS delegation, SES identities and production-access request. Clocks-and-paperwork; costs ~£0. |
| **B — staging only** | Sprint D2–D4 | VPC, RDS, ElastiCache, ECS api+workers, S3/KMS, SES wiring, CloudFront + basic WAF, secrets, budgets. **One** environment. `apps/web` stays on protected Vercel previews (G6/G10). |
| **C — Infra Week** | G8 trigger | Production re-apply of the same modules, full WAF rulesets, Managed Prometheus/Grafana, Sentry, self-hosted Unleash, ClamAV service, full nine-stage CI, full D33 per-vendor telemetry. |

The test of having done this right, per G8: **the flip changes config and pipelines, never application code.**

### The G8 trigger has fired

G8's condition is *"legal entity + AWS spend approved"*. Both were decided on 13 August 2026 — **D34** (NEOVOGENT AI SOLUTIONS UK LTD, company 15946429) and **D35** ($8,000 across six months). The runbook, written the same day, still sequenced Slice C as post-sprint.

**Decision: Slice C is authored now and applied selectively.** Writing the Terraform costs nothing and removes the risk that prod is a copy-paste of staging written under time pressure. *Applying* it is a separate, reversible decision per component, because Appendix B's burn profile puts staging at ~$150/month through W8 with the squeeze in the pilot months — and standing up production, three CloudFront distributions and Managed Grafana today would spend a meaningful fraction of the envelope on infrastructure with no application behind it and no users.

The distinction to hold onto: **code completeness and spend are separate decisions.** Plan-verified Terraform that has not been applied is finished work, not deferred work.

## Consequences

1. **`envs/account/` had to be written before the D36 story was true.** CloudTrail, both GuardDuty detectors, both AWS Budgets, the CloudTrail log bucket and the Route 53 hosted zone were all live in AWS and managed by nothing — created by console and CLI on 13 Aug. Those are precisely the audit controls this decision leans on, and they were the ones that would have needed rebuilding by hand at migration. Adopted via `import` blocks against a separate state key.
2. **State is split by lifetime, not by convenience.** `staging/core.tfstate` and `account/core.tfstate` are different keys in the same bucket, because account-scoped resources outlive any single environment and must not be destroyed by an environment teardown. See ADR 0006.
3. **Region guardrail exceptions must stay narrow.** CloudFront, WAF and the us-east-1 ACM certificate are global-service exemptions already present in `policies/region-guardrail.json`; eu-west-1 is permitted only for GuardDuty (a detective control) and the DR backup target (ADR 0007). Any broader carve-out reopens what D30 closed.
4. **Cost attribution is per-tag, not per-account**, for as long as the account is shared. `Project=neoting` is load-bearing for every spend figure quoted — an untagged resource is an invisible one. Note that cost-allocation tags could not even be verified from this account: `ce list-cost-allocation-tags` returns `AccessDenied` because a linked account cannot read them. That check lives with the payer.
5. **When dedicated accounts arrive**, the migration is: new account IDs in `local.account_id`, re-run `envs/account/` per account, re-apply environments, move DNS. The `role/nt-*` contract and the explicit-Deny policies carry over unchanged. What does *not* carry over automatically is anything created by hand — which is the whole argument for consequence 1.

## Follow-ups

- [ ] Chase Cloudvisor on dedicated `neoting-*` accounts, and on which legal entity holds the AWS customer agreement and DPA (SoT §22 open item 4).
- [ ] When the org becomes `ALL_FEATURES`, replace `nt-region-guardrail` with a real SCP and downgrade the IAM policy to defence-in-depth.
- [ ] Enable IAM Access Analyzer — verified absent (`list-analyzers` returns `[]`). In a shared account with seven users it is the cheapest way to find unintended cross-principal access.
- [ ] Decide on AWS Security Hub — also absent. Probably Infra Week rather than now, but it should be a decision rather than an omission.
