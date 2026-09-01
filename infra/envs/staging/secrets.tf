# --------------------------------------------------------------------------
# Secrets Manager — the platform credentials the application needs at boot
# (runbook Step 6.6, Governance §11.5).
#
# `.env.example` is the boot contract: the app parses it with Zod and fails
# fast on anything missing or malformed. Every third-party value in that file
# has to exist HERE for a deployed task, because §11.5 forbids plaintext
# `environment` values in a task definition — secrets are injected from
# Secrets Manager or they are not present at all. Two of them already exist
# and are deliberately not duplicated: the Redis connection (data.tf) and the
# RDS master password (AWS-generated, data.tf).
#
# SCOPE — read this before adding anything. Runbook §6.6 draws a hard line:
# Secrets Manager holds PLATFORM credentials (our Xero app's client secret,
# our Twilio account), while PER-TENANT OAuth tokens live encrypted in the
# database vault table (SoT §18). A client's Xero refresh token must never be
# written here. There is one Xero app and eventually thousands of connections;
# a per-tenant secret would be both a $0.40/tenant/month bill and a tenancy
# boundary enforced by IAM instead of by RLS, which is exactly the inversion
# Governance §5.2 exists to prevent.
#
# COST (runbook Appendix B.2, the "$20 — S3 + KMS + Secrets Manager" line):
# Secrets Manager bills per SECRET, not per value — $0.40/secret/month plus
# $0.05 per 10k API calls. The 20 values below, grouped into 9 vendor secrets,
# cost ~$3.60/mo; one secret per value would be ~$8.00/mo for identical data.
# API calls round to nothing: the ECS agent reads each secret once per task
# start, not once per request.
#
# Injection into task definitions is NOT done here — that is the compute lane.
# This file creates the secrets and the read grant, nothing more.
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# KMS — the second of the four CMKs runbook §6.2 requires
# (docs · rds · secrets · logs; only `docs` existed before this file).
#
# A dedicated key, rather than reusing alias/nt-staging-docs, is what makes
# "who can read a credential" a different question from "who can read a
# client's receipt". Both answers are currently `role/nt-*`, but they will
# diverge — the document key has to be usable by SES and by every worker,
# while this key only ever needs to be usable by the ECS agent at task start.
# Sharing one key would make that narrowing impossible later without a
# re-encryption exercise.
#
# COST: $1/month per CMK plus $0.03/10k requests. Requests here are per task
# start, so the $1 is the whole bill.
# --------------------------------------------------------------------------
resource "aws_kms_key" "secrets" {
  description              = "Neoting staging - Secrets Manager platform credentials (D30 eu-west-2)"
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"

  # Annual rotation of the key material. This is the only part of Governance
  # §11.5's "at most every 12 months" that AWS can honour automatically here —
  # see the ROTATION banner below for why the secret VALUES cannot be.
  enable_key_rotation = true

  # 30 days, the maximum, and not a number to trim. Deleting this key does not
  # delete the secrets — it makes every one of them permanently unreadable,
  # with no restore path at all, because the ciphertext without the key is just
  # bytes. The window is the only undo that exists.
  deletion_window_in_days = 30

  # Same shape as ../../modules/storage/policies/kms-docs.json.tftpl: root
  # administers, principals
  # matching role/nt-* (plus the one named human) may use it, everyone else is
  # explicitly denied. The SES allow and the AWS-service exemption from the
  # docs policy are BOTH dropped here on purpose — SES encrypts inbound mail
  # under its own service principal, but nothing encrypts a secret on its own
  # behalf. Secrets Manager calls KMS with the CALLER's credentials
  # (aws:PrincipalArn is the assuming role's ARN, not an STS session ARN), so
  # role/nt-* covers the real path and the deny can stay absolute.
  policy = module.iam_policies.kms_secrets_policy

  tags = { DataClass = "credential" }
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/nt-${local.env}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

# ⚠ OPERATOR TRAP, and it will look like a Secrets Manager bug: the deny above
# matches on aws:PrincipalArn, and an AWS Identity Center session
# (role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_*) matches neither
# role/nt-* nor user/Mubashir. Reading or setting a value in the console from
# an SSO session therefore fails at the KMS layer with AccessDenied while the
# secret itself is perfectly readable. If SSO becomes the normal human path
# (runbook Step 1.4), add the SSO role ARN pattern to kms-secrets.json.tftpl in
# the same change — do not "fix" it by widening the grant to the account root.

# --------------------------------------------------------------------------
# The secrets themselves.
#
# One secret per VENDOR, holding a JSON object, because that is the unit a
# credential actually rotates in: a Twilio account SID and its auth token are
# replaced together and are useless apart. The JSON keys map to the
# `.env.example` variable names listed against each group, which is what lets
# the compute lane write a task-definition `secrets` entry of the form
# `<secret-arn>:<json-key>::` per environment variable.
#
# Values are PLACEHOLDERS and stay placeholders. Real values are set out of
# band (console, or `aws secretsmanager put-secret-value --secret-id ...
# --secret-string file://tmp.json` — file://, never an inline --secret-string,
# which lands the credential in shell history and in the CloudTrail request
# only by the operator's good luck; delete the file afterwards).
#
# The placeholder strings deliberately name their own variable
# ("PLACEHOLDER_TWILIO_AUTH_TOKEN"): if one ever surfaces in a log, an error
# report or a vendor's 401, it is instantly greppable and instantly obviously
# fake. A realistic-looking dummy would not be.
# --------------------------------------------------------------------------

locals {
  # NOTE: adding a KEY to a group here does NOT reach AWS after the first
  # apply — `ignore_changes = [secret_string]` covers the whole attribute, not
  # per-key. This map is the documented SHAPE of each secret; after first
  # apply, delivery of any new key is a put-secret-value away. That trade is
  # deliberate and explained on the version resource below.
  app_secrets = {
    # SESSION_SECRET, OTP_PEPPER. Generate with `openssl rand -hex 32`, per
    # the instruction already in .env.example.
    #
    # Not generated with random_password (as data.tf does for the Redis auth
    # token) on purpose: a session secret in Terraform state is a session
    # secret that every plan diff and every state reader can see, and it can
    # then only be rotated by an apply — which is the wrong blast radius for a
    # value that logs every user out when it changes.
    #
    # METH Stage 15 added the two portal keys. They are HMAC keys of exactly
    # the same class as session_secret — app-generated, no vendor, no rotation
    # ceremony — so they belong in this group rather than in one of their own:
    # the unit a credential rotates in is "our signing keys", and rotating them
    # together is the honest ceremony.
    #
    # ⚠ ADDING THEM HERE DID NOT DELIVER THEM. `ignore_changes = [secret_string]`
    # on the version resource below covers the whole attribute, so this map is
    # the documented SHAPE and nothing more. All four values are set out of band
    # with a single put-secret-value writing the full JSON — partial writes
    # DELETE the omitted keys, and a task definition naming a key the secret does
    # not hold fails at task start with ResourceInitializationError.
    auth = {
      description = "App HMAC signing keys - session cookie, portal link, portal bearer - and the OTP pepper"
      values = {
        session_secret        = "PLACEHOLDER_SESSION_SECRET"
        otp_pepper            = "PLACEHOLDER_OTP_PEPPER"
        portal_link_secret    = "PLACEHOLDER_PORTAL_LINK_SECRET"
        portal_session_secret = "PLACEHOLDER_PORTAL_SESSION_SECRET"
      }
    }

    # TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID,
    # TWILIO_MESSAGING_SERVICE_SID. Sole SMS + OTP provider (SoT §"Third-party
    # rails"). Staging holds SANDBOX credentials only (Guideline §8.4) — a
    # production Twilio token here would let a staging bug text real clients.
    twilio = {
      description = "Twilio platform credentials - SMS chase + Verify OTP (sandbox keys in staging)"
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
    # the check-VAT-number API (SoT §"Third-party rails").
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
      description = "Meta WhatsApp Business Platform - webhook verify token, app secret (HMAC, Gov §11.7), media access token (Graph bearer)"
      values = {
        verify_token = "PLACEHOLDER_WHATSAPP_VERIFY_TOKEN"
        app_secret   = "PLACEHOLDER_WHATSAPP_APP_SECRET"
        # The Graph API bearer the WORKER fetches media bytes with — a SYSTEM
        # USER token holding `whatsapp_business_messaging` (durable), never the
        # 24-hour dashboard token (docs/runbooks/whatsapp-sandbox.md). A third
        # credential on purpose: the app secret verifies inbound HMAC, the
        # verify token answers the handshake, and NEITHER authenticates a Graph
        # call. While this is a placeholder, MEDIA_FETCH stays `fixture` in
        # services.tf — env.ts refuses `graph` with an empty token at boot.
        media_access_token = "PLACEHOLDER_WHATSAPP_MEDIA_ACCESS_TOKEN"
      }
    }

    # STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET. D48's subscription rail, and the
    # ONLY vendor in this map that takes money. Staging points at a Stripe
    # SANDBOX (Guideline §8.4): the objects are real, the Checkout page is real,
    # the webhook is real, and no card can be charged.
    #
    # ⚠ The webhook secret is not an optional half of this pair. Without it every
    # Stripe event 401s at the signature guard, no subscription ever reaches
    # ACTIVE, and the client sees a successful payment followed by an app that
    # still refuses their uploads — which reads as "the card was declined".
    # `config/env.ts` refuses to boot on `BILLING=stripe` with either missing,
    # so the failure is a task that will not start rather than a lie on screen.
    #
    # The price id and the tax rate id are NOT here. They identify objects, they
    # grant nothing, and an id in Secrets Manager is an id that cannot be read in
    # a plan — so they sit in `services.tf` where an operator can see them.
    stripe = {
      description = "Stripe API key and webhook signing secret - client subscriptions (D48; sandbox keys in staging)"
      values = {
        secret_key     = "PLACEHOLDER_STRIPE_SECRET_KEY"
        webhook_secret = "PLACEHOLDER_STRIPE_WEBHOOK_SECRET"
      }
    }

    # Sentry EU, one DSN per app (Kickoff 4.9, D24). Not in .env.example yet
    # because Sentry is Slice C / Infra Week work (Guideline G1) — the secret
    # exists now so that landing Sentry is a value change, not an infra
    # change, which is the G8 test.
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

    # Not here yet, so nobody wonders: the Unleash client SDK token (runbook
    # §6.7) is absent because FLAGS_MODE=file until the self-hosted server
    # lands in Infra Week. Add a group when the server exists, not before — an
    # empty secret costs $0.40/month to mean nothing.
  }
}

resource "aws_secretsmanager_secret" "app" {
  for_each = local.app_secrets

  # Runbook §0.2 writes the path as /neoting/<env>/<service>/<name>. A
  # per-vendor JSON blob has exactly one name per service, so a fourth segment
  # would be the same constant on all nine. The existing
  # /neoting/staging/redis/connection keeps its fourth segment because Redis
  # will plausibly grow a second secret; these will not.
  name        = "/neoting/${local.env}/${each.key}"
  description = each.value.description
  kms_key_id  = aws_kms_key.secrets.arn

  # 7 days, not the 30-day default. Staging is disposable by design (G1), and
  # a destroyed secret's NAME stays reserved for the whole recovery window —
  # so a 30-day window turns "rebuild staging this week" into
  # "InvalidRequestException: a secret with this name is already scheduled for
  # deletion". 7 is the shortest window that still leaves a real undo;
  # `0` would delete immediately and irreversibly, and convenience is not
  # worth losing the only recovery path for a credential set.
  recovery_window_in_days = 7

  # D30: no `replica` block, ever. Secrets Manager replication is one line and
  # it would copy UK platform credentials into another region.

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
  # helpfully overwrite the real Twilio token with the string
  # "PLACEHOLDER_TWILIO_AUTH_TOKEN" — production SMS stops, and the plan that
  # did it reads as a harmless no-op change to a value nobody can see.
  #
  # It also keeps real credentials out of Terraform state and out of plan
  # output, which is the actual §11.5 requirement: state lives in S3 where
  # more principals can read it than can read this KMS key.
  #
  # Consequence to know about: this attribute is ignored WHOLESALE. Adding a
  # key to a group in `local.app_secrets` will not push that key to AWS.
  # Update the live secret directly (put-secret-value with the full JSON), or
  # for a group that is still all-placeholder, `terraform apply -replace` this
  # version. Never delete the secret to force a rewrite — see the 7-day name
  # reservation above.
  lifecycle {
    ignore_changes = [secret_string]
  }
}

# --------------------------------------------------------------------------
# ROTATION — Governance §11.5: "rotation on personnel change and at most every
# 12 months". Being honest about what AWS can and cannot do here matters more
# than looking compliant:
#
#   * RDS master password — genuinely AWS-managed and hands-off
#     (`manage_master_user_password` in data.tf). That is the only secret in
#     this environment with real automated rotation.
#   * Everything in THIS file — not rotatable by AWS. Secrets Manager's
#     managed rotation ships Lambda templates for RDS / DocumentDB / Redshift
#     credentials and nothing else. Rotating a Twilio auth token or a Xero
#     client secret means signing in to that vendor; Companies House and HMRC
#     expose no rotation API at all, so a custom Lambda could not do it
#     either. Nine bespoke credential-handling Lambdas would add more attack
#     surface than the automation removes at this scale.
#   * Redis auth token — rotatable, but through an ElastiCache two-token
#     apply, not through Secrets Manager. Also not automated today.
#
# So the control is a dated calendar item, not automation, and the
# `Rotation = "manual-365d"` tag is what makes that auditable: a Config or
# resource-groups query can list every secret whose rotation is a human
# promise, which is the only way the promise gets checked. Deliberately NOT a
# date in the tag — a stale date reads as evidence and is worse than none.
#
# Two application-level traps before anyone rotates the `auth` group:
#   * Rotating session_secret invalidates every live session. Fine in staging;
#     in prod it needs a dual-key verify window or every user is logged out
#     mid-approval.
#   * Rotating otp_pepper invalidates every stored OTP hash. There is no
#     dual-pepper read path in the application — as of 13 Aug 2026 there is no
#     env module at all, .env.example is the whole contract — so a pepper
#     rotation is a code change, not a console change. Check before you rotate.
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# The read grant.
#
# A SECOND inline policy on the execution role, not an edit to
# `read-injected-secrets` in compute.tf: inline policies union, so the effect
# is identical, and keeping the grant in the same file as the secrets means a
# secret can never be deleted while an orphaned grant to its ARN survives in
# someone else's file. The compute lane owns the Redis and RDS grants; this
# lane owns these nine.
#
# Execution role only. The task role (aws_iam_role.app) deliberately gets
# nothing here: credentials arrive as injected environment variables at task
# start (runbook §6.5, Gov §11.5), so the running application never needs to
# call Secrets Manager for them. If a future feature genuinely needs a runtime
# read, grant that one secret explicitly — do not copy this policy across.
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
        # Resolved ARNs, not a "/neoting/staging/*" wildcard: Secrets Manager
        # appends a random 6-character suffix to every secret ARN, so a
        # hand-written ARN is unusable and a wildcard broad enough to cover
        # the suffix is also broad enough to cover every future secret in the
        # path, including ones this role should never read.
        Resource = concat(
          [for s in aws_secretsmanager_secret.app : s.arn],
          [aws_secretsmanager_secret.upload_url.arn],
        )
      },
      {
        Sid      = "DecryptApplicationSecrets"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = aws_kms_key.secrets.arn
        Condition = {
          # The agent may only use this key THROUGH Secrets Manager. A
          # compromised execution role therefore cannot decrypt anything else
          # that happens to be encrypted under it — the grant is shaped like
          # the one job it has.
          StringEquals = { "kms:ViaService" = "secretsmanager.${local.region}.amazonaws.com" }
        }
      }
    ]
  })
}

# --------------------------------------------------------------------------
# The upload-intent signing key — the value env.ts refuses to boot without
# under NODE_ENV=production (#76, #92).
#
# NOT a vendor group above, and NOT a placeholder, for one load-bearing
# reason each:
#   * No vendor issues it. It is an app-generated HMAC key with no rotation
#     ceremony at any third party, so the "one secret per vendor" unit does
#     not apply.
#   * A placeholder here would PASS the boot gate — Zod only checks non-empty
#     — and every upload intent would then be signed with a guessable string.
#     A forgeable signature is strictly worse than a refused boot, so the
#     value must be real from the first apply.
#
# random_password (the data.tf Redis pattern) rather than out-of-band
# put-secret-value: yes, the value lands in Terraform state, but state lives
# in the guarded bucket, and the blast radius of rotating this key is 15
# minutes of in-flight upload links (UPLOAD_URL_TTL_SECONDS) — nothing like
# the session_secret's log-everyone-out, which is why THAT one stays
# placeholder-and-hand-set. Rotate with `terraform apply -replace`.
# --------------------------------------------------------------------------
resource "random_password" "upload_url" {
  length  = 64
  special = false # HMAC key material; alphanumeric keeps it inert in URLs and logs
}

resource "aws_secretsmanager_secret" "upload_url" {
  name        = "/neoting/${local.env}/upload-url"
  description = "HMAC signing key for stateless web-upload intents (#76) - app-generated, Terraform-owned"
  kms_key_id  = aws_kms_key.secrets.arn

  recovery_window_in_days = 7 # same reasoning as the vendor groups above

  tags = {
    DataClass = "credential"
    Component = "secrets"
    Rotation  = "terraform-replace" # `apply -replace=random_password.upload_url`
  }
}

resource "aws_secretsmanager_secret_version" "upload_url" {
  secret_id     = aws_secretsmanager_secret.upload_url.id
  secret_string = jsonencode({ secret = random_password.upload_url.result })

  # NO ignore_changes, unlike the vendor groups: Terraform legitimately owns
  # this value, so drift here is corruption to fix, not a live credential to
  # protect.
}

# --------------------------------------------------------------------------
# FOLLOW-UP for whoever owns data.tf (not changed here — this lane does not
# edit another file): module.data's Redis connection secret and the RDS-managed
# master secret still encrypt under the AWS-managed `aws/secretsmanager` key
# rather than this CMK, which means the explicit deny above does not protect
# them. For Redis that is a one-line `kms_key_id` addition; for the RDS
# managed secret it is `master_user_secret_kms_key_id`, and changing it
# re-encrypts rather than rotates.
# --------------------------------------------------------------------------

output "secrets_kms_key_arn" { value = aws_kms_key.secrets.arn }

output "app_secret_arns" {
  value       = { for k, s in aws_secretsmanager_secret.app : k => s.arn }
  description = "Vendor group -> secret ARN. The compute lane builds task-definition secrets entries as <arn>:<json-key>::"
}
