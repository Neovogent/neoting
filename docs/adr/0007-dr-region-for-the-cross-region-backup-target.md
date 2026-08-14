# ADR 0007 — DR region for the cross-region backup target

**Status:** **Accepted** — ratified by Shakib, 14 August 2026
**Date:** 13 August 2026 · **Ratified:** 14 August 2026 · **Decider:** Shakib · **Implements:** Governance §17 · **Constrained by:** D30, D36

> **Ratification note (14 Aug 2026).** Accepted as written; nothing in the decision changed on review. It sat at Proposed for a day while it blocked work it should not have: Governance §17 backups cannot be configured before the DR region is settled, because a backup written to the wrong region is a residency incident that has already happened by the time anyone reads the ADR.
>
> Three of the four consequences were verified as already built in `infra/envs/prod/` before ratifying, rather than taken on trust — see the follow-ups below. The fourth, the restore drill, is the one that matters most and is the one still open: §17 is explicit that an untested backup is a hope, so this ADR is not *finished* until an RTO number is measured and written into it.
>
> D30's wording was re-read against the named region and still reads correctly: the exception is a *location*, and this ADR narrows it to backup and replication targets with nothing processing there.

---

## Context

Governance §17 requires nightly logical Postgres backups **to a second EU region** and cross-region S3 replication, at RPO ≤ 15 min and RTO ≤ 4 h, proven by a quarterly restore drill.

D30 makes all storage and processing UK-only, with non-UK locations permitted solely as *named* fallbacks where no UK option exists. As of the v1.4 amendment there is exactly **one** such exception left — this one — because verification 8.2 retired the SES inbound fallback unused. The reason it survives is arithmetic, not preference: **the UK has a single AWS region.** A second region for disaster recovery cannot be in the UK, so it must be in the EU.

D30 names the exception but does not choose the region. That choice is this ADR, and it has to be made before any backup is configured, because a backup written to the wrong region is a residency incident that already happened.

## Options

| Region | Distance / transfer | Notes |
|---|---|---|
| **eu-west-1 Ireland** | Closest to London; lowest inter-region latency and egress cost | The conventional DR pair for eu-west-2. Already visible to us: GuardDuty is enabled there, and the shared account's other Neovogent products run there. |
| **eu-central-1 Frankfurt** | Further; higher transfer cost | Largest EU region, broadest service coverage, strong data-protection reputation with German-speaking customers — irrelevant to a UK-only pilot. |
| **eu-west-3 Paris** | Comparable to Frankfurt | No advantage over either neighbour for our workload. |
| **eu-north-1 Stockholm** | Furthest | Cheapest compute, lowest-carbon grid. Neither matters for cold backup storage. |

## Decision

**eu-west-1 (Ireland), for backup and replication targets only.**

Nothing *processes* there. No compute, no Bedrock, no Textract, no SES. The region holds encrypted Postgres logical backups and replicated S3 objects, and is the target of the quarterly restore drill. That distinction is the whole reason this stays a narrow exception rather than a hole in D30: the promise to accountants is that their clients' documents are processed in London, and a cold encrypted copy in Dublin does not change where the work happens.

### Why Ireland

1. **Lowest RPO risk.** RPO ≤ 15 min is the binding number. Shortest hop from London means replication lag is least likely to be what breaks it.
2. **Cheapest.** Inter-region transfer is a per-GB charge on every document we ever store, forever, and it compounds against an $8,000 six-month envelope (D35). London→Dublin is the cheapest EU pair available from eu-west-2.
3. **Adequacy is settled in the direction that matters.** The transfer is UK → EEA. The UK's own adequacy regulations cover the EEA, so no additional transfer safeguard is required beyond the AWS DPA. (The EU's separate adequacy decision for the UK governs the reverse direction and is not what this depends on — worth knowing, because the two get conflated in questionnaires.)
4. **It is the drilled path.** eu-west-1 is the default DR pair for eu-west-2 in AWS's own guidance and in every runbook engineers have seen. In a real RTO ≤ 4 h incident, the least surprising region is a feature.

### The counter-argument, recorded

**eu-west-1 already hosts unrelated Neovogent workloads in the same shared account** (D36) — Cedofinance, visa-processing, needz. So choosing Ireland gives **no blast-radius separation at the account level**: a credential compromise reaches primary and DR alike, and so does an account-level misconfiguration.

That is true, and it is not what this decision is for. DR protects against *region* failure; account compromise is D36's problem, answered by the explicit-Deny key and bucket policies, CloudTrail and GuardDuty. Picking Frankfurt would not fix it either — the account boundary is the same in every region. What actually fixes it is the dedicated `neoting-*` accounts requested from Cloudvisor.

**Consequence to carry:** until those accounts land, the DPIA must not claim geographic separation implies administrative separation. It does not.

## Consequences

1. **`dr_region = "eu-west-1"` becomes a variable**, not a literal, so the choice is re-decidable and greppable.
2. **The region-guardrail IAM policy must permit exactly this**, and nothing more. The policy currently pins Neoting principals to eu-west-2 plus global services. It needs a narrow carve-out for the backup and replication paths in eu-west-1 — scoped to those specific actions and resources, not a blanket region allow. A broad `eu-west-1: *` would silently reopen everything D30 closed.
3. **S3 cross-region replication needs a destination CMK in eu-west-1.** KMS keys are regional; the eu-west-2 CMK cannot encrypt objects in Dublin. That is a second key, with the same explicit-Deny policy shape as the primary (ADR 0008), and it must be created in the same Terraform run so it is never a console artefact.
4. **The quarterly restore drill is the acceptance test, not the backup job.** Governance §17 is explicit that an untested backup is a hope. First drill should be scheduled the moment staging holds seed data, so the RTO number is measured rather than asserted before pilot.
5. **This is now the *only* non-UK location in the product.** If a future change adds a second, it is a versioned amendment to D30, not a config change — and this ADR should be the thing it is diffed against.

## Follow-ups

- [x] **Ratified** 14 Aug 2026; D30's wording confirmed to still read correctly with the region named.
- [x] `dr_region = "eu-west-1"` is a variable, not a literal — `infra/envs/prod/main.tf` (consequence 1).
- [x] The narrow carve-out is in `infra/envs/prod/policies/region-guardrail.json.tftpl` (consequence 2), and it is narrow in the way this ADR demanded rather than in name only: `NothingProcessesInTheDrRegion` denies the compute and AI services outright in `${dr_region}`, and `DrRegionS3IsTheBackupBucketsOnly` confines S3 there to the replication targets. **Staging's guardrail deliberately has no carve-out** — staging replicates nothing, and an unused permission is a permission.
- [x] The eu-west-1 replication CMK exists in Terraform with the ADR 0008 explicit-Deny shape — `infra/envs/prod/replication.tf`, `policies/kms-dr.json.tftpl` (consequence 3).
- [ ] **Still open, and it is the important one:** schedule the first restore drill and record the measured RTO here (consequence 4). Blocked on staging holding seed data. Until a number replaces this line, RTO ≤ 4 h is an assertion, not a measurement — Governance §17's own standard.
- [ ] Note that none of the prod Terraform above has been **applied** (ADR 0005: Slice C is authored, applied selectively). The controls are code-complete and untested against a real bucket.
