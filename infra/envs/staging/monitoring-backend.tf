# --------------------------------------------------------------------------
# Monitoring backend — Amazon Managed Prometheus (AMP) and Amazon Managed
# Grafana (AMG). D24 · Kickoff 3.7 · runbook Step 7.2 · ADR 0005 Slice C.
#
# WHY THIS FILE EXISTS NOW
# Runbook Step 7.2 deferred AMP/AMG to Infra Week: "~$40-70/month you do not
# need while one staging environment exists". ADR 0005 §"The G8 trigger has
# fired" supersedes the calendar but NOT the cost logic — it says Slice C is
# "authored now and applied selectively. Writing the Terraform costs nothing…
# *Applying* it is a separate, reversible decision per component." ADR 0005
# names Managed Grafana specifically as one of those components.
#
# So this file is written to that rule, and the split is not arbitrary:
#
#   AMP   CREATED AND LIVE. An AMP workspace that ingests nothing bills
#         NOTHING — there is no base or hourly charge, and AWS prorates
#         ingestion/storage by the hour "billed only when you send metrics".
#         It costs $0.00/month today and it is the thing the application needs
#         to exist, because the remote_write URL is a config value the OTel
#         sidecar reads at boot.
#
#   AMG   AUTHORED, NOT APPLIED (local.grafana_workspace_enabled = false).
#         Grafana is the opposite shape: AWS bills "one minimum Editor user
#         licence per workspace per month" — $9 — EVEN IF NOBODY EVER LOGS IN.
#         And as verified below, nobody CAN log in: there is no working
#         identity path to this account's Grafana today. $9/month for a
#         workspace with no login path and no data in it is the definition of
#         spending the envelope on infrastructure with no users, which is the
#         exact thing ADR 0005 ¶67 refuses. Flipping the local is a one-line PR
#         when an IdP exists; the review that PR gets is the point.
#
# ⚠ BOTH WORKSPACES ARRIVE EMPTY AND STAY EMPTY UNTIL INSTRUMENTATION LANDS.
# Nothing in this repository emits OpenTelemetry as of 13 Aug 2026 — there is
# no application code, no image in ECR, and both ECS services sit at
# desired_count = 0 (services.tf). No OTel collector sidecar is attached to
# either task definition. AMP will therefore show zero series and Grafana, if
# enabled, would show zero panels. That is expected and correct, not a
# misconfiguration to go hunting for. Nothing here polls, scrapes or alarms, so
# empty costs nothing and pages nobody.
#
# This file creates NO alarms. Alerting lives in observability.tf against
# CloudWatch, which has real data today (Tier 1/2 there). AMP does not replace
# that and must not: a metric backend with no metrics cannot alert.
# --------------------------------------------------------------------------

# ==========================================================================
# ⚠⚠ METRIC CARDINALITY — READ THIS BEFORE YOU ADD A LABEL. ⚠⚠
#
# (runbook Step 7.2: "Metric-cardinality discipline starts now: never label a
# metric with a document ID, user ID, or workspace ID.")
#
# NEVER label a Prometheus metric with:
#     documentId · userId · workspaceId / businessId / practiceId ·
#     transactionId · traceId · email address · phone number · file name
#
# Prometheus bills and stores per TIME SERIES, and a time series is one unique
# combination of metric name and label values. A label is not a free annotation;
# it is a multiplier on the bill and on the memory of everything that reads it.
#
# THE ARITHMETIC, so this is a number and not a slogan. At a 15-second scrape
# interval one series produces 172,800 samples/month. AMP charges $0.90 per 10
# million samples ingested in the first tier, so:
#
#     one series                       = $0.0156 / month
#     one metric, no tenant label      = $0.0156 / month
#     + a businessId label, 500 firms  = $7.78   / month   (× 500)
#     … applied to 20 metrics          = $155    / month
#
# $155/month against a $150/month staging budget (Appendix B) — from adding one
# label that felt informative. A documentId label is worse and not by a factor:
# document IDs are UNBOUNDED, so the series count grows forever and the
# workspace never reaches a steady state. Storage compounds it, because those
# series are retained after they stop being written.
#
# It is also a PRIVACY control, not only a cost one. Governance §13.1 already
# requires the logger to scrub PII; a metric label is a second, quieter export
# path for exactly the same identifiers, and it lands in a store that is queried
# by URL and rendered on a dashboard.
#
# SAFE labels — bounded, small, and stable:
#     service (api|workers) · route class · queue name · job type ·
#     status class (2xx|4xx|5xx) · model tier (judgment|workhorse|mechanical) ·
#     outcome (ok|error|timeout)
#
# If you need per-document or per-firm detail, that is a LOG or a database
# query with a traceId, not a metric label. The same rule already governs the
# CloudWatch custom metrics in observability.tf — one rule, both backends.
# ==========================================================================

locals {
  # AMP workspaces have no unique name, only a display alias. nt-${env} keeps
  # it identifiable in a SHARED account where three unrelated Neovogent
  # products can create workspaces in the same region.
  amp_alias = "nt-${local.env}"

  # ------------------------------------------------------------------------
  # THE COST SWITCH. false = the AMG workspace is not created and bills $0.
  #
  # A local rather than a variable, deliberately: flipping it is a code change
  # that goes through review, which is the correct ceremony for a resource that
  # starts a recurring charge. A tfvar could be flipped from a laptop.
  #
  # DO NOT flip this until BOTH are true:
  #   1. An identity path exists — see the IDENTITY VERIFICATION block below.
  #      Today there is none, so a workspace created now has no login at all.
  #   2. Something is actually writing to AMP. An empty Grafana is a $9/month
  #      screenshot of the words "No data".
  # ------------------------------------------------------------------------
  grafana_workspace_enabled = false

  # AMP returns PrometheusEndpoint WITH a trailing slash
  # (https://aps-workspaces.eu-west-2.amazonaws.com/workspaces/ws-xxxx/).
  # trimsuffix rather than string-concatenating onto it directly: if AWS ever
  # stops sending the slash, naive concatenation yields a double slash that
  # some SigV4 signers canonicalise differently from the server and the failure
  # is a 403 that reads like a permissions problem.
  amp_endpoint         = trimsuffix(aws_prometheus_workspace.main.prometheus_endpoint, "/")
  amp_remote_write_url = "${local.amp_endpoint}/api/v1/remote_write"
  amp_query_url        = "${local.amp_endpoint}/api/v1/query"
}

# --------------------------------------------------------------------------
# Amazon Managed Prometheus — the workspace.
#
# COST: $0.00/month as it stands. AMP has no workspace, base or hourly charge;
# AWS bills samples ingested ($0.90 per 10M in the first 2B/month tier),
# storage ($0.03/GB-month) and queries ($0.10 per billion samples processed),
# all prorated hourly and "billed only when you send metrics". Zero writes,
# zero reads, zero bill. Sized honestly for when it IS in use at the foot of
# this file.
#
# ENCRYPTION — deliberately AWS-owned, not aws_kms_key.ops, and this is a
# considered choice rather than an oversight:
#
#   1. `kms_key_arn` is ForceNew on this resource. Setting it later is a
#      workspace REPLACEMENT — a new workspace ID, a new remote_write URL, and
#      every historical sample gone. Adding it before anyone depends on the URL
#      is cheap; adding it after is not. That argues for deciding now, and the
#      decision is "not yet", for reason 2.
#   2. A CMK on AMP requires the creating principal to hold `kms:CreateGrant`
#      on the key so AMP can hold a grant for the life of the workspace. The
#      ops key policy (observability.tf) grants role/nt-* only Encrypt, Decrypt,
#      GenerateDataKey* and DescribeKey — CreateGrant appears ONLY in the root
#      administration statement. So this cannot be switched on from this file
#      without editing observability.tf first, which is another lane.
#   3. Metrics here are operational telemetry, not customer documents. The §12
#      / D30 obligations that drive the docs CMK attach to receipts and
#      extractions, and — per the cardinality banner above — a correctly
#      labelled metric contains no customer identifier at all. Staging is
#      synthetic-data-only (G2) besides.
#
# FOLLOW-UP for whoever owns observability.tf, if a CMK is wanted before prod:
# add "kms:CreateGrant" to the AllowNeotingPrincipalsToUseKey statement on
# aws_kms_key.ops (it already carries the role/nt-* PrincipalArn condition),
# then set kms_key_arn here — accepting that it destroys and rebuilds the
# workspace. Prod should be created WITH the CMK on day one so this never
# becomes a migration.
# --------------------------------------------------------------------------
resource "aws_prometheus_workspace" "main" {
  alias = local.amp_alias

  # LOGGING CONFIGURATION — INCLUDED. Justification, since it was asked for:
  #
  # This log group receives rule-evaluation errors and warnings from the AMP
  # ruler. It is the ONLY place a failing recording or alerting rule surfaces —
  # AMP publishes no metric for "a rule stopped evaluating", so a rule with bad
  # PromQL, or one whose query starts timing out as series count grows, fails
  # SILENTLY and the dashboard panel it feeds simply goes flat. A flat panel
  # reads as "healthy" (the exact lie observability.tf's dashboard banner is
  # written to prevent).
  #
  # It costs $0 today because there are zero rule groups, so nothing is written
  # and CloudWatch bills ingestion and storage, not existence. Wiring it now
  # rather than "when we add rules" means the first rule is observable on the
  # day it lands instead of generating a follow-up ticket.
  logging_configuration {
    log_group_arn = "${aws_cloudwatch_log_group.prometheus_rules.arn}:*"
  }

  tags = { Component = "observability" }
}

# --------------------------------------------------------------------------
# The rules log group.
#
# ⚠ NAMING DEVIATION, AND IT IS MANDATORY, NOT PREFERENCE. The convention in
# this repo is /nt/${local.env}/<name> (compute.tf, network.tf). This group is
# /aws/vendedlogs/… instead, for the same class of reason edge.tf's WAF group
# must start with `aws-waf-logs-`: AWS controls the prefix, not us.
#
# When logging is enabled, AMP writes to this group by adding itself to the
# ACCOUNT-WIDE CloudWatch Logs resource policy. That policy is capped at 5,120
# characters, and CloudWatch Logs automatically covers any group under
# /aws/vendedlogs/ instead of consuming policy characters per group. In a
# SHARED account with three unrelated Neovogent products all able to add their
# own log destinations, that ceiling is a real thing to hit, and hitting it
# fails somebody else's apply, not ours. The AMP console prefixes groups this
# way for the same reason.
#
# Created here rather than left to AMP: auto-created groups have infinite
# retention, which is both a cost leak and a compliance problem (Gov §12.2) —
# the same argument compute.tf makes for the ECS groups.
#
# NO CMK, deliberately, and this is a genuine trade rather than the drift
# observability.tf tracks. The ops key policy grants CloudWatch Logs via the
# `logs.eu-west-2.amazonaws.com` service principal with an EncryptionContext
# condition. AMP's writer principal is `aps.amazonaws.com`, which appears in
# neither that key policy nor anywhere else, and I could not verify from here
# (no apply — the state is locked) whether the delivery is brokered by the logs
# service principal or performed under AMP's own. Encrypting on that assumption
# risks a group that silently accepts no writes, which is strictly worse than
# an unencrypted group holding nothing: it would mean the one signal that a
# rule is broken is itself broken.
#
# VERIFY AT FIRST RULE: create a rule group, break its PromQL on purpose, and
# confirm a line arrives here. If it does, add `kms_key_id =
# aws_kms_key.ops.arn` and confirm it STILL arrives. Do not add the key and
# assume.
# --------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "prometheus_rules" {
  name              = "/aws/vendedlogs/nt/${local.env}/prometheus-rules"
  retention_in_days = 30 # Governance §12.2

  tags = { Component = "observability" }
}

# --------------------------------------------------------------------------
# ALERT MANAGER DEFINITION — DELIBERATELY NOT CREATED. It was asked for; here
# is why building it today would have been worse than leaving it out.
#
# 1. IT WOULD ROUTE NOTHING. AMP's alertmanager dispatches alerts produced by
#    AMP RULE GROUPS (aws_prometheus_rule_group_namespace). There are zero rule
#    groups here, because there are zero metrics to write rules against. An
#    alertmanager definition with no rules upstream is a YAML document that is
#    parsed once and then never consulted.
#
# 2. IT WOULD BE A SILENTLY DEAD ALERT PATH. AMP's alertmanager supports
#    exactly one receiver type: SNS (`sns_configs`). The obvious target is
#    aws_sns_topic.alerts — and that topic is SSE-KMS under aws_kms_key.ops,
#    whose policy enumerates four service principals and only four:
#    cloudwatch, events, budgets, ses. `aps.amazonaws.com` is in neither the
#    key policy nor aws_sns_topic_policy.alerts. AMP would accept the
#    definition, then every publish would be rejected by KMS at the moment an
#    alert actually fired.
#
#    observability.tf names this exact failure and calls it "the worst failure
#    mode an alerting system has": "Miss one of these principals and the alarm
#    fires, SNS rejects the publish, and nobody is told. Add the principal here
#    AND in the topic policy below, never one without the other."
#
#    Both of those policies live in observability.tf. Editing another lane's
#    file to half-wire an alert path that has nothing to alert on is how two
#    agents fight over one resource and how a broken pipe gets marked done.
#
# FOLLOW-UP for whoever owns observability.tf, to be done in the SAME PR as the
# first aws_prometheus_rule_group_namespace and not before:
#
#   a) aws_kms_key.ops → AllowAWSServicesToPublishToEncryptedTopic:
#        add "aps.amazonaws.com" to the Service principal list.
#   b) aws_sns_topic_policy.alerts → a new statement:
#        Sid       = "AllowManagedPrometheusToPublish"
#        Principal = { Service = "aps.amazonaws.com" }
#        Action    = "SNS:Publish"
#        Condition = StringEquals aws:SourceAccount = ${local.account_id}
#                    ArnLike      aws:SourceArn     = <this workspace ARN>
#   c) THEN add aws_prometheus_alert_manager_definition here, and prove it end
#      to end by firing a deliberately-true test rule. Governance §13.2's
#      quarterly alert-path drill exists because this is the one control that
#      cannot be verified by reading it.
#
# Until (a) and (b) exist, alerting stays entirely in CloudWatch
# (observability.tf), where the publish path is already proven.
# --------------------------------------------------------------------------

# ==========================================================================
# IDENTITY VERIFICATION — why AMG cannot authenticate via IAM Identity Center.
#
# Runbook Step 7.2 asks for "AMG authenticated via IAM Identity Center (Step
# 1.6) so Grafana access follows the same identity as everything else". That
# is the right design and it is NOT AVAILABLE IN THIS ACCOUNT. Verified with
# read-only calls on 13 Aug 2026, not assumed:
#
#   $ aws sso-admin list-instances --region eu-west-2
#     InstanceArn      arn:aws:sso:::instance/ssoins-75358005bd96d2de
#     IdentityStoreId  d-9c67b33db3
#     OwnerAccountId   252959251643      ← OUR account, not the org's payer
#     Status           ACTIVE
#
#   $ aws sso-admin list-permission-sets --instance-arn <above>
#     ValidationException: This operation is not supported for ACCOUNT
#     INSTANCES of IAM Identity Center.
#
#   $ aws identitystore list-users --identity-store-id d-9c67b33db3
#     { "Users": [] }        ← the directory is EMPTY
#
# So an IdC instance does exist — it is an ACCOUNT INSTANCE, created in this
# account. (ADR 0005 lists "SSO" under Slice A; this is that. Note it did not
# exist when the survey behind ADR 0005 was run, so "no SSO setup" is stale.)
#
# AND AMAZON MANAGED GRAFANA DOES NOT SUPPORT ACCOUNT INSTANCES. AWS publishes
# a per-application table of which managed applications integrate with account
# instances; Amazon Managed Grafana's column reads **No**. AMG resolves
# IAM Identity Center through the ORGANISATION instance of the org the account
# belongs to. The symptom of ignoring this is not a clean error — it is a
# workspace that comes up and then cannot find any user or group to assign.
#
# AN ORGANISATION INSTANCE CANNOT BE CREATED HERE EITHER, for two independent
# reasons, either of which alone is fatal:
#   * The organisation is o-4w28uo5lvn with FeatureSet CONSOLIDATED_BILLING and
#     AvailablePolicyTypes [] (ADR 0005 measured this). An organisation
#     instance of IdC requires ALL_FEATURES.
#   * It would have to be created in the MANAGEMENT account, 776016087896 —
#     aws@cloudvisor.eu, the reseller. We do not control it and cannot make
#     this a support ticket to ourselves.
#
# The seven principals in this account (ADR 0005) are plain IAM users, and AMG
# explicitly "does not support the use of IAM users and roles to assign
# permissions within an Amazon Managed Grafana workspace".
#
# CONCLUSION: authentication_providers = ["AWS_SSO"] is NOT WRITTEN, because it
# would either fail on apply or — worse — succeed into a workspace with no
# assignable users. The workspace below declares ["SAML"], which is the only
# provider that can work here, and it is disabled until a SAML IdP exists.
# ==========================================================================

# --------------------------------------------------------------------------
# The role AMG assumes to read AMP.
#
# CREATED UNCONDITIONALLY even though the workspace is not, because an IAM role
# and its inline policy cost $0.00 and AMG requires role_arn at CREATE time
# under CUSTOMER_MANAGED permissions. Having it already in place is what makes
# enabling Grafana a one-line flip of local.grafana_workspace_enabled rather
# than a two-stage apply.
#
# ⚠ NAMED nt-* AND THAT IS LOAD-BEARING, NOT COSMETIC. ADR 0005: every bucket
# and KMS deny guard in this account keys off
# arn:aws:iam::252959251643:role/nt-*. A role called "grafana-amp-reader" would
# be denied by those policies with a message that reads like a permissions bug
# rather than a naming bug. This role does not touch Neoting S3 or KMS today —
# it is named to the contract anyway, because the day someone adds a CloudWatch
# Logs or S3 data source to Grafana is not the day to rediscover this.
#
# CUSTOMER_MANAGED rather than SERVICE_MANAGED permissions on the workspace
# below: SERVICE_MANAGED asks AMG to mint its own IAM role and policies, which
# needs iam:CreateRole / iam:CreatePolicy / iam:AttachRolePolicy on the caller
# and produces a role AWS names — i.e. a role that is not nt-*, created outside
# Terraform, in a shared account. Both halves of that are unacceptable here.
# --------------------------------------------------------------------------
resource "aws_iam_role" "grafana" {
  name        = "nt-${local.env}-grafana"
  description = "Amazon Managed Grafana workspace role - read-only query access to the AMP workspace"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "grafana.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }

        # ArnLike on a WILDCARD workspace path, not the concrete workspace ARN,
        # and not for laziness. The workspace needs this role's ARN at creation
        # and the role would need the workspace's ARN in its trust policy — a
        # dependency cycle Terraform cannot resolve, and one that a two-stage
        # apply "fixes" only until someone destroys and recreates. The wildcard
        # is still a real confused-deputy guard: combined with SourceAccount it
        # confines this role to Grafana workspaces in THIS account and region,
        # which in a shared account is the boundary that matters.
        ArnLike = {
          "aws:SourceArn" = "arn:aws:grafana:${local.region}:${local.account_id}:/workspaces/*"
        }
      }
    }]
  })

  tags = { Component = "observability" }
}

resource "aws_iam_role_policy" "grafana_amp_read" {
  name = "nt-grafana-amp-read"
  role = aws_iam_role.grafana.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # READ ONLY. No aps:RemoteWrite, no aps:Create*, no aps:Delete*, no
        # aps:PutRuleGroupsNamespace. A dashboard tool that can write to the
        # metric store can rewrite history, and a Grafana workspace is a
        # browser-facing surface reachable by anyone with a login.
        Sid    = "QueryTheNeotingWorkspace"
        Effect = "Allow"
        Action = [
          "aps:QueryMetrics",
          "aps:GetLabels",
          "aps:GetSeries",
          "aps:GetMetricMetadata",
          "aps:DescribeWorkspace",
        ]
        # Pinned to OUR workspace, not aps:*. The account is shared; another
        # Neovogent product's workspace in this region must not be queryable
        # from Neoting's Grafana just because both live here.
        Resource = aws_prometheus_workspace.main.arn
      },
      {
        # ListWorkspaces admits no resource-level permission — it is how the
        # Grafana data-source picker enumerates candidates. Harmless: it
        # returns identifiers, never samples, and the statement above is what
        # decides whose data can actually be read.
        Sid      = "EnumerateWorkspacesForTheDataSourcePicker"
        Effect   = "Allow"
        Action   = ["aps:ListWorkspaces"]
        Resource = "*"
      }
    ]
  })

  # NOT GRANTED, so the absence is a decision on the record rather than an
  # oversight: cloudwatch:GetMetricData / logs:StartQuery / tag:GetResources,
  # which a Grafana CloudWatch data source needs. Everything with real data
  # today is in CloudWatch (observability.tf), so that data source is the
  # tempting first thing to add — and it would hand a browser-facing tool read
  # access to every log group in a SHARED account, including three other
  # products'. If it is added, scope it to /nt/${local.env}/* log groups and
  # the Neoting/* metric namespaces explicitly, and put it in its own statement
  # so it can be revoked without touching AMP access.
}

# --------------------------------------------------------------------------
# Amazon Managed Grafana — the workspace. DISABLED (count = 0) by default.
#
# COST WHEN ENABLED, stated plainly because the number is not intuitive: AWS
# bills "one minimum Editor user licence per workspace per month" whether or
# not a single person signs in. That is $9/month for an empty, unloggable
# workspace. Beyond the minimum it is $9 per active editor/administrator and $5
# per active viewer, per workspace, per month, where "active" means signed in
# or made an API request at least once in the billing cycle.
#
# ⚠ API KEYS AND SERVICE ACCOUNTS BILL AS USERS at their permission level. A
# CI job holding an editor API key to push dashboards is $9/month, permanently,
# and it does not appear in any user list anybody thinks to check.
#
# WHAT MUST BE DONE OUT OF BAND BEFORE THIS IS FLIPPED TO true — all of it,
# in order, or the workspace is $9/month of nothing:
#
#   1. Obtain a SAML IdP. There is none today. Realistic options:
#      (a) Google Workspace or Microsoft Entra ID, if Neovogent has one — this
#          is the cheapest correct answer and needs no new vendor.
#      (b) An IdC ORGANISATION instance, which needs Cloudvisor to move the org
#          to ALL_FEATURES (ADR 0005 follow-up 2 already chases this). If that
#          lands, delete this SAML block entirely and use AWS_SSO, which is
#          what runbook Step 7.2 actually wants.
#      The existing ACCOUNT instance cannot be used — see the verification
#      block above. Do not try to make it work; AWS documents it as
#      unsupported for AMG.
#   2. Register Grafana as a SAML application in that IdP. AMG's SP metadata is
#      only available AFTER the workspace exists, so this is genuinely a
#      two-step: apply with the flag on, read the workspace's SSO endpoints
#      from the console, then finish the IdP side.
#   3. Add an aws_grafana_workspace_saml_configuration resource here with
#      idp_metadata_url (or _xml), and map at minimum:
#        admin_role_values  = ["neoting-eng"]
#        editor_role_values = ["neoting-eng"]
#      plus login/name/email assertion attributes. Until that resource exists
#      the workspace reports saml_configuration_status = NOT_CONFIGURED and
#      nobody can sign in. It is NOT written now because a SAML configuration
#      pointing at an IdP that does not exist is config that fails on apply.
#   4. Only then flip local.grafana_workspace_enabled to true, in a PR.
#
# The workspace itself reaches ACTIVE without step 3, which is why this is
# apply-safe rather than apply-broken — but "ACTIVE" and "usable" are different
# words and the bill starts at ACTIVE.
# --------------------------------------------------------------------------
resource "aws_grafana_workspace" "main" {
  count = local.grafana_workspace_enabled ? 1 : 0

  name        = "nt-${local.env}"
  description = "Neoting ${local.env} - OTel metrics from Amazon Managed Prometheus (D24)"

  # CURRENT_ACCOUNT, never ORGANIZATION. ORGANIZATION deploys CloudFormation
  # StackSets into other accounts to create cross-account read roles — in an
  # org owned by a reseller, whose other members are unrelated customers. D30
  # and ADR 0005 both stop here.
  account_access_type = "CURRENT_ACCOUNT"

  # SAML, not AWS_SSO. The full evidence is in the IDENTITY VERIFICATION block
  # above; the short version is that AMG does not support account instances of
  # IAM Identity Center and no organisation instance can exist in this org.
  authentication_providers = ["SAML"]

  # Our role, our naming contract, our least privilege — see the role above.
  permission_type = "CUSTOMER_MANAGED"
  role_arn        = aws_iam_role.grafana.arn

  # Declarative under CUSTOMER_MANAGED: it populates the data-source picker but
  # grants nothing. The actual authority is aws_iam_role_policy.grafana_amp_read,
  # which is AMP-only. CLOUDWATCH is deliberately absent from this list to match.
  data_sources = ["PROMETHEUS"]

  # notification_destinations = ["SNS"] is deliberately omitted. Grafana-managed
  # alerting would publish to aws_sns_topic.alerts, which is SSE-KMS under
  # aws_kms_key.ops — and this role has no kms:GenerateDataKey* on that key, so
  # the notification would be rejected at publish time. Same trap as the AMP
  # alertmanager above, same fix, same file to fix it in. Alerting stays in
  # CloudWatch until that is done. Two alerting systems is worse than one.

  # grafana_version is intentionally unset. AMG picks its current default and
  # the provider treats the attribute as computed. Pinning a version string
  # that AWS later retires turns a routine apply into a hard failure, and the
  # Grafana version is not something this project has an opinion about.

  tags = { Component = "observability" }

  lifecycle {
    # AMG rewrites grafana_version during its own managed upgrades. Without
    # this, the next apply after an AWS-side upgrade proposes a downgrade.
    ignore_changes = [grafana_version]
  }
}

# --------------------------------------------------------------------------
# AMP remote-write for the application's OTel collector sidecar.
#
# Runbook Step 7.2 is emphatic and correct: "Emit OTel from day one regardless
# — the collector's remote_write target is config; the instrumentation is not,
# and retrofitting trace propagation across BullMQ later is a rewrite." This
# grant is the whole AWS-side prerequisite for that. Nothing else has to be
# built for the collector to start writing.
#
# Attached to aws_iam_role.app (the ECS TASK role, main.tf), not to a new role.
# The ADOT sidecar runs inside the task and signs remote_write with SigV4 using
# the task's credentials, so the permission has to live on the identity the
# container already assumes. A second inline policy on a role another file
# owns follows the precedent secrets.tf set with
# aws_iam_role_policy.ecs_execution_app_secrets — inline policies union, and
# keeping the grant beside the resource it names means the workspace can never
# be deleted while an orphaned grant to its ARN survives in someone else's file.
#
# WRITE ONLY. aps:RemoteWrite and nothing else — no query, no rule management,
# no describe. The application produces metrics; it never reads them back. A
# compromised task can therefore pollute the metric store, which is bad, but it
# cannot mine it for whatever labels a future careless commit adds.
#
# COST: $0.00. An IAM policy is free, and this grants a permission that nothing
# currently exercises.
# --------------------------------------------------------------------------
resource "aws_iam_role_policy" "app_amp_remote_write" {
  name = "nt-amp-remote-write"
  role = aws_iam_role.app.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "RemoteWriteToTheNeotingWorkspace"
      Effect   = "Allow"
      Action   = ["aps:RemoteWrite"]
      Resource = aws_prometheus_workspace.main.arn
    }]
  })
}

# --------------------------------------------------------------------------
# The handoff to the application: SSM Parameter Store.
#
# WHY A PARAMETER AND NOT JUST AN OUTPUT. A Terraform output is visible only to
# whoever runs Terraform. The thing that needs the remote_write URL is an OTel
# collector inside a Fargate task, and the URL contains the workspace ID, which
# is generated at create time and is not derivable from anything in the repo.
# Without a runtime-readable source, wiring the collector means copying a
# generated identifier into a task definition by hand — which is the class of
# step that gets done once, in staging, and is wrong in prod.
#
# This is exactly the G8 test ADR 0005 states: "the flip changes config and
# pipelines, never application code."
#
# NOT SECRETS MANAGER. These are non-secret coordinates — an endpoint URL and a
# workspace ID, both useless without the IAM grant above. Secrets Manager bills
# $0.40/secret/month (secrets.tf) and this is not a credential. Standard-tier
# SSM parameters are free, with no per-parameter or per-API charge at this
# volume. Same reasoning services.tf uses to keep bucket names and endpoints in
# `environment` rather than `secrets`.
#
# Path is /neoting/${local.env}/otel/… — the runbook §0.2 shape. SSM and
# Secrets Manager are separate namespaces in separate services, so this cannot
# collide with the /neoting/${local.env}/<vendor> secrets in secrets.tf.
#
# COST: $0.00/month. Standard tier, well inside the free allowance.
# --------------------------------------------------------------------------
resource "aws_ssm_parameter" "amp_remote_write_url" {
  name        = "/neoting/${local.env}/otel/prometheus-remote-write-url"
  description = "AMP remote_write endpoint for the ADOT sidecar. SigV4 with the task role; region eu-west-2, service aps."
  type        = "String" # not SecureString: not a secret, and SecureString would add a KMS decrypt to every task start
  value       = local.amp_remote_write_url

  tags = { Component = "observability" }
}

resource "aws_ssm_parameter" "amp_workspace_id" {
  name        = "/neoting/${local.env}/otel/prometheus-workspace-id"
  description = "AMP workspace ID (ws-…). Needed by anything that calls the aps API directly rather than via remote_write."
  type        = "String"
  value       = aws_prometheus_workspace.main.id

  tags = { Component = "observability" }
}

# The read grant, so the compute lane's change is genuinely one line.
#
# EXECUTION role, not the task role, matching secrets.tf: a task definition
# `secrets` entry accepts an SSM parameter ARN and the ECS agent resolves it at
# task start, so the running application receives an environment variable and
# never calls SSM itself. If a future collector config genuinely needs a
# runtime lookup, grant that one parameter to the task role explicitly rather
# than copying this policy across.
#
# FOLLOW-UP for whoever owns services.tf — add to local.common_environment via
# the `secrets` block on both task definitions (NOT `environment`; that field
# takes literals, and these values are only known post-apply):
#   { name = "OTEL_EXPORTER_PROMETHEUS_REMOTE_WRITE_URL",
#     valueFrom = "<arn of aws_ssm_parameter.amp_remote_write_url>" }
# and attach an ADOT sidecar container. Until that happens AMP receives
# nothing, which is the honest state of this environment.
resource "aws_iam_role_policy" "ecs_execution_otel_parameters" {
  name = "read-otel-parameters"
  role = aws_iam_role.ecs_execution.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ReadOtelCoordinates"
      Effect = "Allow"
      Action = ["ssm:GetParameters"] # the plural form is the one the ECS agent calls
      Resource = [
        aws_ssm_parameter.amp_remote_write_url.arn,
        aws_ssm_parameter.amp_workspace_id.arn,
      ]
      # No kms:Decrypt companion statement: both parameters are String, not
      # SecureString, so no KMS call is involved. If either is ever promoted to
      # SecureString, this policy breaks silently at task start and the symptom
      # is ResourceInitializationError — which reads like a broken image.
    }]
  })
}

# --------------------------------------------------------------------------
# COST — what this file adds, honestly.
#
# TODAY, AS APPLIED:
#
#   AMP workspace                     $0.00   no base/hourly charge; ingestion,
#                                             storage and query are prorated
#                                             hourly and billed only on use.
#                                             Nothing writes to it.
#   CloudWatch log group (rules)      $0.00   billed on ingestion + storage;
#                                             zero rule groups means zero lines
#   SSM parameters × 2                $0.00   Standard tier
#   IAM roles and policies × 4        $0.00   IAM is not billed
#   AMG workspace                     $0.00   NOT CREATED (count = 0)
#   ------------------------------------------
#   TOTAL ADDED                       $0.00 / month
#
# Runbook Step 7.2 budgeted $40–70/month for AMP+AMG. This spends none of it,
# and the reason is not cleverness — it is that AMP genuinely does not charge
# for an idle workspace, so the useful half of Step 7.2 was free all along and
# the expensive half is the half nobody can use yet.
#
# WHAT IT COSTS ONCE INSTRUMENTATION LANDS (the number to plan against):
#
#   Assume the shape services.tf actually describes — 2 api tasks + 1 worker,
#   an ADOT sidecar per task, a 15-second interval, and a disciplined ~500
#   series per task (Node runtime + HTTP + the nine Neoting/Pipeline metrics
#   observability.tf specifies):
#
#     1,500 series × 172,800 samples/series/month  ≈ 259M samples/month
#     259M ÷ 10M × $0.90                            ≈ $23.30  ingestion
#     ~150-day retention at ~2 bytes/sample         ≈  $0.10  storage
#     dashboard queries, one workspace, few users   ≈  $0.50  queries
#     ------------------------------------------------------
#     AMP in use                                    ≈ $24 / month
#
#   That is ABOVE runbook Step 7.2's $40–70 combined estimate only once AMG is
#   added, and it is entirely driven by series count — see the cardinality
#   banner at the top. The single biggest lever on this bill is not the scrape
#   interval, it is whether anyone adds a high-cardinality label.
#
#   AMG when enabled: $9/month floor per workspace even at zero logins, plus $9
#   per active editor and $5 per active viewer. Three engineers as editors is
#   $27/month. Plus $9 for every API key or service account.
#
#   Realistic Infra Week total once both are live and instrumented:
#   ~$50/month, against Appendix B's ~$150/month staging envelope. That is a
#   THIRD of staging's budget for telemetry, on top of the ~$5/month
#   CloudWatch stack in observability.tf which does not go away — AMP cannot
#   alert on RDS, ElastiCache, SES or the ALB, and observability.tf's Tier 1/2
#   alarms are the ones with real data. Budget for both, or decide explicitly
#   to retire one.
#
# THE FINDING WORTH SAYING OUT LOUD: the deferral in runbook Step 7.2 was
# right for AMG and wrong for AMP. AMP should have been created on day one —
# it is free until used, and its endpoint is the config the application needs
# before a line of collector code is written. AMG is the reverse: it starts
# billing the moment it exists, and it cannot be logged into at all until an
# identity problem that is owned by a third-party reseller is resolved.
# --------------------------------------------------------------------------

output "amp_workspace_id" {
  value       = aws_prometheus_workspace.main.id
  description = "AMP workspace ID. The workspace is EMPTY - nothing emits OTel yet (13 Aug 2026)."
}

output "amp_workspace_arn" { value = aws_prometheus_workspace.main.arn }

output "amp_remote_write_url" {
  value = local.amp_remote_write_url
  # Literal path, not "${local.env}": an output's `description` is a meta
  # argument that must be a constant, and interpolation there is a plan-time
  # error ("Variables may not be used here"), not a runtime one.
  description = "OTel collector remote_write target. Also published to SSM at /neoting/staging/otel/prometheus-remote-write-url for runtime injection."
}

output "amp_query_url" {
  value       = local.amp_query_url
  description = "PromQL query endpoint. SigV4, service 'aps'. Returns nothing until instrumentation lands."
}

output "grafana_role_arn" {
  value       = aws_iam_role.grafana.arn
  description = "Role AMG assumes to query AMP. Exists whether or not the workspace does, so enabling Grafana is a one-line flip."
}

output "grafana_workspace_endpoint" {
  # one() rather than [0]: returns null when the workspace is disabled instead
  # of failing the whole output block on an empty list.
  value       = one(aws_grafana_workspace.main[*].endpoint)
  description = "null while local.grafana_workspace_enabled = false. See the SAML prerequisites in monitoring-backend.tf before flipping it - AWS_SSO is not available in this account."
}
