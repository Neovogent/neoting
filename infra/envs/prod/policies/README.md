# `envs/prod/policies/` — what is left here, and why

One file. Everything else moved to `infra/modules/iam-policies` on 15 Aug 2026.

## What moved, and what replaced the difference

Three of the four documents that used to live here had near-identical twins in
`envs/staging/policies/`, with nothing keeping the shared halves in step. They
are now rendered once, from `modules/iam-policies`, and what made prod different
is expressed as **input** rather than as a second file:

| Was | Now |
|---|---|
| `kms-secrets.json.tftpl` — a copy of staging's with the `Id` templated | `env` input. The deny shape was always identical and now cannot drift. |
| `ci-deploy-inline.json.tftpl` — a copy with the state grant scoped to `prod/*` | `state_key_prefix` input. Prod passes `"prod/core.tfstate"`, staging passes `""`. |
| `region-guardrail.json.tftpl` — a copy plus two ADR 0007 statements | `dr_region` + `dr_buckets` inputs. |

**The guardrail is the one worth understanding.** ADR 0007 consequence 2 forbids
a blanket region allow — *"A broad `eu-west-1: *` would silently reopen
everything D30 closed."* So `dr_region` does not merely permit the region. Setting
it does three inseparable things:

1. adds the region to `DenyOutsideApprovedRegions`'s permitted set;
2. adds `NothingProcessesInTheDrRegion` — in eu-west-1 **only S3, KMS and STS are
   permitted at all.** No RDS, no ECS, no EC2, no Bedrock, no Textract, no
   Transcribe, no SES, no Secrets Manager. This is the IAM expression of the
   sentence ADR 0007 makes its whole argument on: *"Nothing processes there."*
   `sts:*` is exempt because a regional STS endpoint is how a caller gets
   credentials in the first place; it moves no data;
3. adds `DrRegionS3IsTheBackupBucketsOnly` — in eu-west-1, S3 may touch only the
   buckets named in `dr_buckets`, so a stray `CreateBucket` cannot quietly become
   a second copy of customer data outside the one the DPIA declares.

One variable drives all three precisely so that nobody can do the first without
the other two.

⚠ **`dr_buckets` is a list, and that is load-bearing.** When the nightly
logical-Postgres-backup bucket lands (Governance §17 wants dumps in the DR region
as well as replicated objects), **add it there in the same change** — or the
backup job is denied and the failure looks like an S3 outage rather than a policy
error. As a list that is a one-line call-site edit. As the hardcoded pair of ARNs
it used to be, it was a policy-file edit somebody would forget.

The module carries a precondition for the adjacent mistake: `dr_region` set with
an empty `dr_buckets` fails at plan, because that combination permits the region
and then denies S3 everywhere in it — denying the very backup the region was
permitted for.

### Verification, not assertion

The extraction was proved the same way `envs/staging/moved.tf` was: **`terraform
plan` in `envs/staging` reports no changes**, against an environment that is
already applied. `envs/prod` still plans `158 to add, 0 to change, 0 to destroy`.
Each rendered document was also diffed as normalised JSON against the file it
replaced — all identical, with one intentional exception: prod's state-grant
`Sid` is now `TerraformStateObjectsAndLockfile` rather than
`...ForProdOnly`. The **resource scope is unchanged**; a `Sid` is a label.

## What is still here

### `kms-dr.json.tftpl`

Prod-only, because staging has no DR region — so there is nothing to share and
nothing to drift against. Same explicit-Deny shape as the secrets key, applied to
the replication CMK in eu-west-1, plus the one grant that key actually needs: S3
replication decrypting in London and encrypting in Dublin under the caller's
(`nt-prod-s3-replication`) credentials.

It moves into `modules/iam-policies` the day a second environment needs a DR
region, and not before — a shared module with exactly one caller freezes an
interface nobody has tested against a second one.

## Known gap, carried over

**KMS is region-scoped but not resource-scoped in the guardrail.** There is
exactly one key in eu-west-1 (`replication.tf`), so the practical blast radius is
that key — but the policy would permit a second one. Resource-scoping it means
the key ARN, which does not exist until Terraform creates it, so it would have to
become a two-pass apply or a hardcoded ARN. Recorded, not done.
