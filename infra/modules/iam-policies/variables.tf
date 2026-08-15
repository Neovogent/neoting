variable "env" {
  type        = string
  description = "Environment slug. Appears in the KMS key-policy Id, which is metadata only - the deny shape itself is identical in every environment, on purpose."
}

variable "account_id" {
  type        = string
  description = "The account every ARN in these documents is scoped to. D36: shared today, which is the entire reason these deny guards exist."
}

variable "tfstate_bucket" {
  type        = string
  description = "Terraform state bucket the CI deploy role is granted on. Named rather than derived, because the bucket name still says 'staging' while holding three environments' state and a derived name would quietly be wrong."
}

variable "state_key_prefix" {
  type        = string
  default     = ""
  description = <<-EOT
    Prefix the CI deploy role's state-object grant is scoped to. "" grants the
    WHOLE bucket; "prod/" grants only production's state.

    ⚠ "" IS NOT A SAFE DEFAULT, IT IS THE CURRENT STAGING BEHAVIOUR. It is the
    default only so that extracting this module is provably a no-op against an
    environment that is already applied. envs/staging passes "" today, which
    means nt-staging-ci-deploy can read and overwrite prod/core.tfstate and
    account/core.tfstate.

    That is latent rather than harmless: prod's state will hold random_password
    values in plaintext the moment envs/prod is applied, so a compromised
    staging CI job would be a path to production credentials. Scoping staging
    to "staging/" is a one-word change here and is tracked in infra/README.md.
  EOT
}

variable "region_guardrail_policy_id" {
  type        = string
  default     = ""
  description = "Optional `Id` on the region guardrail document. \"\" omits the field entirely, which is what the applied staging policy looks like - adding one would be a real diff on a live policy for no benefit."
}

variable "dr_region" {
  type        = string
  default     = ""
  description = <<-EOT
    ADR 0007's DR region, or "" for an environment that has none.

    Setting it does THREE things at once and they are meant to be inseparable:
    it adds the region to the permitted set, it denies every service there
    except S3, KMS and STS ("nothing processes there" - the sentence ADR 0007
    makes its whole argument on), and it confines S3 to dr_buckets. Adding the
    region without the other two is exactly the "blanket region allow" the ADR
    forbids, which is why one variable drives all three.
  EOT
}

variable "dr_buckets" {
  type        = list(string)
  default     = []
  description = <<-EOT
    Bucket names S3 may touch in dr_region. Everything else in S3 there is
    denied, so a stray CreateBucket cannot quietly become a second copy of
    customer data outside the one the DPIA declares.

    A LIST rather than a single name, deliberately. envs/prod/policies/README.md
    warns that when the nightly logical-Postgres-backup bucket lands (Governance
    §17 wants dumps in the DR region as well as replicated objects) its ARN must
    be added here "or the backup job is denied and the failure looks like an S3
    outage". As a list that is a call-site edit; as a hardcoded pair of ARNs it
    was a policy-file edit somebody would forget.
  EOT
}
