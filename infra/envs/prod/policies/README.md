# `envs/prod/policies/` — why these files are not shared with staging

Four JSON policy documents live here. Two of them are **deliberately different**
from their staging counterparts, and two are **duplicates that should not stay
duplicated**. Knowing which is which is the point of this file.

## Deliberately different

### `region-guardrail.json.tftpl`

staging attaches the account-wide `nt-region-guardrail` managed policy: eu-west-2,
plus the documented global-service exemption in us-east-1 (CloudFront, WAF,
Route 53, IAM, Budgets — none of which can be created in London and none of which
touches customer data), and a hard `Deny` on every data service in us-east-1.

Prod cannot use that policy, because Governance §17 requires cross-region backups
and ADR 0007 puts them in **eu-west-1**. A policy that denies eu-west-1 denies the
backup. So this file adds the carve-out ADR 0007 consequence 2 asks for — and
nothing beyond it:

| Statement | What it does |
|---|---|
| `DenyOutsideApprovedRegions` | Unchanged in shape. `eu-west-1` joins the permitted set, which on its own would be exactly the "blanket region allow" the ADR forbids — statements 3 and 4 are what stop it being that. |
| `NoDataServicesInUsEast1` | Unchanged. |
| `NothingProcessesInTheDrRegion` | In eu-west-1 **only S3, KMS and STS are permitted at all.** No RDS, no ECS, no EC2, no Bedrock, no Textract, no Transcribe, no SES, no Secrets Manager. This is the IAM expression of the sentence ADR 0007 makes its whole argument on: *"Nothing processes there."* `sts:*` is exempt because a regional STS endpoint is how a caller gets credentials in the first place; it moves no data. |
| `DrRegionS3IsTheBackupBucketsOnly` | In eu-west-1, S3 may touch **only the named DR bucket**. Anything else in S3 in Dublin is denied, so a stray `CreateBucket` cannot quietly become a second copy of customer data outside the one the DPIA declares. |

**KMS is region-scoped but not resource-scoped here, and that is a known gap.**
There is exactly one key in eu-west-1 (`replication.tf`), so the practical blast
radius is that key — but the policy would permit a second one. Resource-scoping it
means the key ARN, which does not exist until Terraform creates it, so it would
have to become a two-pass apply or a hardcoded ARN. Recorded, not done.

**When the nightly logical-Postgres-backup bucket lands** (Governance §17 wants
dumps in the DR region as well as replicated objects), its ARN must be added to
`DrRegionS3IsTheBackupBucketsOnly` in the same change, or the backup job is denied
and the failure looks like an S3 outage.

### `ci-deploy-inline.json.tftpl`

Same shape as staging's, with one hardening: the state-object grant is scoped to
`prod/*` rather than the whole bucket. The prod deploy role can read and write
production state and **cannot read or overwrite** `staging/core.tfstate` or
`account/core.tfstate`. In a shared account that is the difference between a
misconfigured `-backend-config` corrupting one environment and corrupting three.

## Duplicated, and it should not stay that way

### `kms-secrets.json.tftpl`

A copy of `envs/staging/policies/kms-secrets.json.tftpl` with the policy `Id`
templated on the environment instead of hardcoded to `nt-staging-...`. The
*content* is the same explicit-Deny shape and it must stay the same shape in both
places: root administers, `role/nt-*` (plus the one named human) may use, everyone
else is explicitly denied.

### `kms-dr.json.tftpl`

New — there is no staging equivalent, because staging has no DR region. Same
explicit-Deny shape as the secrets key, applied to the replication CMK in
eu-west-1, plus the one grant that key actually needs: S3 replication decrypting
in London and encrypting in Dublin under the caller's (`nt-prod-s3-replication`)
credentials.

## The fix, recorded

Three environments' worth of these files is where the drift starts hurting. The
right shape is a shared `infra/modules/iam-policies` rendered per environment with
`env`, `account_id` and `dr_region` as inputs — the same argument the storage
module already makes for the bucket deny guard:

> *two copies of a `role/nt-*` deny guard is precisely the drift that silently
> opens a bucket, and it would be invisible in review because both files would
> look correct on their own.*

Not done here because moving staging's copies is a change to an environment that
is already applied and in state, and it belongs in its own PR with its own plan.
