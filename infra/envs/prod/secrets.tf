# ==========================================================================
# Secrets Manager — the platform credentials the application needs at boot
# (runbook Step 6.6, Governance §11.5).
#
# `.env.example` is the boot contract: the app parses it with Zod and fails
# fast on anything missing or malformed. Every third-party value in that file
# has to exist HERE for a deployed task, because §11.5 forbids plaintext
# `environment` values in a task definition. Two are deliberately not
# duplicated: the Redis connection (module.data) and the RDS master password
# (AWS-generated, module.data).
#
# ⚠ THE DIFFERENCE FROM STAGING THAT MATTERS MOST IS NOT IN THIS FILE. It is
# in what gets written into these secrets. Guideline §8.4 (G2) puts SANDBOX
# credentials in staging — a leaked staging Twilio token is a sandbox token.
# The values that belong here are LIVE: a Twilio account that can text real
# clients, a Xero app that can write to real ledgers, a TrueLayer client that
# can read real bank feeds. Everything below is a placeholder until a human
# writes those in out of band, and nothing in Terraform ever sees them.
#
# SCOPE — read this before adding anything. Runbook §6.6 draws a hard line:
# Secrets Manager holds PLATFORM credentials (our Xero app's client secret, our
# Twilio account), while PER-TENANT OAuth tokens live encrypted in the database
# vault table (SoT §18). A client's Xero refresh token must never be written
# here. There is one Xero app and eventually thousands of connections; a
# per-tenant secret would be both a $0.40/tenant/month bill and a tenancy
# boundary enforced by IAM instead of by RLS, which is exactly the inversion
# Governance §5.2 exists to prevent.
#
# COST: Secrets Manager bills per SECRET, not per value — $0.40/secret/month
# plus $0.05 per 10k API calls. The 20 values below, grouped into 9 vendor
# secrets, cost ~$3.60/mo; one secret per value would be ~$8.00/mo for
# identical data. API calls round to nothing: the ECS agent reads each secret
# once per task start, not once per request.
# ==========================================================================

# --------------------------------------------------------------------------
# KMS — the credentials CMK.
#
# A dedicated key, rather than reusing alias/nt-prod-docs, is what makes "who
# can read a credential" a different question from "who can read a client's
# receipt". Both answers are `role/nt-*` today, but they will diverge — the
# document key has to be usable by every worker, while this key only ever needs
# to be usable by the ECS agent at task start. Sharing one key would make that
# narrowing impossible later without a re-encryption exercise.
#
# COST: $1/month per CMK plus $0.03/10k requests. Requests are per task start,
# so the $1 is the whole bill.
# --------------------------------------------------------------------------
resource "aws_kms_key" "secrets" {
  description              = "Neoting production - Secrets Manager platform credentials (D30 ${local.region})"
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"

  # Annual rotation of the key MATERIAL. This is the only part of Governance
  # §11.5's "at most every 12 months" that AWS can honour automatically — see
  # the ROTATION banner below for why the secret VALUES cannot be.
  enable_key_rotation = true

  # 30 days, the maximum, and not a number to trim. Deleting this key does not
  # delete the secrets — it makes every one of them permanently unreadable,
  # with no restore path at all, because the ciphertext without the key is just
  # bytes. The window is the only undo that exists.
  deletion_window_in_days = 30

  # Same shape as the docs key: root administers, principals matching
  # role/nt-* (plus the one named human) may use it, everyone else is
  # explicitly denied. The SES allow and the AWS-service exemption from the
  # docs policy are BOTH dropped here on purpose — SES encrypts inbound mail
  # under its own service principal, but nothing encrypts a secret on its own
  # behalf. Secrets Manager calls KMS with the CALLER's credentials
  # (aws:PrincipalArn is the assuming role's ARN, not an STS session ARN), so
  # role/nt-* covers the real path and the deny can stay absolute.
  policy = templatefile("${path.module}/policies/kms-secrets.json.tftpl", {
    account_id = local.account_id
    env        = local.env
  })

  tags = { DataClass = "credential" }
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/nt-${local.env}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

# ⚠ OPERATOR TRAP, and it will look like a Secrets Manager bug: the deny above
# matches on aws:PrincipalArn, and an AWS Identity Center session
# (role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_*) matches neither
# role/nt-* nor user/Mubashir. Reading or SETTING a value in the console from
# an SSO session therefore fails at the KMS layer with AccessDenied while the
# secret itself is perfectly readable.
#
# This bites harder in prod than in staging, because setting the real values
# below is exactly the console task a human will try to do from an SSO session
# on day one. If SSO becomes the normal human path (runbook Step 1.4), add the
# SSO role ARN pattern to policies/kms-secrets.json.tftpl in the same change —
# do not "fix" it by widening the grant to the account root.

# --------------------------------------------------------------------------
# The secrets themselves.
#
# One secret per VENDOR, holding a JSON object, because that is the unit a
# credential actually rotates in: a Twilio account SID and its auth token are
# replaced together and are useless apart. The JSON keys map to the
# `.env.example` variable names, which is what lets the compute lane write a
# task-definition `secrets` entry of the form `<secret-arn>:<json-key>::`.
#
# Values are PLACEHOLDERS and stay placeholders. Real values are set out of
# band:
#
#   aws secretsmanager put-secret-value --secret-id /neoting/prod/twilio \
#     --secret-string file://tmp.json    # file://, NEVER inline
#
# Inline `--secret-string` lands the live credential in shell history and in
# the CloudTrail request record. Delete the file afterwards.
#
# The placeholder strings deliberately name their own variable
# ("PLACEHOLDER_TWILIO_AUTH_TOKEN"): if one surfaces in a log, an error report
# or a vendor's 401, it is instantly greppable and instantly obviously fake. A
# realistic-looking dummy would not be — and in production, "is this a real
# credential in a log?" is a question you want answered in one second.
# --------------------------------------------------------------------------

locals {
  # NOTE: adding a KEY to a group here does NOT reach AWS after the first
  # apply — `ignore_changes = [secret_string]` covers the whole attribute, not
  # per-key. This map is the documented SHAPE of each secret; after first
  # apply, delivery of any new key is a put-secret-value away.
  app_secrets = {
    # SESSION_SECRET, OTP_PEPPER. Generate with `openssl rand -hex 32`.
    #
    # Not generated with random_password (as module.data does for the Redis
    # auth token) on purpose: a session secret in Terraform state is a session
    # secret that every plan diff and every state reader can see, and it could
    # then only be rotated by an apply — the wrong blast radius for a value
    # that logs every user out when it changes.
    auth = {
      description = "Session signing secret and OTP pepper - portal OTP path (SoT Stage 5)"
      values = {
        session_secret = "PLACEHOLDER_SESSION_SECRET"
        otp_pepper     = "PLACEHOLDER_OTP_PEPPER"
      }
    }

    # TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID,
    # TWILIO_MESSAGING_SERVICE_SID. Sole SMS + OTP provider.
    #
    # ⚠ THIS IS THE ONE THAT TEXTS REAL PEOPLE. CLAUDE.md makes anything
    # touching SMS sending or chase templates a stop-and-ask-a-human change.
    # A production Twilio credential in a misconfigured environment is not a
    # billing incident, it is a client of an accounting practice receiving a
    # chase message they did not expect.
    twilio = {
      description = "Twilio platform credentials - SMS chase + Verify OTP (LIVE credentials, not sandbox)"
      values = {
        account_sid           = "PLACEHOLDER_TWILIO_ACCOUNT_SID"
        auth_token            = "PLACEHOLDER_TWILIO_AUTH_TOKEN"
        verify_service_sid    = "PLACEHOLDER_TWILIO_VERIFY_SERVICE_SID"
        messaging_service_sid = "PLACEHOLDER_TWILIO_MESSAGING_SERVICE_SID"
      }
    }

    # XERO_CLIENT_ID, XERO_CLIENT_SECRET. Our app's registration, not any
    # client's connection — see the SCOPE note at the top of this file.
    xero = {
      description = "Xero app client credentials - publish target (per-tenant tokens live in the DB vault, SoT §18)"
      values = {
        client_id     = "PLACEHOLDER_XERO_CLIENT_ID"
        client_secret = "PLACEHOLDER_XERO_CLIENT_SECRET"
      }
    }

    # INTUIT_CLIENT_ID, INTUIT_CLIENT_SECRET (QuickBooks Online).
    intuit = {
      description = "Intuit QuickBooks Online app client credentials - publish target"
      values = {
        client_id     = "PLACEHOLDER_INTUIT_CLIENT_ID"
        client_secret = "PLACEHOLDER_INTUIT_CLIENT_SECRET"
      }
    }

    # TRUELAYER_CLIENT_ID, TRUELAYER_CLIENT_SECRET. Sole bank-feed provider.
    # Production access is gated on TrueLayer's own review (Kickoff §9), which
    # is one of the long-pole clocks — the secret existing does not mean the
    # credential does.
    truelayer = {
      description = "TrueLayer client credentials - bank feed (sole provider)"
      values = {
        client_id     = "PLACEHOLDER_TRUELAYER_CLIENT_ID"
        client_secret = "PLACEHOLDER_TRUELAYER_CLIENT_SECRET"
      }
    }

    # COMPANIES_HOUSE_API_KEY. Single key, still its own secret rather than a
    # lodger in another group: it is issued, revoked and rotated by an
    # unrelated party, and grouping it with a vendor it has nothing to do with
    # would mean rotating one credential touches two.
    companies-house = {
      description = "Companies House API key - company lookup at onboarding"
      values = {
        api_key = "PLACEHOLDER_COMPANIES_HOUSE_API_KEY"
      }
    }

    # HMRC_CLIENT_ID, HMRC_CLIENT_SECRET. Developer Hub application, used for
    # the check-VAT-number API.
    hmrc = {
      description = "HMRC Developer Hub application credentials - check-VAT-number API"
      values = {
        client_id     = "PLACEHOLDER_HMRC_CLIENT_ID"
        client_secret = "PLACEHOLDER_HMRC_CLIENT_SECRET"
      }
    }

    # WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET. The app secret is what the
    # inbound webhook HMAC is computed with (Governance §11.7) — treat a leak
    # of it as "anyone can forge an inbound message", not as a config value.
    whatsapp = {
      description = "Meta WhatsApp Business Platform - webhook verify token and app secret (HMAC, Gov §11.7)"
      values = {
        verify_token = "PLACEHOLDER_WHATSAPP_VERIFY_TOKEN"
        app_secret   = "PLACEHOLDER_WHATSAPP_APP_SECRET"
      }
    }

    # Sentry EU, one DSN per app (Kickoff 4.9, D24).
    #
    # Honest caveat: `dsn_web` is NOT a secret. A browser DSN ships inside the
    # JS bundle and is public by construction. It lives here so injection is
    # uniform across the three services; do not read its presence as evidence
    # that DSNs need protecting.
    sentry = {
      description = "Sentry EU error-tracking DSNs, one per app (Kickoff 4.9, D24)"
      values = {
        dsn_api     = "PLACEHOLDER_SENTRY_DSN_API"
        dsn_web     = "PLACEHOLDER_SENTRY_DSN_WEB"
        dsn_workers = "PLACEHOLDER_SENTRY_DSN_WORKERS"
      }
    }

    # Not here, so nobody wonders: the Unleash client SDK token is absent
    # because the self-hosted server is not built in this environment
    # (main.tf). Add a group when the server exists, not before — an empty
    # secret costs $0.40/month to mean nothing.
  }
}

resource "aws_secretsmanager_secret" "app" {
  for_each = local.app_secrets

  name        = "/neoting/${local.env}/${each.key}"
  description = each.value.description
  kms_key_id  = aws_kms_key.secrets.arn

  # ⚠ 30 DAYS, NOT STAGING'S 7. A deleted secret's NAME stays reserved for the
  # whole recovery window, which is an obstruction in staging (rebuilt often)
  # and a FEATURE here: deleting a production credential should be undoable for
  # a month, and recreating one under the same name within that month should
  # fail loudly rather than quietly succeed against a different secret.
  recovery_window_in_days = 30

  # D30: no `replica` block, ever. Secrets Manager replication is one line and
  # it would copy UK platform credentials into another region. ⚠ Note that this
  # is NOT relaxed by the ADR 0007 eu-west-1 carve-out — that carve-out covers
  # S3 and KMS for backup and replication, and policies/region-guardrail.json
  # denies `secretsmanager:*` in the DR region outright.
  tags = {
    DataClass = "credential"
    Component = "secrets"
    Rotation  = "manual-365d" # see the ROTATION banner below
  }
}

resource "aws_secretsmanager_secret_version" "app" {
  for_each = local.app_secrets

  secret_id     = aws_secretsmanager_secret.app[each.key].id
  secret_string = jsonencode(each.value.values)

  # THE IMPORTANT PART OF THIS FILE.
  #
  # Terraform writes the placeholder ONCE, at creation. After that it never
  # looks at the value again. Without this block, the first `terraform apply`
  # following an out-of-band credential update would notice the drift and
  # helpfully overwrite the live Twilio token with the string
  # "PLACEHOLDER_TWILIO_AUTH_TOKEN" — production SMS stops, and the plan that
  # did it reads as a harmless no-op change to a value nobody can see.
  #
  # It also keeps real credentials out of Terraform state and out of plan
  # output, which is the actual §11.5 requirement: state lives in S3 where more
  # principals can read it than can read this KMS key.
  #
  # Consequence to know about: this attribute is ignored WHOLESALE. Adding a
  # key to a group in `local.app_secrets` will not push that key to AWS. Update
  # the live secret directly (put-secret-value with the full JSON). Never
  # delete the secret to force a rewrite — see the 30-day name reservation
  # above, which in prod means the name is unusable for a month.
  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ==========================================================================
# ROTATION — Governance §11.5: "rotation on personnel change and at most every
# 12 months". Being honest about what AWS can and cannot do matters more than
# looking compliant:
#
#   * RDS master password — genuinely AWS-managed and hands-off
#     (`manage_master_user_password`). The only secret in this environment with
#     real automated rotation.
#   * Everything in THIS file — not rotatable by AWS. Secrets Manager's managed
#     rotation ships Lambda templates for RDS / DocumentDB / Redshift
#     credentials and nothing else. Rotating a Twilio auth token or a Xero
#     client secret means signing in to that vendor; Companies House and HMRC
#     expose no rotation API at all, so a custom Lambda could not do it either.
#     Nine bespoke credential-handling Lambdas would add more attack surface
#     than the automation removes at this scale.
#   * Redis auth token — rotatable, but through an ElastiCache two-token apply,
#     not through Secrets Manager. Not automated today.
#
# So the control is a dated calendar item, not automation, and the
# `Rotation = "manual-365d"` tag is what makes that auditable: a Config or
# resource-groups query can list every secret whose rotation is a human
# promise, which is the only way the promise gets checked. Deliberately NOT a
# date in the tag — a stale date reads as evidence and is worse than none.
#
# ⚠ TWO APPLICATION-LEVEL TRAPS BEFORE ANYONE ROTATES THE `auth` GROUP IN
# PRODUCTION:
#   * Rotating session_secret invalidates every live session. In staging that
#     is nothing. Here it logs every user out — including one mid-approval,
#     which is the one moment of the product where losing state costs trust.
#     It needs a dual-key verify window before it is safe to do at all.
#   * Rotating otp_pepper invalidates every stored OTP hash, and there is no
#     dual-pepper read path in the application. A pepper rotation is a CODE
#     change, not a console change. Check before you rotate.
# ==========================================================================

# --------------------------------------------------------------------------
# The read grant.
#
# A SECOND inline policy on the execution role, not an edit to
# `read-injected-secrets` in compute.tf: inline policies union, so the effect
# is identical, and keeping the grant in the same file as the secrets means a
# secret can never be deleted while an orphaned grant to its ARN survives in
# someone else's file.
#
# Execution role only. The task role deliberately gets nothing here:
# credentials arrive as injected environment variables at task start (Gov
# §11.5), so the running application never needs to call Secrets Manager for
# them. If a future feature genuinely needs a runtime read, grant that ONE
# secret explicitly — do not copy this policy across.
# --------------------------------------------------------------------------
resource "aws_iam_role_policy" "ecs_execution_app_secrets" {
  name = "read-application-secrets"
  role = aws_iam_role.ecs_execution.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadApplicationSecrets"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        # Resolved ARNs, not a "/neoting/prod/*" wildcard: Secrets Manager
        # appends a random 6-character suffix to every secret ARN, so a
        # hand-written ARN is unusable and a wildcard broad enough to cover the
        # suffix is also broad enough to cover every future secret in the path,
        # including ones this role should never read.
        Resource = [for s in aws_secretsmanager_secret.app : s.arn]
      },
      {
        Sid      = "DecryptApplicationSecrets"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.secrets.arn
        Condition = {
          # The agent may only use this key THROUGH Secrets Manager. A
          # compromised execution role therefore cannot decrypt anything else
          # encrypted under it — the grant is shaped like the one job it has.
          StringEquals = { "kms:ViaService" = "secretsmanager.${local.region}.amazonaws.com" }
        }
      }
    ]
  })
}

output "secrets_kms_key_arn" { value = aws_kms_key.secrets.arn }

output "app_secret_arns" {
  value       = { for k, s in aws_secretsmanager_secret.app : k => s.arn }
  description = "Vendor group -> secret ARN. All hold PLACEHOLDERS until a human writes the live values with put-secret-value."
}
