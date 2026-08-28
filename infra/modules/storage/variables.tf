variable "env" {
  type        = string
  description = "Environment slug. Drives bucket names, the KMS alias and the key policy Id."

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.env))
    error_message = "env must be lowercase alphanumeric with hyphens - it lands in S3 bucket names, which forbid anything else."
  }
}

variable "account_id" {
  type        = string
  description = <<-EOT
    AWS account ID. Suffixes every bucket name (S3 names are global, the account
    is shared with three unrelated products - D36) and is interpolated into the
    bucket and key policies as the arn:aws:iam::<account>:role/nt-* guard.
  EOT
}

variable "region" {
  type        = string
  description = "Region, for the key description only. eu-west-2 (D30 UK residency)."
}

# --------------------------------------------------------------------------
# THE BUCKET MAP.
#
# Prod adds a bucket by adding a map entry, not by editing this module. Names
# are derived - nt-<env>-<key>-<account_id> - so a key of "logs" is the whole
# input needed for a new bucket that inherits versioning, the public-access
# block, the encryption default and the deny-outside-Neoting policy.
#
# A bucket needing a policy this module does not ship (an extra service
# principal, say) names a template file that lives beside the defaults in
# policies/. That is the one additive edit to the module that a new bucket can
# require.
# --------------------------------------------------------------------------
variable "buckets" {
  description = "Buckets to create, keyed by short name. data_class drives retention jobs (Governance 12.2) and cost attribution (13.5)."

  type = map(object({
    data_class      = string
    sse             = optional(string, "aws:kms")
    policy_template = optional(string, "bucket.json.tftpl")

    # Browser origins allowed to PUT and GET this bucket's presigned URLs.
    #
    # ⚠ EMPTY IS NOT "ALLOW ANY", IT IS "NO BROWSER MAY REACH THIS BUCKET", and
    # that is the right default: only the bucket a browser genuinely uploads to
    # should say so, by name.
    cors_origins = optional(list(string), [])
  }))

  validation {
    condition     = alltrue([for b in var.buckets : contains(["aws:kms", "AES256"], b.sse)])
    error_message = "sse must be aws:kms or AES256."
  }
}

variable "kms_alias_suffix" {
  type        = string
  default     = "docs"
  description = "Alias is alias/nt-<env>-<suffix>."
}

variable "kms_deletion_window_in_days" {
  type        = number
  default     = 30
  description = "The maximum. Deleting this key destroys every document in the buckets with no restore path - the ciphertext without the key is just bytes - so the window is the only undo that exists."

  validation {
    condition     = var.kms_deletion_window_in_days >= 7 && var.kms_deletion_window_in_days <= 30
    error_message = "KMS deletion window must be between 7 and 30 days."
  }
}

variable "kms_enable_key_rotation" {
  type        = bool
  default     = true
  description = "Annual automatic rotation. Old material is retained, so previously encrypted objects stay readable."
}

variable "kms_key_description" {
  type        = string
  default     = null
  description = "Overrides the derived description. Leave null unless you have a reason."
}
