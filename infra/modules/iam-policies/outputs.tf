# --------------------------------------------------------------------------
# This module renders policy DOCUMENTS and creates nothing. That is deliberate:
# the resources these attach to are an IAM managed policy in one environment, an
# inline role policy in another and a KMS key policy in a third, and a module
# that tried to own all three would need to know about roles and keys it has no
# business knowing about. It renders text; the call site decides what the text
# is attached to.
#
# Consequence worth knowing: because there are no resources, there is nothing to
# hang a lifecycle precondition on except the outputs themselves. That is what
# the precondition on region_guardrail_policy below is doing.
# --------------------------------------------------------------------------

output "kms_secrets_policy" {
  value       = templatefile("${path.module}/policies/kms-secrets.json.tftpl", { env = var.env, account_id = var.account_id })
  description = "Key policy for the per-environment Secrets Manager CMK. Root administers, role/nt-* (plus the one named human) may use, everyone else is explicitly denied."
}

output "ci_deploy_inline_policy" {
  value = templatefile("${path.module}/policies/ci-deploy-inline.json.tftpl", {
    account_id       = var.account_id
    tfstate_bucket   = var.tfstate_bucket
    state_key_prefix = var.state_key_prefix
  })
  description = "Inline policy for the CI deploy role: its own Terraform state, IAM scoped to nt-* names only, and read on the shared OIDC provider."
}

output "region_guardrail_policy" {
  value = templatefile("${path.module}/policies/region-guardrail.json.tftpl", {
    policy_id  = var.region_guardrail_policy_id
    dr_region  = var.dr_region
    dr_buckets = var.dr_buckets
  })

  description = "D30 UK-first residency guardrail. SCP substitute - the org is CONSOLIDATED_BILLING so SCPs are unavailable, and this is attached to every Neoting principal instead."

  precondition {
    condition     = var.dr_region == "" || length(var.dr_buckets) > 0
    error_message = "dr_region is set but dr_buckets is empty. That combination permits the DR region and then denies S3 everywhere in it, so the backup this region exists for would be denied - and the failure would look like an S3 outage rather than a policy error. Name the bucket(s), or leave dr_region empty."
  }
}
