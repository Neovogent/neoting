# --------------------------------------------------------------------------
# Task definitions and services — the "S4" half of compute.tf (runbook §6.4).
#
# api     — HTTP, behind the ALB target group in alb.tf.
# workers — BullMQ consumers. A SEPARATE service on purpose (§6.4): queue depth
#           and HTTP request rate are unrelated signals, and a worker that
#           pins a CPU chewing a 300-page statement must never be able to
#           starve the request path.
# web     — NOT here. Vercel covers apps/web for the sprint (G6/§6.4); the ECR
#           repo and the /nt/staging/web log group in compute.tf sit unused
#           until Infra Week, which costs nothing and saves a migration later.
# --------------------------------------------------------------------------

locals {
  # No image exists in ECR yet. This tag is a placeholder: the services below
  # run at desired_count = 0, and CI registers a new revision pinned to the
  # git SHA (ECR tags are IMMUTABLE — compute.tf — so a tag can never move
  # under a running task). Terraform never sees that revision because
  # task_definition is in ignore_changes on both services.
  image_tag = "bootstrap"

  # COST DECISION (Appendix B.2 budgets Fargate at $30–40/mo for this shape).
  # Sized down from the runbook's 0.5 vCPU api because a Node process serving
  # staging smoke traffic is memory-bound, not CPU-bound; 0.25 vCPU is the
  # smallest Fargate step and burst is handled by the second task.
  #
  # Per task, at eu-west-2 ARM64 rates ($0.03725/vCPU-hr, $0.00409/GB-hr):
  #   api      0.25 vCPU + 1 GB  ≈ $0.0134/hr ≈ $9.80/mo  × 2 tasks
  #   workers  0.5  vCPU + 1 GB  ≈ $0.0227/hr ≈ $16.60/mo × 1 task (Spot: ~$5)
  # Plus ~$3.60/mo of public IPv4 per task — see the assign_public_ip note on
  # the services. Valid Fargate cpu/memory pairs are fixed; 256 CPU accepts
  # only 512/1024/2048 MB.
  task_size = {
    api     = { cpu = 256, memory = 1024 }
    workers = { cpu = 512, memory = 1024 }
  }

  # Non-secret runtime coordinates. Endpoints and bucket names are not
  # credentials — putting them in `environment` keeps them greppable in the
  # console and keeps the Secrets Manager GetSecretValue call at task start to
  # exactly two requests.
  common_environment = [
    # NODE_ENV=production because staging runs the production build (G1
    # parity). The environment's identity travels separately, so nothing keys
    # behaviour off NODE_ENV and accidentally behaves differently in prod.
    { name = "NODE_ENV", value = "production" },
    { name = "NEOTING_ENV", value = local.env },
    { name = "AWS_REGION", value = local.region },

    # Storage is UTC, full stop (CLAUDE.md invariant, Gov §12). Europe/London
    # is applied at render time by the app — never by the container clock, or
    # a BST-vs-GMT boundary silently rewrites every timestamp for an hour.
    { name = "TZ", value = "UTC" },

    { name = "DATABASE_HOST", value = module.data.db_address },
    { name = "DATABASE_PORT", value = "5432" },
    { name = "DATABASE_NAME", value = module.data.db_name },

    { name = "REDIS_HOST", value = module.data.redis_primary_endpoint_address },
    { name = "REDIS_PORT", value = "6379" },
    { name = "REDIS_TLS", value = "true" }, # transit encryption is on (data.tf); a non-TLS client just hangs

    # S3_BUCKET_DOCUMENTS is the name env.ts actually reads
    # (select-document-store.ts). This line said S3_BUCKET_DOCS until the
    # OBJECT_STORE flip below made the mismatch live: with the wrong name the
    # store would have silently defaulted to `nt-local-docs` — a bucket that
    # does not exist in AWS — and every persist would have 403'd at runtime.
    { name = "S3_BUCKET_DOCUMENTS", value = local.bucket_names["docs"] },
    { name = "S3_BUCKET_RECEIPTS", value = local.bucket_names["receipts"] },
    { name = "S3_BUCKET_EXPORTS", value = local.bucket_names["exports"] },
    { name = "KMS_KEY_ARN", value = module.storage.kms_key_arn },

    # ⚠ REQUIRED FOR BOOT since #84: env.ts refuses AUTH_MODE=fixture (the
    # default) under NODE_ENV=production, because the fixture resolver trusts
    # X-NT-* headers for identity — through CloudFront, that would be an auth
    # bypass. Every deploy from #90 to #107 failed on exactly this and was
    # silently rolled back by the circuit breaker. `session` is the resolver
    # S1 implements; until then scoped endpoints answer 401/500 rather than
    # trusting a header, which is the honest state for a reachable surface.
    { name = "AUTH_MODE", value = "session" },

    # ------------------------------------------------------------------------
    # The ingest lane, made real. Until these three, a WhatsApp message to the
    # deployed api was signature-verified and then enqueued IN MEMORY, where
    # the workers service could not see it — stage 9's own summary said so on
    # every run. Each switch is config-selected in the app (#12, #16, #23);
    # the code paths and their tests landed with those issues.
    #
    #   INGEST_QUEUE=bullmq    api enqueues to Redis (REDIS_* + auth token are
    #                          already injected); the worker has always
    #                          consumed the `ingest` queue — the api's default
    #                          was the break.
    #   OBJECT_STORE=s3        sanitised bytes persist to the docs bucket under
    #                          `w/<businessId>/…` — exactly the prefix the task
    #                          role's DocumentObjectsWorkspacePrefixOnly
    #                          statement (compute.tf) allows.
    #   IMAGE_NORMALISER=sharp the real EXIF/HEIC path. Safe: sharp ships in
    #                          the image (prebuilt @img/sharp-linux-arm64; the
    #                          worker already constructs the sharp perceptual
    #                          hasher unconditionally at boot).
    #
    #   DOCUMENT_GUARD=qpdf    the real PDF guard, added by S1 along with the
    #                          qpdf binary in apps/api/Dockerfile. The fixture
    #                          greps 8 KB for /Encrypt and reports CLEAN on an
    #                          incrementally-updated encrypted PDF — most signed
    #                          or form-filled accounting paperwork — so on a
    #                          launch target it is a password check that passes
    #                          files the pipeline then cannot read. env.ts now
    #                          refuses `fixture` under NODE_ENV=production.
    #
    # NOT flipped, deliberately:
    #   EMAIL_SOURCE stays `fixture` — the s3 poller is a separate process
    #     (worker/email-intake-main.ts) with no ECS service yet, and env.ts
    #     refuses EMAIL_SOURCE=s3 combined with fixture stores anyway.
    # ------------------------------------------------------------------------
    # The role the APPLICATION connects as — a name, not a credential, so it is
    # a plain value. Its password is injected separately (see the secrets list).
    # Stated rather than defaulted in code so that "which role is this task
    # subject to RLS as?" is answerable from the deployed artefact.
    { name = "DB_APP_USER", value = "nt_app" },

    { name = "INGEST_QUEUE", value = "bullmq" },
    { name = "OBJECT_STORE", value = "s3" },
    { name = "IMAGE_NORMALISER", value = "sharp" },
    { name = "DOCUMENT_GUARD", value = "qpdf" },

    # ------------------------------------------------------------------------
    # The adapters that used to be demo stand-ins (METH_MODE.md §4, Stage 15),
    # and the two that S1 stopped allowing to be.
    #
    # Stating them was always the point: a deployed task definition is the
    # artefact an operator reads to answer "what does this environment actually
    # do when it reads an invoice?", and "nothing is set, so read the Zod
    # schema" is a worse answer than four lines. Two of the four are now load-
    # bearing for BOOT rather than merely informative, exactly like AUTH_MODE
    # and AI_CHAT above — omit either and the task exits 1 on env validation.
    #
    #   EXTRACTOR=bedrock    Claude reads the document. `demo` is REFUSED under
    #                        NODE_ENV=production by config/env.ts (S1), because
    #                        DemoExtractor does not degrade the read — it
    #                        INVENTS it, deriving supplier, date, total, tax and
    #                        a VAT number from a hash of the filename at 0.8
    #                        confidence, which resolveProcessedState reads as
    #                        Ready. Staging is the launch target (docs/launch/
    #                        PLAN.md), so a real client's document would have
    #                        landed in a real accountant's queue with a
    #                        fabricated supplier on it.
    #
    #                        A4 (merged) added the PDF `document` block and the
    #                        downscale, so a PDF invoice and a 48MP phone photo
    #                        both read here now — the NT-EXT-003 / NT-EXT-007
    #                        gap this comment used to describe is closed.
    #                        select-extractor.ts still has NO FALLBACK by
    #                        design: a read we cannot make is a loud, retryable
    #                        FAILED document, never a quiet invented one.
    #
    #                        ⚠ S5 CLOSED THE TWO THINGS THE FLIP LEFT OPEN.
    #                        Extraction is now metered against
    #                        AI_DAILY_BUDGET_PENCE below (it was not, and that
    #                        was unbounded spend on this environment), and a
    #                        throw from Bedrock now lands the document FAILED
    #                        with a reason on the job's last attempt instead of
    #                        stranding it in PROCESSING for ever. Measured at
    #                        1.3p/document against the £0.02 guardrail —
    #                        `pnpm tsx scripts/measure/extraction-cost.ts`.
    #
    #   OTP_MODE=totp        the real RFC 6238 verifier. `demo` accepts ONE
    #                        fixed six-digit code on every account in every
    #                        practice and on every portal session, and it is
    #                        published in the source and the seed — a universal
    #                        second factor is a longer password field, not a
    #                        second factor. REFUSED in production by env.ts (S1).
    #
    #                        ⚠ NOBODY CAN SIGN IN TO STAGING UNTIL A2 MERGES.
    #                        auth.service.ts:verifyTotp and portal-session.
    #                        service.ts:verifyOtp both read
    #                        `mode === 'demo' && code === <fixed>`, so `totp`
    #                        makes every second factor return false. That is
    #                        fail-CLOSED and it is the intended intermediate
    #                        state: A2 lands otplib enrolment, verify and
    #                        recovery codes behind this same switch.
    #
    #   SMS_SENDER=demo      writes outbox rows. NOTHING LEAVES THE ACCOUNT —
    #                        this is the variable that stands between a staging
    #                        chase and a real text message to a real phone. SMS
    #                        is cut for Initial Delivery (D40/§24), so this one
    #                        is not on anybody's path to a real vendor.
    #   LEDGER_ADAPTER=demo  DemoXeroAdapter, fake refs. No client's books are
    #                        reachable from this environment — and under D42
    #                        there is no ledger API in Initial Delivery at all,
    #                        so this stays `demo` on purpose rather than by
    #                        omission. Export is the only egress.
    #   BILLING=stripe       ⚠ REAL STRIPE, AGAINST A SANDBOX ACCOUNT. Flipped
    #                        28 Aug 2026 (see the STRIPE block below). It was
    #                        `demo` — DemoStripeClient, hosted-session URLs on
    #                        the reserved `.invalid` TLD — which proved a
    #                        checkout link could not reach a payment page, and
    #                        also meant the subscribe step of the client's own
    #                        onboarding could never complete. `subscription_status`
    #                        is written ONLY by the Stripe webhook, so on `demo`
    #                        it stayed null, `mayIngest(null)` was false, and
    #                        every upload 402'd: the walkthrough died at the step
    #                        after sign-in.
    #
    #                        NO CARD CAN STILL BE CHARGED FROM HERE, and the
    #                        guarantee moved rather than went away — it is now
    #                        the ACCOUNT, not the adapter. The key below is a
    #                        sandbox key (Guideline §8.4, G2): Checkout, the
    #                        webhook and the subscription lifecycle are all real,
    #                        and `4242 4242 4242 4242` is the only card that
    #                        works. Live mode is a different account and is
    #                        blocked on company verification and the UK VAT
    #                        registration number (runbook §0, §1).
    #
    #                        ⚠ Entitlement is NOT affected by this value. It is
    #                        read from `businesses.subscription_status` in the
    #                        service layer whichever client is wired, so staging
    #                        still refuses uploads for an unsubscribed business
    #                        — what changed is that a client can now DO something
    #                        about it.
    # ------------------------------------------------------------------------
    { name = "EXTRACTOR", value = "bedrock" },

    # ------------------------------------------------------------------------
    # STATEMENT_READER=textract — how a PDF or photographed bank statement
    # becomes a table (D20, D41). CSV and XLSX are read deterministically and
    # need nothing here; this is the rung for everything else.
    #
    # The IAM grant it needs is ALREADY in compute.tf's "Extraction" statement
    # (AnalyzeDocument, StartDocumentAnalysis, GetDocumentAnalysis) — that
    # statement predates this flip by weeks and was the D20 grant nothing had
    # ever used.
    #
    # ⚠ `none` is not a weaker environment, it is a REFUSAL: a PDF statement is
    # rejected by name with a visible reason rather than silently skipped. It is
    # the local default because Textract's asynchronous path reads from S3 and
    # cannot read MinIO — a developer machine genuinely has no reader for a
    # multi-page PDF, and pretending otherwise is how invented transactions
    # reach someone's books.
    #
    # ⚠ COST. Textract TABLES is ~1.2p/page, so a 29-page statement is ~35p —
    # far above the £0.02 per-DOCUMENT guardrail, which is written for receipts
    # and invoices. A statement is a different unit (one file, a month of a
    # client's banking) and the ID release has no other bank input at all
    # (D40). Watch it per client per month rather than per document.
    # ------------------------------------------------------------------------
    { name = "STATEMENT_READER", value = "textract" },

    { name = "SMS_SENDER", value = "demo" },
    { name = "OTP_MODE", value = "totp" },
    { name = "LEDGER_ADAPTER", value = "demo" },
    { name = "BILLING", value = "stripe" },

    # ------------------------------------------------------------------------
    # What `BILLING=stripe` requires. `config/env.ts` REFUSES to boot without
    # every one of these, which is why they are stated here rather than left to
    # a default — a missing one is a task that will not start, never a checkout
    # that quietly charges the wrong thing.
    #
    #   STRIPE_PRICE_ID      The one price (D48): GBP 8.50/month, recurring,
    #                        `tax_behavior=exclusive`. Exclusive is the whole
    #                        VAT decision — the customer is charged 850 PLUS
    #                        VAT. An inclusive price of the same number would
    #                        mean absorbing the VAT out of the 850, which is a
    #                        16.7% cut of every subscription, silently.
    #
    #   STRIPE_TAX=rate      A fixed 20% GB VAT rate, not Stripe Tax's automatic
    #                        calculation. `automatic` needs a tax registration,
    #                        and a registration needs the UK VAT number this
    #                        company does not have yet. `rate` is the honest
    #                        stand-in and the runbook (§3) says when to move.
    #
    #   STRIPE_TAX_RATE_ID   The `txr_…` for that 20%. ⚠ `STRIPE_TAX=rate` with
    #                        no id charges the net price with NO VAT ADDED, so
    #                        env.ts refuses that pairing outright.
    #
    #   BILLING_RETURN_ORIGINS
    #                        The allowlist `successUrl` / `cancelUrl` /
    #                        `returnUrl` are checked against. All three are
    #                        CALLER-SUPPLIED on an authenticated endpoint, so an
    #                        unvalidated one is an open redirect with a session
    #                        attached. BOTH web origins are live and either can
    #                        start a checkout, so both are listed; empty would
    #                        admit no origin and refuse every checkout, which is
    #                        the correct direction to fail.
    #
    # These four are ids and origins, not credentials — they grant nothing on
    # their own. The two things that DO grant something (the API key and the
    # webhook signing secret) are in Secrets Manager, injected below.
    # ------------------------------------------------------------------------
    # ⚠ LIVE-MODE objects as of 28 Aug 2026. The previous pair
    # (price_1U8lIs… / txr_1U8lIu…) were SANDBOX objects, and they are not
    # interchangeable: with a live key, a sandbox price fails as "No such price"
    # at the moment a client presses Subscribe — at checkout, not at boot, so
    # nothing catches it earlier.
    { name = "STRIPE_PRICE_ID", value = "price_1U9R0uGMdHp4NCWv5NFOBvZ9" },
    { name = "STRIPE_TAX", value = "rate" },
    # The 20% GB rate, exclusive: GBP 8.50 is the NET price and VAT goes on top
    # (D48). `env.ts` refuses to boot on `STRIPE_TAX=rate` with this empty,
    # because the net price charged with no VAT added means absorbing the VAT.
    { name = "STRIPE_TAX_RATE_ID", value = "txr_1U9R0wGMdHp4NCWvqUjY3Htg" },
    { name = "BILLING_RETURN_ORIGINS", value = "https://neoacc.neovogent.com,https://app.neoting.neovogent.com" },

    # ------------------------------------------------------------------------
    # The AI workspace (Governance §9), and the one adapter above that is NOT
    # a demo stand-in.
    #
    #   AI_CHAT=bedrock  the real model. `config/env.ts` REFUSES `demo` under
    #                    NODE_ENV=production, so this line is load-bearing for
    #                    boot, not decorative — omit it and the task exits 1
    #                    with the env-validation error, exactly like the
    #                    AUTH_MODE gate above.
    #
    # No credential is injected for it. The task role already carries
    # bedrock:InvokeModel on the four region-pinned foundation-model ARNs
    # (compute.tf) and no inference-profile ARN, which is what makes D30
    # residency enforceable rather than merely stated: a cross-region call
    # returns AccessDenied. The SDK finds the role through the default
    # credential chain.
    #
    # BEDROCK_REGION is stated rather than inherited from AWS_REGION so that
    # "where does client document text get processed" is answerable from the
    # deployed task definition alone.
    # ------------------------------------------------------------------------
    { name = "AI_CHAT", value = "bedrock" },
    { name = "BEDROCK_REGION", value = local.region },

    # £25/day/practice, raised from £5 by S1 along with the code default. This
    # is a HARD STOP, not a warning: the day it bites is a day the practice's
    # documents stop being read, so a demo-scale number is the wrong shape for
    # a launch target. £5 was 250 documents at the £0.02/document guardrail —
    # one month-end afternoon.
    #
    # ⚠ IT IS ONE METER FOR TWO SPENDERS SINCE S5, AND THAT COUPLING IS
    # DELIBERATE. Extraction used to construct AnthropicBedrock directly and
    # consult no budget at all, so flipping EXTRACTOR to `bedrock` above put
    # UNMETERED spend on this environment; it now writes to the same
    # per-practice daily ledger the chat runtime has always used
    # (`common/ai-budget.ts`). §9.7 defines a per-FIRM budget, and a firm asking
    # what it spent on AI today must get ONE number.
    #
    # The consequence, stated rather than discovered: a practice that exhausts
    # the ceiling in chat will see that day's documents land FAILED
    # (NT-EXT-008, retryable), and a document flood will make chat return its
    # budget error. Both refusals are visible and neither invents data.
    #
    # £25 is ~1,900 documents/day at the measured 1.3p, or ~1,250 at the 2p the
    # meter actually charges — `costPence` rounds UP per call, so a ~1.3p read
    # bills 2p. The meter over-states extraction by roughly half at this token
    # scale. That is the safe direction for a ceiling and it is why the headline
    # number is quoted from the per-100 figure, not the per-call one.
    { name = "AI_DAILY_BUDGET_PENCE", value = "2500" },

    # ------------------------------------------------------------------------
    # Outbound email (S2) — the second adapter above that is NOT a demo
    # stand-in, and the FIRST thing in this repository that sends any mail.
    #
    # ⚠ EVERY LINE HERE IS LOAD-BEARING FOR BOOT. `config/env.ts` refuses
    # EMAIL_SENDER=demo under NODE_ENV=production, refuses EMAIL_SENDER=ses
    # without a configuration set, and refuses a real sender behind the
    # per-process rate limiter in production. Omit any of them and the task
    # exits 1 with the env-validation error — the AUTH_MODE / AI_CHAT pattern,
    # deliberately, because a `demo` email sender is the one stand-in whose
    # failure is invisible from every screen: each send returns a message id
    # and no email exists.
    #
    #   EMAIL_SENDER=ses  The infrastructure has been ready since 17 Aug 2026
    #                     (email.tf: production access granted, 50,000/day,
    #                     sandbox exited, DKIM + SPF-aligned MAIL FROM + DMARC
    #                     published). That file's status note listed "no sending
    #                     client exists in the app" as gate one. S2 built it.
    #
    #   EMAIL_FROM_ADDRESS  ⚠ no-reply@, NOT doc@. `doc@` is the inbound
    #                     document intake address and mail arriving there is
    #                     filed as a client document — sending from it would
    #                     ingest every reply as paperwork. The task role's
    #                     `ses:FromAddress` condition (compute.tf) was pinned to
    #                     `doc@` and is widened to this address for the same
    #                     reason; the two must agree or every send is
    #                     AccessDenied.
    #
    #   EMAIL_REPLY_TO_ADDRESS  A different domain on purpose: this domain's MX
    #                     points at SES inbound, whose rule set accepts `doc@`
    #                     and `dmarc@` and nothing else, so a reply to any other
    #                     address ON it would bounce.
    #
    #   EMAIL_CONFIGURATION_SET  Without it a send still succeeds and silently
    #                     opts out of bounce/complaint suppression, reputation
    #                     metrics and the SNS event feed — i.e. we would keep
    #                     mailing addresses that have already bounced, which is
    #                     the fastest route to the 5% suspension the reputation
    #                     alarms in observability.tf watch for.
    #
    #   EMAIL_RATE_LIMIT=redis  The per-address and per-IP ceilings must hold
    #                     ACROSS tasks. `memory` counts per process, and the api
    #                     service runs more than one — the ceilings would be
    #                     multiplied by the task count, silently. No new
    #                     credential: it reuses the REDIS_* parts and the
    #                     REDIS_AUTH_TOKEN secret already injected above.
    # ------------------------------------------------------------------------
    { name = "EMAIL_SENDER", value = "ses" },
    { name = "SES_REGION", value = local.region },
    { name = "EMAIL_FROM_ADDRESS", value = "no-reply@${local.domain}" },
    { name = "EMAIL_REPLY_TO_ADDRESS", value = "support@neovogent.com" },
    { name = "EMAIL_CONFIGURATION_SET", value = aws_sesv2_configuration_set.primary.configuration_set_name },
    { name = "EMAIL_RATE_LIMIT", value = "redis" },
  ]

  # ------------------------------------------------------------------------
  # Secrets — injected by the ECS agent at task start from Secrets Manager,
  # never as plaintext `environment` values (Gov §11.5, runbook §6.4). The
  # `:key::` suffix selects one field out of the secret's JSON, so the app
  # gets the field it needs and nothing else. Format is
  # <arn>:<json-key>:<version-stage>:<version-id>; the trailing colons are
  # required even when empty.
  #
  # ⚠ ONLY the two secrets that exist today are wired. Adding an entry here
  # WITHOUT adding its ARN to `aws_iam_role_policy.ecs_execution_secrets`
  # (compute.tf) makes every task fail at start with
  # ResourceInitializationError — which reads like a broken image and is not.
  #
  # TODO when secrets.tf lands (/neoting/${local.env}/<group>), add:
  #   app        DATABASE_URL for the nt_app role (see below), SESSION_SECRET,
  #              the OTP pepper (Gov §11.8)
  #              — SESSION_SECRET and the two portal keys are DONE (METH Stage
  #                15, below). DATABASE_URL for nt_app and the OTP pepper are
  #                still open: nothing reads a pepper yet (OTP_MODE=demo), and
  #                the app still connects with the migrator's URL shape.
  #   twilio     SMS sending — Gov: chase templates are a stop-and-ask change
  #   meta       WhatsApp Business
  #   xero/qbo   PLATFORM client id + secret only. Per-tenant OAuth tokens
  #              live encrypted in the DB vault table (SoT §18), NOT here.
  #   truelayer  bank feed credentials
  # and extend the execution-role policy in the same PR.
  # ------------------------------------------------------------------------
  injected_secrets = [
    { name = "REDIS_AUTH_TOKEN", valueFrom = "${module.data.redis_secret_arn}:auth_token::" },

    # The Meta webhook pair. WITHOUT THESE THE DEPLOYED ENDPOINT IS UNUSABLE
    # AS A CALLBACK, and it does not look broken — `config/env.ts` defaults both
    # to an empty string and every check then fails CLOSED, exactly as designed:
    # Meta's GET handshake gets 403 NT-INT-002 and a signed POST gets 401.
    # Measured against the deployed task on 15 Aug 2026 before this landed.
    #
    # That is the whole point of deploying the api at all (issue #25): a stable
    # callback URL that does not die with a cloudflared tunnel. The URL existed
    # and could not be verified, which is the least useful state to stop in.
    #
    # The names are the ones env.ts reads; the JSON keys they select are the
    # ones secrets.tf writes. Those two differ and both are load-bearing —
    # `META_APP_SECRET` ← `app_secret`, `META_VERIFY_TOKEN` ← `verify_token`.
    { name = "META_APP_SECRET", valueFrom = "${aws_secretsmanager_secret.app["whatsapp"].arn}:app_secret::" },
    { name = "META_VERIFY_TOKEN", valueFrom = "${aws_secretsmanager_secret.app["whatsapp"].arn}:verify_token::" },

    # The second boot gate from the #90–#107 deploy failures: env.ts refuses an
    # empty UPLOAD_URL_SECRET under NODE_ENV=production, because an empty key
    # fails closed at REQUEST time — the task passes its health check and then
    # 500s every upload, with the deploy that caused it already green (#76).
    # Terraform-generated real value (secrets.tf), never a placeholder: a
    # guessable signing key mints forgeable upload intents.
    { name = "UPLOAD_URL_SECRET", valueFrom = "${aws_secretsmanager_secret.upload_url.arn}:secret::" },

    # ------------------------------------------------------------------------
    # The three HMAC signing keys the METH stages added, all from the `auth`
    # group secrets.tf already creates (METH Stage 15). No IAM change is
    # needed for these and that is not luck: `ecs_execution_app_secrets`
    # (secrets.tf) grants the whole `aws_secretsmanager_secret.app` set, so the
    # ResourceInitializationError trap warned about above does not apply here —
    # it applies to a secret created OUTSIDE that map.
    #
    # ⚠ THE JSON KEYS BEYOND `session_secret` DO NOT EXIST UNTIL THEY ARE PUT.
    # `aws_secretsmanager_secret_version.app` carries
    # `ignore_changes = [secret_string]`, so adding a key to `local.app_secrets`
    # never reaches AWS — secrets.tf says so at length. The two portal keys are
    # delivered out of band with `put-secret-value` writing the FULL group JSON,
    # and a task whose `secrets` entry names a key the secret does not hold
    # fails at start with ResourceInitializationError, not at request time.
    # Order therefore matters: put the value, then apply. The runbook
    # (docs/runbooks/staging-demo-seed.md §1) is the procedure.
    #
    # Why these are secrets rather than `environment` values, given that
    # `env.ts` gives all three an empty default and fails CLOSED: an empty
    # default means the endpoints refuse to sign, which is the safe state; a
    # PLAINTEXT value in a task definition would be a §11.5 violation and
    # readable by anything that can call DescribeTaskDefinition. Fail-closed is
    # the fallback, not the design.
    #
    #   SESSION_SECRET         signs the `nt_session` cookie (Stage 1). Without
    #                          it every scoped endpoint on staging 401s, which
    #                          is the state staging has been in since #84 set
    #                          AUTH_MODE=session with no resolver behind it.
    #   PORTAL_LINK_SECRET     signs the 24 h chase portal link (Stage 8).
    #   PORTAL_SESSION_SECRET  signs the post-OTP portal bearer (Stage 9).
    #                          Deliberately a second key — see env.ts.
    #
    # Rotating session_secret logs every session out. Staging: fine. The
    # ROTATION banner in secrets.tf is where that trap is written down.
    # ------------------------------------------------------------------------
    # ------------------------------------------------------------------------
    # THE APPLICATION'S OWN DATABASE CREDENTIAL — the gap the TODO above named,
    # now closed. Until this, the api and workers tasks carried DATABASE_HOST /
    # PORT / NAME and NO CREDENTIAL AT ALL, so Prisma could not connect and every
    # DB-backed request answered 500 while /healthz stayed green and the deploy
    # stayed green. Measured against the deployed task on 19 Aug 2026.
    #
    # ⚠ `nt_app`, NEVER the migrator. The master credential on RDS carries
    # `rds_superuser`, which is exempt from row-level security outright, and even
    # the plain table owner is only constrained because rls.sql sets FORCE ROW
    # LEVEL SECURITY. Handing either to a long-running service turns every policy
    # in prisma/ into decoration — silently, because a tenancy leak returns MORE
    # rows and nothing throws. db-app-role.tf is the whole argument.
    #
    # The join happens in-process (config/app-database-url.ts) for the same
    # reason the migrate task's does: an ECS `secrets` entry cannot be
    # interpolated into another environment variable, and Prisma reads
    # `DATABASE_URL`.
    #
    # No IAM change: `read_db_app_role_secret` (db-app-role.tf) is already
    # attached to BOTH the execution role and the task role.
    #
    # ⚠ The role must EXIST in the database before a task using it can serve.
    # Nothing created it until `apps/api/dist/db/app-role.js` — see
    # docs/runbooks/staging-demo.md §2b. Deploying this without running that
    # leaves the api unable to authenticate to Postgres.
    # ------------------------------------------------------------------------
    { name = "DB_APP_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db_app_role.arn}:password::" },

    { name = "SESSION_SECRET", valueFrom = "${aws_secretsmanager_secret.app["auth"].arn}:session_secret::" },
    { name = "PORTAL_LINK_SECRET", valueFrom = "${aws_secretsmanager_secret.app["auth"].arn}:portal_link_secret::" },
    { name = "PORTAL_SESSION_SECRET", valueFrom = "${aws_secretsmanager_secret.app["auth"].arn}:portal_session_secret::" },

    # D48's subscription rail. Sandbox credentials — see the BILLING block above
    # for why that is the guarantee no card can be charged, and secrets.tf for
    # why the webhook secret is not an optional half of the pair.
    #
    # No IAM change is needed: `ecs_execution_app_secrets` (secrets.tf) grants
    # `[for s in aws_secretsmanager_secret.app : s.arn]`, so a new group in that
    # map is granted by construction. That is the one place in this stack where
    # adding a secret does NOT also mean remembering an ARN — the whatsapp entry
    # in compute.tf is a different role and a different list.
    { name = "STRIPE_SECRET_KEY", valueFrom = "${aws_secretsmanager_secret.app["stripe"].arn}:secret_key::" },
    { name = "STRIPE_WEBHOOK_SECRET", valueFrom = "${aws_secretsmanager_secret.app["stripe"].arn}:webhook_secret::" },
  ]

  # ⚠ THE RDS MASTER CREDENTIAL GOES TO THE MIGRATION TASK AND NOWHERE ELSE.
  #
  # An earlier revision put these in `injected_secrets` — the list injected
  # into BOTH long-running services — defended by the comment that naming them
  # MIGRATOR rather than DATABASE_* stopped application code picking them up by
  # accident. That defence is a naming convention, and a naming convention is
  # not a control.
  #
  # The master user owns the schema and holds `rds_superuser`. A table owner is
  # subject to FORCE ROW LEVEL SECURITY, but a superuser is NOT — so this
  # credential bypasses every tenancy policy in prisma/ outright (Gov §5.2).
  # Sitting in the environment of a service that runs for weeks, it is
  # available to anything that achieves code execution in that container, to
  # any dependency that dumps env on start, and to any crash handler that
  # serialises the process environment. "No code reads it" is not the property
  # that matters; "no code CAN read it" is, and only the second one survives a
  # dependency you did not write.
  #
  # `prisma migrate deploy` is a one-off task in the deploy pipeline (runbook
  # §6.4), so the credential belongs on a task definition with no service
  # attached — it exists only for the seconds a migration runs.
  migration_secrets = [
    { name = "DB_MIGRATOR_USER", valueFrom = "${module.data.db_master_user_secret_arn}:username::" },
    { name = "DB_MIGRATOR_PASSWORD", valueFrom = "${module.data.db_master_user_secret_arn}:password::" },

    # The non-owning role the application itself connects as. The migration
    # needs it to CREATE ROLE / ALTER ROLE with the right password — see
    # db-app-role.tf, which owns the credential and documents the SQL half.
    { name = "DB_APP_ROLE_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db_app_role.arn}:password::" },
  ]
}

# --------------------------------------------------------------------------
# Migration task — `pnpm prisma migrate deploy`, run once per deploy.
#
# No aws_ecs_service: this is a task definition the pipeline invokes with
# `ecs run-task` and waits on. That is the whole point — it is the only place
# the master credential exists, and it exists for the duration of a migration
# rather than the duration of an environment.
#
# Governance §1.3: `migrate deploy` is the ONLY migration command that runs
# anywhere except a developer laptop. `migrate dev` must never appear here.
# --------------------------------------------------------------------------
resource "aws_ecs_task_definition" "migrate" {
  family                   = "nt-${local.env}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.app.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "migrate"
      image     = "${aws_ecr_repository.this["api"].repository_url}:${local.image_tag}"
      essential = true

      # Overridden by the pipeline if a different entrypoint is wanted; stated
      # here so the task is runnable by hand during an incident without anyone
      # having to remember the command.
      #
      # ⚠ NOT `pnpm prisma migrate deploy` DIRECTLY, and the indirection is the
      # point. This task receives DATABASE_HOST/PORT/NAME as environment values
      # and DB_MIGRATOR_USER/PASSWORD as Secrets Manager injections, because
      # §11.5 forbids a plaintext credential in a task definition — while Prisma
      # reads DATABASE_URL and DIRECT_URL. An ECS `secrets` entry cannot be
      # interpolated into another environment variable, so nothing here can join
      # them; the wrapper composes the URL in-process and execs the same
      # `prisma migrate deploy` underneath.
      #
      # That gap is why the deploy pipeline shipped with no migration step at
      # all. apps/api/src/db/migrate.ts carries the full reasoning.
      command = ["node", "apps/api/dist/db/migrate.js"]

      environment = concat(local.common_environment, [
        { name = "SERVICE_NAME", value = "migrate" },
      ])

      secrets = local.migration_secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.migrate.name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "migrate"
        }
      }
    }
  ])
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/nt/${local.env}/migrate"
  retention_in_days = 30 # Governance §12.2

  tags = { Component = "migrate" }
}

# --------------------------------------------------------------------------
# Capacity providers on the existing cluster.
#
# Registered here so the Spot/on-demand split below is a one-line strategy
# change rather than a cluster edit. FARGATE is the default so anything that
# forgets to declare a strategy lands on on-demand, never on Spot by surprise.
# --------------------------------------------------------------------------

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }
}

# --------------------------------------------------------------------------
# Task definitions.
#
# ARM64 (Graviton) on both: Fargate ARM64 is ~20% cheaper per vCPU-hour than
# x86, which is ~$7/mo here and scales with every task prod ever runs. The
# data tier is already Graviton (db.t4g, cache.t4g), so this keeps one
# architecture story.
#
# ⚠ THE PRICE OF THAT: the Dockerfiles MUST produce linux/arm64 images
# (`docker buildx build --platform linux/arm64`). An x86 image on an ARM64
# task definition dies instantly with "exec format error" and nothing else.
# If CI cannot build arm64 yet, flip cpu_architecture to X86_64 here — the
# cost of that flip is a few dollars a month, which is cheaper than a day
# lost to a confusing deploy.
# --------------------------------------------------------------------------

resource "aws_ecs_task_definition" "api" {
  family                   = "nt-${local.env}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc" # mandatory on Fargate; it is what makes target_type = "ip" work
  cpu                      = local.task_size["api"].cpu
  memory                   = local.task_size["api"].memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn # pulls the image, writes logs, reads the secrets above
  task_role_arn            = aws_iam_role.app.arn           # what the app itself may do (S3, KMS, Bedrock, Textract, SES)

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  # ephemeral_storage is deliberately unset: Fargate gives 20 GiB free and
  # bills every GiB above it. Document temp files fit; anything that does not
  # belongs in S3 anyway.

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = "${aws_ecr_repository.this["api"].repository_url}:${local.image_tag}"
      essential = true

      portMappings = [
        {
          containerPort = local.app_port
          protocol      = "tcp"
        }
      ]

      environment = concat(local.common_environment, [
        { name = "SERVICE_NAME", value = "api" },
        { name = "PORT", value = tostring(local.app_port) },
      ])

      secrets = local.injected_secrets

      # No container-level healthCheck: the ALB target group already probes
      # /healthz from outside the task, and a container check would need curl
      # baked into the image purely to duplicate it. workers, which has no
      # load balancer, is the case where one is actually needed — see below.

      # PID 1 in a container reaps nothing. Without init, every child process
      # the app spawns (pdf tooling, image conversion) leaves a zombie until
      # the task runs out of process slots — days later, in staging, on a
      # Friday.
      linuxParameters = {
        initProcessEnabled = true
      }

      # readonlyRootFilesystem is NOT set: extraction writes temp files to
      # /tmp and Fargate does not support tmpfs mounts, so a read-only root
      # would mean an EFS volume — cost and complexity for a staging
      # environment that holds synthetic data only (G2).

      # ECS drains the target for deregistration_delay (30s) before the SIGTERM
      # lands, so 30s here is enough to finish in-flight requests.
      stopTimeout = 30

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          # The pre-created group (compute.tf) — 30-day retention, Gov §12.2.
          # Never let ECS auto-create this: auto-created groups keep logs
          # forever, and CloudWatch ingest is Appendix B.2's sleeper line item.
          "awslogs-group"         = aws_cloudwatch_log_group.service["api"].name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = { Component = "api" }
}

resource "aws_ecs_task_definition" "workers" {
  family                   = "nt-${local.env}-workers"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.task_size["workers"].cpu
  memory                   = local.task_size["workers"].memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.app.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "workers"
      image     = "${aws_ecr_repository.this["workers"].repository_url}:${local.image_tag}"
      essential = true

      # ⚠ REQUIRED, not decoration. api and workers ship the SAME image
      # (apps/api/Dockerfile — one build, one digest, so the migration that ran
      # and the code that runs are provably the same commit). That image's CMD
      # starts the API, so a workers container with no `command` would come up
      # as a second, load-balancer-less copy of the API: healthy-looking,
      # consuming nothing, and the queue would just grow.
      command = ["node", "apps/api/dist/worker/main.js"]

      # No portMappings: BullMQ consumers pull from Redis. Nothing dials in,
      # and the app security group has no inbound rule that would let it.

      environment = concat(local.common_environment, [
        { name = "SERVICE_NAME", value = "workers" },

        # One task, modest concurrency. Queue-depth autoscaling (runbook §6.4,
        # Gov §13.2 alerts on queue age > 5 min) is a follow-up: it cannot be
        # wired while desired_count is pinned at 0 and ignored below.
        { name = "WORKER_CONCURRENCY", value = "4" },
      ])

      secrets = local.injected_secrets

      # TODO: with no load balancer there is nothing probing this container.
      # Add a healthCheck once the image ships a `node dist/healthz.js` style
      # command that asserts Redis reachability — until then a worker that has
      # silently stopped consuming looks identical to an idle one.

      linuxParameters = {
        initProcessEnabled = true
      }

      # 120s is the Fargate maximum and it is here for Spot: an interruption
      # gives a two-minute warning, so the worker must catch SIGTERM, stop
      # accepting new jobs, and let the in-flight one finish. A job killed
      # mid-flight is re-delivered by BullMQ, so this is about not doing
      # Textract/Bedrock work twice — i.e. about the bill (D28's
      # < £0.02/document guardrail).
      stopTimeout = 120

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.service["workers"].name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = { Component = "workers" }
}

# --------------------------------------------------------------------------
# Services.
#
# ⚠ BOTH RUN AT desired_count = 0 AND THAT IS DELIBERATE.
#
# There is no image in ECR yet (local.image_tag above). A service with
# desired_count > 0 would launch a task, fail the image pull, back off, and
# retry forever — burning Fargate minutes, filling the log group we pay to
# ingest, and firing the circuit breaker on every apply. Deploying for the
# first time is therefore a count change (CI, or `aws ecs update-service
# --desired-count 2`), not an infrastructure change. That is also why
# desired_count is in ignore_changes: once CI or autoscaling owns the number,
# a `terraform apply` from anyone's laptop must never quietly scale staging
# back to whatever this file happens to say.
#
# task_definition is ignored for the same reason: CI registers a new revision
# per deploy and points the service at it. Without the ignore, the next apply
# would roll staging back to the placeholder revision below — the classic
# "who redeployed last week's build?" incident.
# --------------------------------------------------------------------------

resource "aws_ecs_service" "api" {
  name            = "nt-${local.env}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 0

  # On-demand, never Spot, for anything serving HTTP — a Spot reclaim is a
  # two-minute warning and then a dead target. Appendix B.2 allows Spot for
  # workers only, and staging keeps the same shape as prod so the shape is
  # what gets tested.
  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }

  # Runbook §6.4 / Gov §14.9, §16: this IS the "auto-rollback on health
  # regression". A deployment whose tasks cannot pass the target-group check
  # is rolled back to the last good revision by ECS itself, without a human.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # 100/200: never drop below full capacity during a deploy. With only two
  # tasks, allowing 50% would leave a single task serving everything for the
  # length of a rollout. The extra task exists for minutes and costs cents.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # Node + Prisma needs a moment to connect before /healthz answers. Too low
  # and a cold start looks like a failed deploy to the circuit breaker.
  health_check_grace_period_seconds = 60

  network_configuration {
    subnets         = module.network.public_subnet_ids
    security_groups = [module.network.app_security_group_id]

    # There is NO NAT gateway in staging by design (network.tf, Appendix
    # B.3): a public IP is how the task reaches ECR, Secrets Manager, Bedrock
    # and Textract at all. Nothing can reach IN — the app SG's only ingress is
    # from the ALB SG on 3000. Public IPv4 is ~$3.60/task/mo, so three tasks
    # is ~$11/mo against a NAT's ~$36/mo + data processing. That trade stops
    # paying at roughly ten tasks; prod gets the NAT.
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = local.app_port
  }

  # ECS-managed tags plus the provider's default_tags reach the tasks and ENIs
  # themselves, which is what makes per-service cost attribution (Gov §13.5)
  # possible in Cost Explorer rather than a guess.
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  # ECS Exec stays OFF: the task role (compute.tf) grants no
  # ssmmessages:* permissions, and enabling it without them produces a task
  # that runs with a permanently STOPPED managed agent — a broken debugging
  # tool is worse than an absent one. Turning it on is a task-role change
  # first (runbook §6.1: no bastion, no SSH).
  enable_execute_command = false

  # A target group must already be attached to a load balancer before ECS will
  # accept the service. The HTTPS listener's default action is a 403, so the
  # attachment only happens via the origin-verified rule. The capacity
  # provider association is not visible to Terraform through `cluster` alone,
  # and creating a service that names FARGATE before the cluster lists it
  # fails with "capacity provider not associated".
  depends_on = [
    aws_lb_listener.https,
    aws_lb_listener_rule.api_origin_verified,
    aws_ecs_cluster_capacity_providers.main,
  ]

  tags = { Component = "api" }

  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }
}

resource "aws_ecs_service" "workers" {
  name            = "nt-${local.env}-workers"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.workers.arn
  desired_count   = 0

  # COST DECISION (Appendix B.2: "Spot for workers"): Fargate Spot is ~70%
  # cheaper, taking this task from ~$16.60/mo to ~$5/mo. Acceptable because a
  # reclaimed worker costs a re-delivered BullMQ job, not a failed user
  # request — and staging is synthetic-data-only (G2). Never for the api, and
  # never for prod workers without a queue-lag SLO to check it against.
  #
  # ⚠ Verify at first deploy that Fargate Spot places ARM64 tasks in
  # eu-west-2. If placement is rejected, either move this strategy to FARGATE
  # (+~$11/mo) or set this task definition to X86_64.
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
    base              = 0
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # 0/100, the opposite of api, on purpose: replace in place rather than
  # running old and new consumers side by side. Doubling consumers mid-deploy
  # doubles concurrent Textract/Bedrock calls against the same queue for no
  # benefit, and there is no availability to protect — the queue simply waits.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  network_configuration {
    subnets          = module.network.public_subnet_ids
    security_groups  = [module.network.app_security_group_id]
    assign_public_ip = true # no NAT — see the api service above
  }

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"
  enable_execute_command  = false

  # FARGATE_SPOT must be associated with the cluster before a service may name
  # it; that link is invisible to Terraform's graph through `cluster` alone.
  depends_on = [aws_ecs_cluster_capacity_providers.main]

  tags = { Component = "workers" }

  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }
}

# --------------------------------------------------------------------------
output "ecs_service_names" {
  value = {
    api     = aws_ecs_service.api.name
    workers = aws_ecs_service.workers.name
  }
  description = "Both run at desired_count = 0 until an image exists; deploying is a count change."
}

output "ecs_task_families" {
  value = {
    api     = aws_ecs_task_definition.api.family
    workers = aws_ecs_task_definition.workers.family
  }
}
