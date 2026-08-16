# --------------------------------------------------------------------------
# AWS Budgets — the D33 spend gate (runbook Step 10.1, Appendix B).
#
# D33 / Governance §13.5: "No paid service goes live without a budget line, a
# usage metric, and an alert. That is a gate, not a preference."
#
# REGION NOTE (not a D30 violation): AWS Budgets is a global service with a
# single us-east-1 control-plane endpoint, like IAM. The SDK routes there
# automatically, so these resources use the default eu-west-2 provider and
# create nothing outside London. No customer data is involved — a budget holds
# a dollar figure and an email address.
# --------------------------------------------------------------------------

locals {
  # Runbook Step 10.1: "alerts at 50/80/100% of actual and 100% of forecast".
  #
  # The forecast alarm is the one that actually saves money. Actual-100% tells
  # you the month is already blown; forecast-100% tells you on roughly day 9
  # that it is going to be, while there is still time to turn something off.
  budget_alert_thresholds = [
    { type = "ACTUAL", threshold = 50 },
    { type = "ACTUAL", threshold = 80 },
    { type = "ACTUAL", threshold = 100 },
    { type = "FORECASTED", threshold = 100 },
  ]
}

# --------------------------------------------------------------------------
# Monthly burn rate.
#
# $1,300 is the sum of the per-account monthly envelopes in runbook Step 10.1
# — dev $100 + staging $250 + prod $900 + mgmt $25 = $1,275, rounded up — held
# as ONE figure because the dedicated member accounts do not exist yet (D36).
# When Cloudvisor delivers nt-dev/staging/prod this splits back into four
# budgets and this one is deleted, not re-scoped.
# --------------------------------------------------------------------------
resource "aws_budgets_budget" "monthly" {
  name        = "neoting-monthly-1300"
  budget_type = "COST"
  time_unit   = "MONTHLY"
  limit_unit  = "USD"

  # String, and the trailing ".0" is deliberate: the Budgets API normalises
  # amounts to one decimal place and the provider stores what it reads back.
  # Writing "1300" here produces a permanent no-op diff on every plan, which
  # trains reviewers to ignore plan output — the expensive kind of small bug.
  # This is a currency envelope in USD, not the product's integer-pence money.
  limit_amount = "1300.0"

  time_period_start = "2026-08-01_00:00"

  # AWS's "no end date" sentinel, and the provider's own default. Stated
  # explicitly so a future reader does not read the absence as an oversight.
  time_period_end = "2087-06-15_00:00"

  cost_types {
    # ⚠ THE ONE SETTING THAT MAKES THE OTHERS WORK (runbook Step 10.1):
    # if the $8,000 arrives as AWS credits and credits are included, credits
    # net the tracked cost to ~$0 and every threshold below stays silent until
    # the pot is empty. Runbook calls this "the single most common way a
    # credit-funded project discovers its burn rate". Refunds are excluded for
    # the same reason — a one-off refund would mask a rising baseline.
    #
    # Verified against the live budget 13 Aug 2026: both already false. Do not
    # "tidy" these to match the AWS console defaults, which are both true.
    include_credit = false
    include_refund = false

    # Everything else is the true cost of running the thing, so it counts.
    include_tax                = true
    include_subscription       = true
    include_upfront            = true
    include_recurring          = true
    include_other_subscription = true
    include_support            = true
    include_discount           = true

    # Unblended and unamortised: we want the cash figure for the month we are
    # in, not a smoothed one. There are no reservations or savings plans to
    # amortise at this scale anyway.
    use_blended   = false
    use_amortized = false
  }

  dynamic "notification" {
    for_each = local.budget_alert_thresholds
    content {
      notification_type          = notification.value.type
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = "PERCENTAGE"
      subscriber_email_addresses = [local.budget_alert_email]

      # ⚠ THE SNS TOPIC IS THE POINT, AND THE EMAIL STAYS ALONGSIDE IT.
      #
      # infra/README.md carried "budget notifications go to one personal inbox"
      # as a gap, and it is the right kind of gap to care about: Governance
      # §13.5 says "a surprising bill is an alerting failure", and an alert
      # that reaches exactly one person's mailbox fails the moment that person
      # is on a plane.
      #
      # This is a CROSS-STATE reference by literal ARN, not a Terraform
      # resource reference, and that is deliberate rather than lazy — the topic
      # lives in envs/staging (separate state), and a remote-state data source
      # would couple the audit baseline's apply to an environment that is
      # explicitly disposable (G1).
      #
      # The other half of the contract is already written: the topic policy in
      # envs/staging/observability.tf carries `AllowAWSBudgetsToPublish`,
      # scoped to `arn:aws:budgets::<account>:*`, and its comment names this
      # exact ARN. ⚠ RENAMING THE TOPIC BREAKS THIS SILENTLY — Budgets does not
      # report a failed publish anywhere a human sees it. Change both files in
      # the same PR.
      subscriber_sns_topic_arns = [local.budget_alert_topic_arn]
    }
  }
}

# --------------------------------------------------------------------------
# The pot.
#
# Runbook Appendix B fixes the AWS spend envelope at $8,000 across 6 months.
# AWS Budgets has no six-month period, so an ANNUALLY budget with a fixed
# start is how you see "how much of the pot is gone" (runbook Step 10.1).
#
# This is a cumulative tracker, not a rate limit. The monthly budget above
# answers "are we burning too fast this month"; this one answers "how much
# runway is left", and those are different questions with different answers —
# a quiet month does not refill the pot.
# --------------------------------------------------------------------------
resource "aws_budgets_budget" "pot" {
  name        = "neoting-pot-8000"
  budget_type = "COST"
  time_unit   = "ANNUALLY"
  limit_unit  = "USD"

  limit_amount = "8000.0"

  # CORRECTED 14 Aug 2026 (README.md gap 2). Was `2025-08-01_00:00`, adopted
  # from the live budget so the adoption PR could plan 0-create/0-destroy; the
  # correction was deliberately left to its own diff because it changes a number
  # the CEO reads.
  #
  # The pot was approved 13 Aug 2026 (D35) and covers six months from then. An
  # ANNUALLY budget starting 2025-08-01 opens its window twelve months before
  # Neoting existed, so "how much of the pot is gone" was answered against the
  # wrong period. Note the shape of the bug: because AWS recurs an annual budget
  # from its start month, the CURRENT period happened to run 2026-08-01 →
  # 2027-07-31 anyway — the reported figure was not wrong by a year, it was
  # right by accident, and would have stayed right until someone changed the
  # start. Fixing it makes the file state the intent instead of relying on the
  # coincidence.
  #
  # This does NOT fix the number. Gap 1 (no cost filter — this budget still
  # measures the whole shared account, Cedofinance and needz included) is what
  # makes the ~$908 reading meaningless, and it is blocked on the payer
  # activating the `Project` cost allocation tag. See README.md.
  time_period_start = "2026-08-01_00:00"
  time_period_end   = "2087-06-15_00:00"

  cost_types {
    # Same reasoning as the monthly budget, and even more load-bearing here:
    # this budget IS the credit tracker. Including credits would make it
    # permanently read ~$0.
    include_credit = false
    include_refund = false

    include_tax                = true
    include_subscription       = true
    include_upfront            = true
    include_recurring          = true
    include_other_subscription = true
    include_support            = true
    include_discount           = true

    use_blended   = false
    use_amortized = false
  }

  dynamic "notification" {
    for_each = local.budget_alert_thresholds
    content {
      notification_type          = notification.value.type
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = "PERCENTAGE"
      subscriber_email_addresses = [local.budget_alert_email]

      # ⚠ THE SNS TOPIC IS THE POINT, AND THE EMAIL STAYS ALONGSIDE IT.
      #
      # infra/README.md carried "budget notifications go to one personal inbox"
      # as a gap, and it is the right kind of gap to care about: Governance
      # §13.5 says "a surprising bill is an alerting failure", and an alert
      # that reaches exactly one person's mailbox fails the moment that person
      # is on a plane.
      #
      # This is a CROSS-STATE reference by literal ARN, not a Terraform
      # resource reference, and that is deliberate rather than lazy — the topic
      # lives in envs/staging (separate state), and a remote-state data source
      # would couple the audit baseline's apply to an environment that is
      # explicitly disposable (G1).
      #
      # The other half of the contract is already written: the topic policy in
      # envs/staging/observability.tf carries `AllowAWSBudgetsToPublish`,
      # scoped to `arn:aws:budgets::<account>:*`, and its comment names this
      # exact ARN. ⚠ RENAMING THE TOPIC BREAKS THIS SILENTLY — Budgets does not
      # report a failed publish anywhere a human sees it. Change both files in
      # the same PR.
      subscriber_sns_topic_arns = [local.budget_alert_topic_arn]
    }
  }
}

# --------------------------------------------------------------------------
# ⚠ NEITHER BUDGET HAS A COST FILTER, AND BOTH THEREFORE MEASURE THE WRONG
#   THING. Recorded here rather than silently fixed — see README.md §Gaps.
#
# Governance §13.5 / D36: "cost attribution in this account is per-tag, not
# per-account, because Neoting shares 252959251643 with unrelated products.
# `Project=neoting` is therefore load-bearing for every spend figure we quote
# — an untagged resource is an invisible one."
#
# As adopted, both budgets track the ENTIRE shared account: Cedofinance,
# visa-processing and needz spend counts against Neoting's $8,000 pot. Every
# figure these budgets report is somebody else's bill plus ours.
#
# The fix is a cost_filter on TagKeyValue = "user:Project$neoting", but it
# cannot simply be added:
#   1. The Project tag must first be ACTIVATED as a cost allocation tag in
#      Billing → Cost allocation tags (runbook Step 8). Until AWS activates
#      it — up to 24 h, and it only applies from activation forward — the
#      filter matches nothing and the budgets would read $0. Silently.
#   2. Resources created before tag activation are not retroactively
#      attributed, so there will be a discontinuity in the series.
#   3. Anything not tagged Project=neoting disappears from the figure, which
#      makes the staging default_tags block (envs/staging/main.tf) a billing
#      control, not just a label.
# Sequence: activate the tag → verify in Cost Explorer → then add the filter.
# --------------------------------------------------------------------------

output "budget_names" {
  value = [aws_budgets_budget.monthly.name, aws_budgets_budget.pot.name]
}
