# --------------------------------------------------------------------------
# The public hosted zone — adopted 15 Aug 2026 (README.md gap: "Route 53
# hosted zone Z08402112LR2AWM4XBVST is created outside Terraform").
#
# WHY IT BELONGS IN envs/account AND NOT IN envs/staging:
#
# The zone is the apex `neoting.neovogent.com`, and D5 (15 Aug 2026) settles
# the split inside it — production takes the apex, staging takes the
# `staging.` label. One zone, two environments. Putting it in either
# environment's state would mean the OTHER environment's DNS depends on a
# `terraform destroy` that staging is explicitly allowed to run (G1). The
# zone outlives both, which is the same test CloudTrail and the budgets pass.
#
# ⚠ WHAT THIS CHANGES FOR envs/staging: nothing, and that is on purpose.
# `envs/staging/edge.tf`, `alb.tf` and `email.tf` read the zone through
# `data "aws_route53_zone" "primary"`. A data source resolves against live
# AWS, not against whoever's state file holds the resource, so adoption here
# is invisible to staging. No cross-state remote-state dependency is created,
# and none should be — that coupling is how one environment's lock becomes
# another environment's outage.
#
# The gap this closes: before adoption, a staging plan FAILED OUTRIGHT if the
# zone were ever renamed or deleted, and nothing in the repo would have
# stopped that happening — the zone was a console artefact with 13 records
# and no owner. It now has one.
# --------------------------------------------------------------------------

resource "aws_route53_zone" "primary" {
  name    = "neoting.neovogent.com"
  comment = "Neoting pre-launch domain (D5)"

  tags = { Component = "dns" }

  # ⚠ THE RECORDS INSIDE THIS ZONE ARE NOT MANAGED HERE, AND MUST NOT BE.
  #
  # 13 record sets live in this zone today. They are owned by the environment
  # that creates them — the ALB and CloudFront aliases in envs/staging/edge.tf
  # and alb.tf, the SES DKIM and MX records in envs/staging/email.tf. Adopting
  # the records into account state as well would take DNS out of the hands of
  # the environment whose resources those records point at, and every
  # certificate validation or origin swap would become a two-state, two-lock
  # dance.
  #
  # The container is account-scoped; the contents are environment-scoped.
  #
  # A `terraform destroy` here would fail while those records exist, which is
  # the correct obstruction rather than a bug: AWS refuses to delete a
  # non-empty zone, and that refusal is the last thing standing between a
  # mistyped directory and the loss of the domain's entire DNS history.
  lifecycle {
    prevent_destroy = true
  }
}

# Adopted 15 Aug 2026 from ID Z08402112LR2AWM4XBVST — a public zone with 13
# record sets, created by console before this repo existed. The one-shot
# `import` block that performed the adoption has been removed, per the same
# rule that retired imports.tf: leaving it behind tells the next reader the
# zone is still unmanaged.

output "route53_zone_id" { value = aws_route53_zone.primary.zone_id }

output "route53_name_servers" {
  value       = aws_route53_zone.primary.name_servers
  description = "Delegation NS set. Must match what the registrar publishes for neoting.neovogent.com, or nothing in this zone resolves."
}
