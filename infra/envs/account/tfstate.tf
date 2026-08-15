# --------------------------------------------------------------------------
# The Terraform state bucket's deny guard.
#
# README.md carried this as a "Known gap": `nt-tfstate-staging-252959251643`
# is versioned, encrypted and public-access-blocked, but it had NO bucket
# policy — so it was the one Neoting bucket without the explicit `Deny` for
# principals outside `role/nt-*` that every other bucket carries.
#
# WHY THAT GAP WAS THE WRONG ONE TO LEAVE OPEN LAST:
#
# State is not a build artefact, it is a transcript. It holds the resolved
# configuration of every resource, and for several resource types it holds
# secret material outright — `random_password` values land in state in
# plaintext regardless of how carefully the resource that consumes them
# handles them. `envs/prod/` generates exactly such passwords, and its state
# file lands in this bucket. In an account where six principals we did not
# create hold admin (D36), an unprotected state bucket is a shorter path to
# production's database than production's database is.
#
# WHY IT IS HERE AND NOT IN envs/staging: the bucket holds staging's state,
# prod's state and this root's own state. It outlives every environment, which
# is the same test CloudTrail, the budgets and the hosted zone pass. Guarding
# it from inside the state of one of its own tenants would be circular.
# --------------------------------------------------------------------------

locals {
  # Bootstrap infrastructure: created by CLI on 13 Aug 2026, deliberately NOT
  # adopted into state (infra/README.md). The backend cannot manage itself,
  # and a `terraform destroy` that eats the state bucket is a bad afternoon.
  #
  # ⚠ A BUCKET POLICY DOES NOT REQUIRE OWNING THE BUCKET. This resource
  # attaches a policy to a bucket Terraform does not manage, by name. That is
  # the whole reason this gap was closeable without unpicking the bootstrap
  # decision — README.md said so and it is correct.
  tfstate_bucket = "nt-tfstate-staging-252959251643"

  # Referenced across the directory boundary rather than copied. Two copies of
  # a deny guard is exactly the drift that silently opens a bucket while both
  # files still look correct in review — the same argument main.tf makes for
  # `local.shared_bucket_policy_template`, and the same file clamav.tf renders
  # for the quarantine and AV-definitions buckets.
  shared_bucket_policy_template = "${path.module}/../../modules/storage/policies/bucket.json.tftpl"
}

# --------------------------------------------------------------------------
# ⚠ READ THIS BEFORE EDITING THE POLICY OR THE TEMPLATE IT RENDERS.
#
# THE CIRCULARITY: this root's own state lives in the bucket this policy
# guards. Terraform writes state AFTER the apply completes. So a policy that
# denies the applying principal would take effect first and the state write
# would fail second — leaving a change applied in AWS with no record of it in
# state, which is the worst of both outcomes.
#
# TWO THINGS MAKE THAT SAFE, AND BOTH MUST STAY TRUE:
#
#   1. Every principal that runs Terraform is on the template's allow list.
#      `user/Mubashir` is the only human IAM credential in this account with
#      Neoting access (there is no `shakib` user — verified 15 Aug 2026), and
#      the CI roles are `nt-staging-ci-plan`, `nt-staging-ci-deploy` and
#      `nt-prod-ci-deploy`, all matching `role/nt-*`. Adding a Terraform
#      runner that matches neither is what breaks this, and it will look like
#      a permissions bug while actually being a naming bug.
#
#   2. The template's deny covers OBJECT actions only — GetObject, PutObject,
#      DeleteObject, ListBucket and their versioned forms. It does not deny
#      `s3:PutBucketPolicy` or `s3:DeleteBucketPolicy`. That asymmetry is
#      deliberate and it is the escape hatch: even a policy that locks every
#      principal out of the DATA can still be replaced by an account admin,
#      so the failure mode here is a bad hour, not a bricked bucket. Do not
#      "tighten" the template by adding bucket-configuration actions to that
#      list without first working out how you would recover.
#
# The other statement the template carries, DenyInsecureTransport, is
# unconditional and applies to us too. Terraform's S3 backend speaks TLS, so
# it is a no-op for every legitimate caller — which is what a good guard
# looks like.
# --------------------------------------------------------------------------
resource "aws_s3_bucket_policy" "tfstate" {
  bucket = local.tfstate_bucket

  policy = templatefile(local.shared_bucket_policy_template, {
    bucket     = local.tfstate_bucket
    account_id = local.account_id
  })
}

# --------------------------------------------------------------------------
# ⚠ WHAT THIS DOES NOT FIX, STATED SO IT IS NOT MISTAKEN FOR SOLVED:
#
# The bucket's name still says "staging" while it holds prod and account state
# too. Renaming an S3 bucket means creating a new one and repointing every
# `backend "s3"` block in the repo, with a state migration per root — a real
# change with a real outage window, not a rename. It stays as it is, and the
# state-layout table in infra/README.md already says why.
#
# Server-side encryption on this bucket is SSE-S3 (AES256), not the Neoting
# CMK. The deny above is therefore the ONLY thing standing between another
# principal in this account and the contents of state — there is no second
# lock behind it the way there is on the documents bucket, where the KMS key
# policy denies separately from the bucket policy. Moving state under the CMK
# is a follow-up worth having; it is not free, because the bootstrap
# chicken-and-egg means the key must survive independently of the state that
# would otherwise describe it.
# --------------------------------------------------------------------------

output "tfstate_bucket" {
  value       = local.tfstate_bucket
  description = "Guarded by the shared role/nt-* deny as of 15 Aug 2026. Not managed by Terraform — bootstrap, see infra/README.md."
}
