# ADR 0006 — Terraform state layout and OIDC role scoping

**Status:** Accepted · **Date:** 13 August 2026 · **Decider:** Shakib (eng)
**Implements:** Kickoff 3.2 and 4.10, runbook Step 2 · **Related:** ADR 0005

---

## Context

Two questions with one answer between them: **where Terraform state lives and how it is split**, and **how CI gets AWS credentials without any static keys existing anywhere**.

Both had to be settled before the first `apply`, because state layout is painful to change afterwards and a static access key, once created, tends to outlive every intention to remove it.

## Decision 1 — State in S3, split by lifetime

```
s3://nt-tfstate-staging-252959251643
  staging/core.tfstate     one environment
  account/core.tfstate     account-scoped, outlives every environment
  prod/core.tfstate        when prod is applied
```

**Split by lifetime, not by team or by service.** CloudTrail, GuardDuty and the AWS Budgets belong to the *account*; a `terraform destroy` on staging must not be able to take the audit trail with it. Environments are things we expect to create and tear down; the account layer is not.

Deliberately **not** one state per service. At this size, a state file per module buys cross-state data lookups and a dependency graph maintained by hand, in exchange for a blast-radius reduction we do not yet need. Revisit if a plan starts taking minutes rather than seconds.

### S3-native locking, no DynamoDB

`use_lockfile = true` (Terraform ≥ 1.11). The `dynamodb_table` backend argument is deprecated, so the lock table is one less resource to own, tag, budget and forget.

A table `nt-tflock` was created during bootstrap before this was settled. It is now gone — `dynamodb list-tables` returns `[]` in eu-west-2 — so `infra/README.md`'s instruction to delete it describes work already done and should be corrected rather than followed.

### The state bucket is deliberately unmanaged

Chicken-and-egg: a backend cannot manage the bucket it stores its own state in, and a `terraform destroy` that eats the state bucket is a bad afternoon. It was created by CLI, is documented in `infra/README.md`, and is left alone. Verified config: versioning Enabled, SSE-S3 with bucket keys, all four public-access-block flags true.

Its one weakness, recorded honestly: it has **no bucket policy**, so it does not carry the explicit `Deny` for principals outside `role/nt-*` that every other Neoting bucket has. In a shared account with seven IAM users, Terraform state is a high-value target — it contains resource configuration and, for some resource types, secret material. Adding a policy to the state bucket is possible without adopting it into state, and should happen.

## Decision 2 — GitHub OIDC, and two roles rather than one

**No static AWS access keys exist for CI, and none may be created.** GitHub Actions federates via OIDC and assumes a role.

| Role | Trusted for | May do |
|---|---|---|
| `nt-staging-ci-plan` | **any** ref in `neovogent/neoting` | ReadOnlyAccess + the region guardrail. Enough to `terraform plan`. |
| `nt-staging-ci-deploy` | **only** `refs/heads/main` | PowerUser + scoped IAM + state bucket read/write, under the region guardrail. |

The split is the point. A pull request from a fork or a branch can render a plan — which is what makes review meaningful — while the ability to *change* anything is pinned to the trunk by the trust policy itself, not by a workflow `if:` condition that a workflow edit could remove. The dangerous capability is bound to the branch at the IAM layer, where a PR cannot reach it.

Both roles carry `nt-region-guardrail`, so even the deploy role cannot create resources outside eu-west-2 and the permitted global services (ADR 0005).

## Consequences

1. **Both roles existed for a day with nothing assuming them.** The OIDC provider, both roles and their trust policies were applied on 13 Aug, and the only workflow in the repo was the bootstrap thin CI, which touches no AWS. The Terraform plan/apply workflows land with this ADR. An unused role is not harmful, but it is unverified — the first real assumption is the test of whether the trust policy conditions are right.
2. **The trust conditions were re-read, and one carried a latent break.** Both policies correctly pin the repository as well as the audience — a policy checking only `aud` would trust every GitHub repository in the world, and neither did that. But `local.github_repo` is `neovogent/neoting` (lowercase) while the actual remote is `github.com/Neovogent/neoting`, and **IAM string conditions are case-sensitive**. `StringEquals` on the `sub` claim would therefore have denied every deploy. Because no workflow had ever assumed the role, the first symptom would have been an unexplained `AssumeRoleWithWebIdentity` failure on the first real deploy — at exactly the moment when nobody is looking for a casing bug.

   Fixed by matching case-insensitively: `StringEqualsIgnoreCase` on `sub` for the deploy role, and on the `repository` claim for the plan role (`StringLike` has no case-insensitive variant, so wildcarding `sub` would have kept the trap). This gives up nothing — GitHub does not permit two organisations whose names differ only by case, so it cannot widen who is trusted.
3. **`account/core.tfstate` needs its own CI wiring.** The existing `ci-deploy` inline policy grants state-bucket access broadly enough to cover it, but the workflow must run a separate init/plan/apply per directory. A single `terraform apply` at `infra/` does not exist and should not be invented.
4. **State is not encrypted with a CMK.** The bucket is SSE-S3. For a file that can contain secret material, a customer-managed key with the `role/nt-*` deny would be better, and is cheap. Not done; recorded.
5. **Locking depends on a Terraform floor higher than the one declared.** `required_version = ">= 1.7"` but `use_lockfile` needs ≥ 1.11. Anyone running 1.7–1.10 gets a confusing failure rather than a clear version error. The constraint should be raised to match reality.

## Follow-ups

- [ ] Raise `required_version` to `>= 1.11` to match what `use_lockfile` actually needs (consequence 5).
- [ ] Add a bucket policy to the state bucket with the `role/nt-*` explicit Deny, and consider a CMK (Decision 1 note, consequence 4).
- [ ] Confirm on the first real CI run that both roles assume cleanly (consequence 2). The casing fix is reasoned, not yet observed — and OIDC trust is the kind of thing that is either fine or completely broken, with nothing in between.
- [ ] Correct `infra/README.md`: the `nt-tflock` deletion instruction describes work already done, and the documented `modules/` layout did not exist when it was written.
