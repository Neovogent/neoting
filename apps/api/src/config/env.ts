import { z } from 'zod';

import { composeRedisUrl } from './connection-urls.js';

/**
 * The single place that reads `process.env` (Governance §11.5). Zod-validated,
 * fails fast at boot on a malformed value, and no other module touches
 * `process.env` directly.
 *
 * The Meta integration secrets are optional here on purpose: the app must boot
 * and serve `/healthz` without them. A fresh clone has empty placeholders, and
 * the Meta sandbox credentials have not been issued yet (issue #9). The webhook
 * fails CLOSED when they are unset — signatures cannot verify, so `POST` returns
 * 401 and the `GET` challenge 403 until the secrets are configured. This mirrors
 * the scaffold's other sandbox keys (Twilio, Xero…), which are also blank in
 * `.env.example`.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Pinned to 3000 by infra/envs/staging (ALB target group + security group).
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  // Empty = fail CLOSED, not "verification off": an empty secret makes every
  // signature/token check return false (POST 401 / GET 403). Set both for the
  // webhook to accept anything.
  META_APP_SECRET: z.string().default(''),
  META_VERIFY_TOKEN: z.string().default(''),
  // The WhatsApp media fetch (#79) is a GRAPH call, and neither secret above
  // authenticates one: META_APP_SECRET is the webhook HMAC key and
  // META_VERIFY_TOKEN is the handshake echo. Downloading media needs a separate
  // bearer with `whatsapp_business_messaging` — a System User token. Blank here
  // and in `.env.example`; `MEDIA_FETCH=graph` REFUSES TO BOOT without it below,
  // rather than failing open at fetch time.
  META_MEDIA_ACCESS_TOKEN: z.string().default(''),

  // WhatsApp media (#79). `fixture` = seeded in-memory bytes (default — offline
  // tests, and any dev without Meta credentials); `graph` = the real Meta Cloud
  // API. Selected by config, not by import, like the four switches below.
  MEDIA_FETCH: z.enum(['fixture', 'graph']).default('fixture'),

  /**
   * WABA phone-number-id → practice id, as JSON. The tenancy anchor a WhatsApp
   * document has instead of a business.
   *
   * ⚠ INTERIM, and the shape is the point. `documents.practice_id` is the only
   * anchor an unrouted document has — `documentKey()` throws without one and the
   * `documents_tenant_anchor` CHECK refuses the row — but nothing in `prisma/`
   * maps a Meta number to a practice, so there is nowhere to look it up. This is
   * the same move the email lane made (`email-intake.ts`: the caller supplies
   * `practiceId`, with the seam written down), keyed by the number that RECEIVED
   * the message so a future `Practice.whatsappPhoneNumberId` column replaces it
   * without touching a call site. **That column LANDED 1 Sep 2026**
   * (`Practice.whatsappPhoneNumberId`, unique): the worker's
   * `PrismaWhatsAppPracticeResolver` answers a number this env never named, so
   * this map is now the controller-side OVERRIDE (no DB round trip on the
   * webhook) rather than the only source.
   *
   * Fails CLOSED: a number neither source names yields no anchor, the worker
   * refuses to persist and the job lands in the DLQ. It is never a quiet
   * success that wrote nothing.
   */
  WHATSAPP_PRACTICE_MAP: z
    .string()
    .default('{}')
    .transform((raw, ctx): Readonly<Record<string, string>> => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a JSON object of {"<phone_number_id>": "<practiceId>"}' });
        return z.NEVER;
      }
      const shape = z.record(z.string().min(1), z.string().min(1)).safeParse(parsed);
      if (!shape.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a flat JSON object mapping phone_number_id to a non-empty practice id' });
        return z.NEVER;
      }
      return Object.freeze(shape.data);
    }),

  // The request-context resolver (#75). `fixture` = trust `X-NT-*` dev headers
  // (default — lets endpoints exercise scopedDb before auth exists); `session` =
  // the real S1 resolver (cookie → memberships → ScopeContext, issue #118).
  // Selected by config, not import, like the others. ⚠ `fixture` is REFUSED
  // under `NODE_ENV=production` below.
  AUTH_MODE: z.enum(['fixture', 'session']).default('fixture'),

  // Signs the stateless `nt_session` cookie (METH Stage 1, #118) — the same
  // HMAC pattern as UPLOAD_URL_SECRET. Empty default fails CLOSED: signing or
  // verifying with an empty secret is refused, so an unset secret cannot mint a
  // forgeable session. REFUSED EMPTY under `NODE_ENV=production` below (S1).
  //
  // ⚠ THAT REFUSAL REVERSES WHAT THIS COMMENT USED TO SAY, and the reversal is
  // the interesting part. It argued against a boot gate because staging ran
  // `AUTH_MODE=session` with no secret behind it, so a gate would have
  // crash-looped the next deploy and taken `/healthz` down over a secret
  // nobody had yet. METH Stage 15 (#146) closed that: `/neoting/staging/auth`
  // holds the key and the task definition injects it. What the missing gate
  // still protected was therefore only the case it was never meant to allow —
  // a real environment signing real sessions with the empty string.
  SESSION_SECRET: z.string().default(''),

  // Second-factor verification mode, for both the accountant sign-in
  // (`auth.service.ts`) and the client portal (`portal-session.service.ts`).
  // `demo` accepts ONE literal six-digit code — the same one on every account,
  // in every practice, on every portal session, and it is written down in the
  // source and in the seed. `totp` is the real RFC 6238 verifier. Default
  // `demo` so a fresh clone and CI sign in offline; `demo` is REFUSED under
  // `NODE_ENV=production` below (S1).
  //
  // ⚠ S1 DECLARED `totp` AS AN ENUM VALUE BEFORE IT WAS AN IMPLEMENTATION, and
  // A2 HAS NOW IMPLEMENTED IT. S1's note said setting `totp` made every second
  // factor return false; the verifiers behind this switch are real as of A2 —
  // `auth-tenancy/totp.ts` (RFC 6238 through otplib, against the envelope in
  // `users.totp_secret_ref`, plus single-use recovery codes) and
  // `portal-session.service.ts` (the minted code in `otp_sessions.otp_hash`).
  //
  // S1's fail-closed intent survives where there is nothing to check, and that
  // is still the right way round: an account with no enrolment, or a portal
  // session with no code minted for it, cannot pass. Both remain UNREACHABLE to
  // fix from inside A2, because `openapi.yaml` publishes no enrolment operation
  // and nothing implements the code-minting one (G7) — see
  // `auth-tenancy/totp-enrolment.service.ts`.
  OTP_MODE: z.enum(['demo', 'totp']).default('demo'),

  // Web-upload intent signing (#76). The `uploadId` is a STATELESS HMAC-signed
  // token (no DocumentUpload table — prisma/ is LAW), and this secret signs it.
  // Empty default fails CLOSED, exactly like the Meta secrets: signing or
  // verifying with an empty secret is refused, so an unset secret cannot silently
  // mint forgeable upload intents.
  UPLOAD_URL_SECRET: z.string().default(''),
  // How long a presigned upload intent stays valid. Past it, completion is
  // `NT-ING-005`. 15 minutes covers a 100 MB batch on a poor connection.
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  // The ingest queue (#12). `fixture` = in-memory (default — offline tests and
  // any dev without Redis); `bullmq` = real BullMQ on Redis. Selected by config,
  // not by import, so the webhook controller is identical either way.
  INGEST_QUEUE: z.enum(['fixture', 'bullmq']).default('fixture'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Object storage for sanitised documents (#16). `fixture` = in-memory
  // (offline tests, dev without MinIO); `s3` = real S3 / MinIO. Selected by
  // config, not by import. In staging S3_ENDPOINT is empty (real AWS endpoint)
  // and credentials come from the task role's default provider chain, so both
  // are blank there — not required.
  OBJECT_STORE: z.enum(['fixture', 's3']).default('fixture'),

  // Inbound email source (#78). `fixture` = in-memory (offline tests); `mailhog`
  // = the local SES stand-in's HTTP API; `s3` = the SES receipt prefix in
  // staging. Selected by config, not import, like the switches above. Default
  // `fixture` so a fresh clone and CI never poll a mail server that is not there.
  EMAIL_SOURCE: z.enum(['fixture', 'mailhog', 's3']).default('fixture'),
  // MailHog's HTTP API (SMTP is 1025; the API is 8025). Only read when
  // EMAIL_SOURCE=mailhog.
  MAILHOG_API_URL: z.string().url().default('http://localhost:8025'),
  // The SES receipt bucket (raw inbound MIME under `inbound/`). Distinct from
  // S3_BUCKET_DOCUMENTS — this is where SES writes, not where sanitised documents
  // land. Local MinIO seeds `nt-local-receipts` (docker-compose).
  S3_BUCKET_RECEIPTS: z.string().default('nt-local-receipts'),

  // The image normaliser (#23). `fixture` = passthrough, and it REFUSES HEIC
  // because it genuinely cannot read one; `sharp` = the real EXIF/HEIC path.
  // Selected by config rather than by import so unit tests stay offline and
  // deterministic — a test feeding four magic bytes and the word "image" must
  // not be handed to a real decoder that correctly rejects it. ⚠ `fixture` is
  // REFUSED under `NODE_ENV=production` below (S1) — HEIC is the default
  // camera format on every iPhone since iOS 11, so the format the fixture
  // cannot read is the format a photographed receipt actually arrives in.
  IMAGE_NORMALISER: z.enum(['fixture', 'sharp']).default('fixture'),

  // The PDF guard (#22). `fixture` = the dependency-free /Encrypt grep, which
  // has a known false-negative on incrementally-updated PDFs; `qpdf` = the real
  // one. Defaults to fixture so a machine without the binary still runs tests —
  // the guard's own unit tests drive a fake runner, so the decision logic is
  // covered everywhere rather than only where the binary happens to exist.
  //
  // ⚠ `fixture` is REFUSED under `NODE_ENV=production` below (S1), and qpdf
  // is installed in the runtime image as of that same change. The false
  // negative is not exotic: an incrementally-updated PDF is most signed or
  // form-filled accounting paperwork, and a password-protected one the grep
  // passes is a document the pipeline then cannot read, with the guard having
  // reported it clean.
  DOCUMENT_GUARD: z.enum(['fixture', 'qpdf']).default('fixture'),

  // The document extractor (METH Stage 4). `demo` = the deterministic fixture
  // engine that moves documents out of RECEIVED; Textract + the vision ladder
  // lands behind the same seam later. Default `demo` so a document actually gets
  // extracted — that is the whole point of the step. Selected by config, not import.
  //
  // `bedrock` is the REAL one: Claude reads the document image through the same
  // `DocumentExtractor` seam.
  //
  // ⚠ `bedrock` DOES NOT DEGRADE TO `demo`. A `FallbackExtractor` wrapped it
  // until 25 Aug 2026, catching a throw and answering with fixture data for the
  // same real client document — which meant an invented supplier, total, tax and
  // VAT number stamped onto someone's books at 0.8 confidence and marked Ready,
  // triggered by nothing worse than a throttle. It is deleted. A failed read is
  // a FAILED document with a visible reason, retryable through a reprocess
  // proposal (select-extractor.ts).
  //
  // ⚠ `demo` is REFUSED under `NODE_ENV=production` below (S1). Every other
  // demo switch in this file DEGRADES something — no SMS arrives, no bill
  // reaches a ledger. This one INVENTS: DemoExtractor derives supplier, date,
  // total, tax and a VAT number from a hash of the filename, stamps 0.8
  // confidence on them, and `resolveProcessedState` reads 0.8 as Ready. The
  // accountant is shown a complete, confident invoice with no signal that
  // nothing was ever read. That is the AI_CHAT failure mode with the volume
  // turned up, so it gets the AI_CHAT answer: a boot refusal, not a safe
  // default.
  //
  // `replay` constructs the REAL BedrockExtractor — same request building, same
  // Zod parse of the model's answer, same error mapping, same budget metering —
  // with the transport served from recorded cassettes on disk
  // (`common/bedrock-replay.ts`, `apps/api/fixtures/cassettes/bedrock/`). A
  // request with no cassette FAILS LOUDLY naming the record command; it never
  // falls through to live Bedrock and never invents an answer. It exists so
  // local development can exercise the adapter code offline; `demo` skips that
  // code entirely. ⚠ `replay` is REFUSED under `NODE_ENV=production` below —
  // it answers from recordings, and a recording of one document is not a
  // reading of another.
  EXTRACTOR: z.enum(['demo', 'bedrock', 'replay']).default('demo'),

  /**
   * How a PDF or photographed bank statement becomes a table (D20, D41).
   *
   * `textract`  Amazon Textract's TABLES feature — the committed OCR rung.
   * `none`      No reader. CSV and XLSX still import (they need no OCR); a PDF
   *             or an image is REFUSED with a reason, never silently skipped.
   *
   * Defaults to `none` so a cold clone and every offline test work with no AWS
   * credentials, and so a machine that cannot reach Textract says so rather than
   * appearing to import a statement it never read. Textract cannot read MinIO,
   * so local development is `none` by necessity, not by preference.
   */
  STATEMENT_READER: z.enum(['none', 'textract']).default('none'),

  // NO BEDROCK_MODEL_ID, deliberately. The model is pinned in
  // `modules/chat-framework/models.ts` and imported — never configured
  // (Governance §9.1: "a model upgrade is a PR that changes this file AND
  // passes the full eval suite; it is never a silent swap"). An env var here
  // meant the extraction model could be swapped by editing an ECS task
  // definition, with no PR and no eval run, and it disagreed with models.ts
  // about which model generation Neoting runs.
  //
  // The measurement that motivated the old default still stands and is worth
  // keeping: a bare `anthropic.claude-*` id for the NEWEST generation returns
  // "Invocation ... with on-demand throughput isn't supported. Retry with an
  // inference profile" (20 Aug 2026). That is an argument for a D28/D30
  // amendment and an IAM change, made deliberately — not for an env override.
  // Until then the extractor runs the same region-pinned model the chat runtime
  // already proves works on-demand in eu-west-2.

  // The Bedrock region, shared by the extractor above and the chat runtime
  // below. Separate from AWS_REGION on two counts: it lets Bedrock be pinned to
  // a region where the model is actually available without moving the rest of
  // the stack, and — pinned to eu-west-2 by D30/ADR 0001 (UK residency) — it
  // makes "where does client document text get processed" answerable from
  // configuration rather than from whatever the container happened to inherit.
  BEDROCK_REGION: z.string().default('eu-west-2'),

  // How a chase leaves the building (METH Stage 8; `email` added by launch
  // stage A13). Selected by config, not import, exactly like EXTRACTOR /
  // MEDIA_FETCH / EMAIL_SENDER.
  //
  //   demo   `DemoSmsSender` — "sends" by writing the outbox rows the
  //          SMS-outbox screen reads. No Twilio, ever. Nothing leaves the
  //          machine, and it stays the default so a fresh clone and CI run the
  //          whole journey offline.
  //   email  `EmailChaseSender` (A13) — the chase is delivered by email through
  //          the S2 notifications transport, carrying the reviewed body
  //          byte-for-byte. SMS was cut for Initial Delivery and this is the
  //          chase lane's only real delivery.
  //
  // ⚠ **The name is now one value out of date and a rename is not this
  // stage's.** This key selects the chase TRANSPORT, of which SMS is no longer
  // one. Renaming it to `CHASE_SENDER` means editing `.env.example`,
  // `infra/envs/staging/services.tf` and `infra/README.md` in the same change —
  // all outside stage A13's fence — and a half-done rename is an environment
  // that boots with the wrong transport. Recorded, deliberately deferred.
  //
  // ⚠ **Widened rather than given a sibling key, on purpose.** A second switch
  // ("SMS_SENDER=demo, CHASE_EMAIL=on") would be two knobs governing one act,
  // and every combination of two knobs includes the ones nobody meant: a
  // configured email transport that never sends because the other key still
  // says `demo`, silently, with a green outbox row to look at. One key, one
  // decision, no precedence rule to remember.
  //
  // ⚠ **`email` points at a second switch, and no gate is added beside the one
  // that already covers it.** The transport it composes is `EMAIL_SENDER`-
  // selected, so `SMS_SENDER=email` + `EMAIL_SENDER=demo` still delivers
  // nothing — and `EMAIL_SENDER=demo` is ALREADY refused under
  // `NODE_ENV=production` below (S2). One gate covering every outbound email
  // beats a second one covering this caller only and able to disagree with it.
  //
  // ⚠ **`demo` IS refused under `NODE_ENV=production`** (the superRefine below),
  // landed 1 Sep 2026 in the SAME change that flips
  // `infra/envs/staging/services.tf` to `SMS_SENDER=email` — the pairing the
  // previous version of this comment demanded. The failure it closes has the
  // `EMAIL_SENDER=demo` shape: the chase is approved, the outbox row appears,
  // and no client is ever contacted.
  // `aws` is the real SMS wire (Phase 3, 2 Sep 2026): AWS End User Messaging —
  // the owner's 1 Sep decision superseding the Twilio note D32 carried. The
  // reviewed body goes on the wire verbatim to the REGISTERED mobile the
  // review card showed; a STOP'd recipient refuses the approval (§24.2.3 — a
  // send never argues with an opt-out). Requires SMS_ORIGINATION_IDENTITY
  // (refused empty at boot, below) and the sms-voice:SendTextMessage IAM grant.
  SMS_SENDER: z.enum(['demo', 'email', 'aws']).default('demo'),

  // Where SMS is sent from and through (Phase 3). The identity is the UK
  // dedicated number (or pool id/ARN) the carrier registration activates —
  // empty until it exists, and SMS_SENDER=aws refuses to boot on empty: a
  // sender with no origination identity fails at REQUEST time on every send,
  // which is the UPLOAD_URL_SECRET failure shape (healthy task, dead feature).
  SMS_REGION: z.string().default('eu-west-2'),
  SMS_ORIGINATION_IDENTITY: z.string().default(''),

  // The web app's public origin — where `/p/<token>` (the chase portal) and
  // `/app/setup` are served. Read by chase.send composition to build the full
  // portal URL the reviewed message carries; the default is the staging
  // frontend so a task definition that never sets it keeps working links.
  // Local .env sets http://localhost:5173. The two hard-coded
  // DEFAULT_APP_ORIGIN constants (clients-team-settings, auth-tenancy) are the
  // acknowledged siblings to migrate onto this key.
  APP_ORIGIN: z.string().default('https://app.neoting.neovogent.com'),

  // ── Outbound email (S2) ──────────────────────────────────────────────────
  //
  // ⚠ THIS BLOCK IS IN S1's FILE AND S2 WROTE IT, KNOWINGLY. A transport whose
  // implementation is chosen by config has to have somewhere for that config to
  // live, and Governance §11.5 makes this the only file that may read
  // process.env. It is written as one self-contained block, additive, touching
  // no existing line, so S1's boot-gate pass merges over it rather than into it.
  //
  // The sender (S2). `demo` = `DemoEmailSender`, which "sends" into an
  // in-memory outbox dev and tests read back — no network, no AWS credentials,
  // so a fresh clone runs the whole journey offline. `ses` = the real Amazon
  // SES v2 client. Selected by config, not import, exactly like EXTRACTOR /
  // SMS_SENDER / OBJECT_STORE.
  //
  // ⚠ `demo` is REFUSED under NODE_ENV=production below, and it is the AI_CHAT
  // case rather than the SMS_SENDER one. Every other demo switch degrades
  // something a user can SEE — no bill reaches Xero, no document is really
  // read. This one degrades nothing visible at all: the invite is "sent", the
  // sign-in code is "sent", each call returns a message id, and no email
  // exists. With SMS cut for Initial Delivery, email is the client's ONLY
  // channel, so a production `demo` sender is a client who can never sign in
  // and a workspace where nothing looks wrong.
  EMAIL_SENDER: z.enum(['demo', 'ses']).default('demo'),

  // The Bedrock knobs' reasoning, applied to SES: a separate region variable
  // makes "where is client mail processed" answerable from configuration rather
  // than from whatever the container inherited, and pins it to London (D30 /
  // ADR 0001). eu-west-2 is where the verified identity, the DKIM records and
  // the configuration set actually are (infra/envs/staging/email.tf).
  SES_REGION: z.string().default('eu-west-2'),

  // The envelope From. A BARE address — the display name is product copy and
  // lives in `modules/notifications/email-copy.ts`, because a brand that can be
  // changed by editing an ECS task definition is a brand nobody reviews.
  //
  // ⚠ `no-reply@`, NEVER `doc@`. `doc@` is the INBOUND document intake address
  // (email.tf, the `doc-to-s3` receipt rule): mail arriving there is written to
  // the receipts bucket and filed as a client document. Sending from it would
  // mean every "thanks, got it" a client types back is ingested as paperwork.
  EMAIL_FROM_ADDRESS: z.string().default('no-reply@neoting.neovogent.com'),

  // Where a replying human lands. A different domain on purpose: the sending
  // domain's MX points at SES inbound, whose rule set accepts `doc@` and
  // `dmarc@` and nothing else, so a reply to any other address ON it bounces.
  // Empty omits the header rather than sending a blank one.
  EMAIL_REPLY_TO_ADDRESS: z.string().default('support@neovogent.com'),

  // The SES configuration set (`nt-<env>-default`, email.tf). Left off, a
  // message still sends — and silently opts out of bounce/complaint
  // suppression, reputation metrics and the SNS event feed, i.e. every
  // mechanism that would tell us an address has already bounced. Empty default
  // because there is no configuration set on a laptop; required for `ses` below.
  EMAIL_CONFIGURATION_SET: z.string().default(''),

  // The rate-limit store (per address AND per IP, `email-rate-limit.ts`).
  // `memory` = in-process counters; `redis` = shared ones.
  //
  // ⚠ `memory` is refused alongside a real sender in production below. The API
  // runs more than one ECS task, so an in-process ceiling of five is five PER
  // TASK — the numbers in that file become fiction, in the direction that costs
  // a sending reputation, and nothing about it is visible.
  EMAIL_RATE_LIMIT: z.enum(['memory', 'redis']).default('memory'),

  // Signs the chase portal-link token (METH Stage 8, SoT §4 Stage 8.3) — the
  // same HMAC pattern as UPLOAD_URL_SECRET / SESSION_SECRET. Stage 8 mints the
  // link; Stage 9's OTP portal verifies it. Empty default fails CLOSED: signing
  // or verifying with an empty secret is refused (`portal-link.ts`), so an unset
  // secret cannot mint a forgeable link. REFUSED EMPTY under
  // `NODE_ENV=production` below, for the reason written out at SESSION_SECRET:
  // the Stage 15 env change that made the old "no boot-refusal" stance correct
  // is the same change that made it obsolete.
  PORTAL_LINK_SECRET: z.string().default(''),

  // Signs the portal SESSION bearer (METH Stage 9) — what `POST
  // /v1/portal/sessions` returns and every later portal call sends as
  // `Authorization: Bearer …`. Deliberately a SECOND secret rather than a reuse
  // of PORTAL_LINK_SECRET: the link is a 24 h public URL handed to whoever holds
  // the paperwork, the bearer is a short-lived credential that has already
  // passed the OTP, and one rotation must not be forced to invalidate the other.
  // Same empty-default fail-closed stance as SESSION_SECRET / PORTAL_LINK_SECRET
  // (`portal-session-token.ts` refuses to sign or verify with it), and now the
  // same production boot-refusal below — the three are gated together, because
  // an environment holding one of them and not the others is not a state
  // anybody chose on purpose.
  PORTAL_SESSION_SECRET: z.string().default(''),

  // The ledger adapter (METH Stage 10). `demo` = DemoXeroAdapter — deterministic
  // XERO-INV-#### refs, a simulated per-item delay and one scripted
  // failure-then-retry; the real Xero SDK + OAuth lands behind the same seam.
  // Default `demo` and, today, the ONLY value: a real bill posting into a real
  // client's books is not something an unset variable may cause. Selected by
  // config, not import, like the switches above.
  LEDGER_ADAPTER: z.enum(['demo']).default('demo'),

  // The chat model runtime (Governance §9). `bedrock` = the real thing —
  // Amazon Bedrock, eu-west-2, IAM via the task role, model IDs pinned in
  // `modules/chat-framework/models.ts`. `demo` = a deterministic offline
  // stand-in so unit tests never open a socket and a laptop with no AWS
  // credentials still runs.
  //
  // Defaults to `demo` for the same reason every other switch here does: a
  // fresh clone and CI must work with nothing configured. Unlike the others,
  // `demo` is REFUSED under NODE_ENV=production below — a stand-in classifier
  // answering a real accountant is a different class of wrong from a fixture
  // queue, because the answer looks exactly as authoritative either way.
  //
  // `replay` is EXTRACTOR=replay's sibling, behind the same seam: the REAL
  // `BedrockModelProvider` runs — request building, forced-tool narrowing,
  // §9.2's schema retry, §9.3's error classification — with `messages.create`
  // served from the same cassette directory. A miss fails loudly naming the
  // record command; it never falls through to live Bedrock. REFUSED under
  // NODE_ENV=production below: a replayed classifier answering a real
  // accountant is the AI_CHAT=demo failure told through a transcript.
  AI_CHAT: z.enum(['demo', 'bedrock', 'replay']).default('demo'),

  // The region this runtime talks to is BEDROCK_REGION, declared with
  // BEDROCK_REGION above — one knob for both Bedrock callers, not two. The
  // MODEL each runs is pinned in chat-framework/models.ts, not configured.

  // Per-practice daily AI spend ceiling in integer pence (§9.7). Warn at 80%,
  // hard stop at 100%.
  //
  // £25/day, raised from the £5 demo-scale number by S1. £5 was chosen to be
  // noticeable rather than punitive, which is the right property for a demo and
  // the wrong one for a paying practice: this is a HARD STOP, not a warning, so
  // the day it bites is a day the practice's documents stop being read. At the
  // £0.02/document extraction guardrail (§24.7, S5), £5 buys 250 documents —
  // which a practice clears in one month-end afternoon.
  //
  // £25 is ~1,250 documents/day, more than a practice with fifty client
  // businesses puts through in a normal week, so a real workload never reaches
  // it. It is still a real ceiling rather than a formality: a full day at it
  // costs the gross monthly subscription of about ninety client businesses
  // (£8.50 each, D48), so touching it is an incident to investigate.
  //
  // ⚠ EXTRACTION DOES NOT COUNT AGAINST THIS YET. BedrockExtractor constructs
  // AnthropicBedrock directly and never consults the budget the chat runtime
  // uses, so the per-document arithmetic above describes what the ceiling WILL
  // govern once S5 wires extraction to it — not what it governs today.
  AI_DAILY_BUDGET_PENCE: z.coerce.number().int().positive().default(2500),

  // ---- Billing (D48, launch stage S4) --------------------------------------
  //
  // The Stripe seam. `demo` = `DemoStripeClient`, which mints hosted-session
  // URLs on the reserved `.invalid` TLD (RFC 2606) so a demo checkout link
  // provably cannot resolve to anything; `stripe` = the real hosted Checkout
  // and customer portal. Selected by config, not by import, like every switch
  // above.
  //
  // ⚠ NO production boot-refusal for `demo`, and that is deliberate — the same
  // stance SESSION_SECRET takes and for the same reason. Staging sets
  // NODE_ENV=production for build parity, so a gate here would crash-loop the
  // next staging deploy and take /healthz down before the Stripe secrets are in
  // Secrets Manager. It is also the cheaper failure to leave un-gated: a demo
  // billing client degrades something a user can SEE (the checkout link goes
  // nowhere), unlike AI_CHAT=demo, which degrades the judgement itself while
  // looking identical. Entitlement is enforced from the database either way, so
  // `demo` never means "everything is free".
  BILLING: z.enum(['demo', 'stripe']).default('demo'),

  // Prefer a RESTRICTED key (`rk_…`) over a secret key (`sk_…`): this
  // integration writes customers, checkout sessions and portal sessions and
  // reads nothing else, so a full secret key grants far more than the blast
  // radius needs. Empty default fails CLOSED, like the Meta secrets —
  // `BILLING=stripe` refuses to boot without it below rather than 500ing at the
  // first subscribe.
  STRIPE_SECRET_KEY: z.string().default(''),
  // Signs `POST /v1/webhooks/stripe`. Verified against the RAW body before
  // anything is parsed. Empty = every webhook 401s (fails closed).
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  // The ONE price: "Neo Accounting", GBP 8.50/month recurring, per client
  // business, `tax_behavior=exclusive` (D48 — the price is quoted NET of VAT).
  // A Stripe identifier, so it is configuration and never an enum here.
  STRIPE_PRICE_ID: z.string().default(''),

  // How VAT is added on top of that net price.
  //
  // ⚠ `automatic` (Stripe Tax) collects NOTHING and reports no error until an
  // ACTIVE UK registration exists in the Stripe dashboard — the single most
  // common Stripe Tax mistake, and it looks exactly like a working integration.
  // `rate` attaches an explicit 20% GB rate via `default_tax_rates`, which
  // works with no registration and no VAT number, so it is the default until
  // the VAT registration number exists (docs/runbooks/stripe-billing.md).
  STRIPE_TAX: z.enum(['rate', 'automatic']).default('rate'),
  // The `txr_…` id of that 20% GB VAT rate. Required when STRIPE_TAX=rate.
  STRIPE_TAX_RATE_ID: z.string().default(''),

  // The origins `successUrl` / `cancelUrl` / `returnUrl` may point at, comma
  // separated (e.g. `https://app.neoting.neovogent.com,http://localhost:5173`).
  //
  // ⚠ NOT a convenience. Those three are caller-supplied on AUTHENTICATED
  // endpoints, so an unvalidated one is an open redirect with a session
  // attached to it. Empty means no origin is allowed and every checkout is a
  // 400 — closed, not open.
  BILLING_RETURN_ORIGINS: z.string().default(''),

  S3_ENDPOINT: z.string().default(''), // e.g. http://localhost:9000 for MinIO; empty = AWS default
  S3_REGION: z.string().default('eu-west-2'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  // Coerce the string env value to a real boolean — z.coerce.boolean() treats any
  // non-empty string (including "false") as true, which is the wrong default.
  S3_FORCE_PATH_STYLE: z.string().default('false').transform((value) => value === 'true'),
  S3_BUCKET_DOCUMENTS: z.string().default('nt-local-docs'),
}).superRefine((env, ctx) => {
  // ⚠ A header-trusting auth resolver reaching production is the worst bug this
  // repo could ship, so it is made structurally impossible: `AUTH_MODE=fixture`
  // fails validation — the process never boots — under `NODE_ENV=production`.
  // This is a boot-time gate, not a request-time check, precisely so it cannot be
  // reached by a request at all (issue #75).
  if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'fixture') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AUTH_MODE'],
      message: 'AUTH_MODE=fixture trusts X-NT-* request headers and must never run in production — set AUTH_MODE=session (S1)',
    });
  }

  // A stand-in classifier is indistinguishable from the real one on screen —
  // same cards, same confident wording, same Review → Approve path behind it.
  // Every other `demo` switch in this file degrades something a user can SEE
  // (no SMS arrives, no bill reaches Xero); this one degrades the judgement
  // itself while looking identical, which is why it is the one that refuses to
  // boot rather than merely defaulting safely (Governance §9.1).
  if (env.NODE_ENV === 'production' && env.AI_CHAT === 'demo') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AI_CHAT'],
      message:
        'AI_CHAT=demo is a deterministic stand-in and must never answer a real accountant — set AI_CHAT=bedrock (Governance §9.1)',
    });
  }

  // Replay runs the real adapter over RECORDINGS: any request already recorded
  // is answered with a transcript of an earlier exchange, and any request that
  // is not fails on a missing cassette. In production that is either a real
  // accountant answered by a stale recording or a workspace where every turn
  // errors — both wrong, the first one invisibly so, which is what earns the
  // boot refusal rather than a warning.
  if (env.NODE_ENV === 'production' && env.AI_CHAT === 'replay') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AI_CHAT'],
      message:
        'AI_CHAT=replay answers from recorded cassettes and must never serve production traffic — set AI_CHAT=bedrock (it is a development transport for exercising the real adapter offline)',
    });
  }

  // ── Outbound email (S2) ──────────────────────────────────────────────────
  // Same self-contained-block discipline as the declarations above: three
  // gates, additive, so S1's boot-gate pass merges over them.

  // The AI_CHAT treatment, and for the AI_CHAT reason. `EMAIL_SENDER=demo`
  // "sends" into an in-memory outbox: every call succeeds, every call returns a
  // message id, and no email exists. With SMS cut for Initial Delivery (D40's
  // sibling — the chase channel went with it) email is the client's only
  // channel, so this is not a degraded feature, it is a client who is never
  // contacted, in a workspace where nothing looks wrong. Boot refusal is the
  // cheaper and louder outcome.
  if (env.NODE_ENV === 'production' && env.EMAIL_SENDER === 'demo') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EMAIL_SENDER'],
      message:
        'EMAIL_SENDER=demo sends into an in-memory outbox — every send reports success and no email is delivered. Set EMAIL_SENDER=ses (S2)',
    });
  }

  // The same failure shape one seam up: SMS_SENDER=demo writes the outbox row
  // and contacts nobody — an approved chase that quietly reaches no client.
  // Withheld until infra/envs/staging/services.tf said SMS_SENDER=email; that
  // change and this gate land together (the pairing the SMS_SENDER declaration
  // comment demanded).
  if (env.NODE_ENV === 'production' && env.SMS_SENDER === 'demo') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMS_SENDER'],
      message:
        'SMS_SENDER=demo writes an outbox row and delivers nothing — an approved chase reaches no client. Set SMS_SENDER=email (A13)',
    });
  }

  // In EVERY environment, not just production: `aws` with no origination
  // identity boots green and then refuses every send at request time — the
  // UPLOAD_URL_SECRET failure shape (healthy task, dead feature, first symptom
  // a client who never got their text).
  if (env.SMS_SENDER === 'aws' && env.SMS_ORIGINATION_IDENTITY === '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMS_ORIGINATION_IDENTITY'],
      message:
        'SMS_SENDER=aws needs SMS_ORIGINATION_IDENTITY — the UK dedicated number (or pool) sends originate from. Empty, every send fails at request time.',
    });
  }

  // A real sender with no From address, or none with a configuration set,
  // fails at REQUEST time rather than boot: SES rejects the call, the process
  // is healthy, the ALB is green, and the first symptom is a client who never
  // got their code. The UPLOAD_URL_SECRET argument exactly. The configuration
  // set is in the same gate because without it a send silently opts out of
  // suppression — so we keep mailing addresses that have already bounced,
  // which is the fastest route to the 5% suspension the reputation alarms
  // watch for (observability.tf).
  if (env.EMAIL_SENDER === 'ses' && (env.EMAIL_FROM_ADDRESS === '' || env.EMAIL_CONFIGURATION_SET === '')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EMAIL_SENDER'],
      message:
        'EMAIL_SENDER=ses needs EMAIL_FROM_ADDRESS and EMAIL_CONFIGURATION_SET — without the configuration set a send opts out of bounce suppression and reputation metrics (S2, email.tf)',
    });
  }

  // A per-process limiter in front of a real sender is a limit multiplied by
  // the task count and reported as if it were not. Refused only in production,
  // where there is more than one task: `pnpm dev` is genuinely one process, and
  // gating it there would demand Redis for a laptop that needs none.
  if (env.NODE_ENV === 'production' && env.EMAIL_SENDER === 'ses' && env.EMAIL_RATE_LIMIT === 'memory') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EMAIL_RATE_LIMIT'],
      message:
        'EMAIL_RATE_LIMIT=memory counts per process, and production runs several — the per-address and per-IP ceilings would be multiplied by the task count. Set EMAIL_RATE_LIMIT=redis (S2)',
    });
  }

  // The three HMAC signing keys, gated together.
  //
  // All three already fail closed at REQUEST time: the signers refuse to sign
  // or verify with an empty key, so nothing forgeable is ever minted. The gate
  // exists for the UPLOAD_URL_SECRET reason (#76) — a request-time failure
  // still boots, still passes the ALB health check, still reports steady state,
  // and then 401s every sign-in and refuses every portal link, on a deploy that
  // went green. That reads as a broken product rather than a missing variable,
  // and by the time anyone believes it is a variable the deploy that caused it
  // is several deploys ago.
  //
  // Each of the three carried a comment explaining why it deliberately had NO
  // boot gate. That reasoning was sound while `/neoting/staging/auth` was
  // empty and a gate would have crash-looped `/healthz` over a secret nobody
  // had; METH Stage 15 filled the secret and wired the injections, which is
  // what retired it.
  for (const key of ['SESSION_SECRET', 'PORTAL_LINK_SECRET', 'PORTAL_SESSION_SECRET'] as const) {
    if (env.NODE_ENV === 'production' && env[key] === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} must be set in production — an empty key cannot sign or verify, so the process boots healthy and then refuses every request that needs it (S1)`,
      });
    }
  }

  // DemoExtractor does not degrade the read, it INVENTS it — supplier, date,
  // total, tax and VAT number from a hash of the filename, at 0.8 confidence,
  // which resolveProcessedState reads as Ready. Nothing on the screen
  // distinguishes it from a document that was actually read, which is exactly
  // the AI_CHAT argument above and exactly why this refuses to boot rather than
  // merely defaulting safely.
  if (env.NODE_ENV === 'production' && env.EXTRACTOR === 'demo') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EXTRACTOR'],
      message:
        'EXTRACTOR=demo fabricates supplier, date and total from a filename hash and marks them Ready — set EXTRACTOR=bedrock (S1)',
    });
  }

  // The AI_CHAT=replay gate's twin, and the sharper of the two: a client
  // document is new bytes every time, so in production replay is not even a
  // stale answer — it is a guaranteed cassette miss that fails every document
  // in the practice, or, if a key ever did collide with a recording, one
  // document answered with another document's read. Recordings are a
  // development transport; production reads documents.
  if (env.NODE_ENV === 'production' && env.EXTRACTOR === 'replay') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EXTRACTOR'],
      message:
        'EXTRACTOR=replay answers from recorded cassettes and must never read production documents — a recording of one document is not a reading of another. Set EXTRACTOR=bedrock',
    });
  }

  // `demo` accepts one fixed six-digit code, identical on every account in
  // every practice and on every portal session, published in the source and in
  // the seed. A universal second factor on a workspace holding other people's
  // financial records is not a second factor; it is a longer password field.
  // A2 lands the real verifier behind this same switch — until then `totp`
  // fails every check closed, which is the honest state to be in.
  if (env.NODE_ENV === 'production' && env.OTP_MODE === 'demo') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OTP_MODE'],
      message:
        'OTP_MODE=demo accepts one fixed code on every account in every practice — set OTP_MODE=totp (S1; A2 implements the verifier)',
    });
  }

  // Both fixtures are honest about being fixtures, and both are wrong in a real
  // environment for the same reason: each is SILENT about the format it cannot
  // handle. The passthrough normaliser refuses HEIC — the default camera format
  // on every iPhone since iOS 11, so the format a photographed receipt actually
  // arrives in. The grep guard misses an /Encrypt in a mid-file trailer, which
  // is most signed or form-filled accounting paperwork, and reports clean on a
  // password-protected PDF the pipeline then cannot read.
  if (env.NODE_ENV === 'production' && env.IMAGE_NORMALISER === 'fixture') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['IMAGE_NORMALISER'],
      message:
        'IMAGE_NORMALISER=fixture is a passthrough that refuses HEIC, the format phone photographs arrive in — set IMAGE_NORMALISER=sharp (S1)',
    });
  }

  if (env.NODE_ENV === 'production' && env.DOCUMENT_GUARD === 'fixture') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DOCUMENT_GUARD'],
      message:
        'DOCUMENT_GUARD=fixture greps 8 KB for /Encrypt and reports clean on an incrementally-updated encrypted PDF — set DOCUMENT_GUARD=qpdf (S1)',
    });
  }

  // A media fetcher with no credential cannot fetch anything: every Graph call
  // would 401 and every WhatsApp document would dead-letter, which looks like
  // Meta being down rather than a blank variable. Refuse at boot instead, where
  // the cause is unambiguous (#79).
  if (env.MEDIA_FETCH === 'graph' && env.META_MEDIA_ACCESS_TOKEN === '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['META_MEDIA_ACCESS_TOKEN'],
      message: 'MEDIA_FETCH=graph needs META_MEDIA_ACCESS_TOKEN — a System User bearer with whatsapp_business_messaging, NOT META_APP_SECRET',
    });
  }

  // Real fetches into a fixture store is byte loss dressed as success: the
  // `documents` row persists with an s3_key that names an object in ONE
  // process's memory, gone on restart and invisible to every other process.
  // Every later stage (extraction, the presigned original, sanitisation
  // re-keying) then 404s on a row that looks perfectly healthy. Refuse the
  // combination at boot, where the cause is unambiguous (#79, review of #96).
  if (env.MEDIA_FETCH === 'graph' && env.OBJECT_STORE === 'fixture') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OBJECT_STORE'],
      message: 'MEDIA_FETCH=graph with OBJECT_STORE=fixture persists rows pointing at in-memory bytes — set OBJECT_STORE=s3 (MinIO locally) before fetching real media',
    });
  }

  // Same gate, different failure. An empty UPLOAD_URL_SECRET does fail closed —
  // `requireSecret` refuses to sign or verify with it, so nothing forgeable is
  // ever minted. But it fails closed at REQUEST time, which means the process
  // boots, passes its ALB health check, reports steady state, and then 500s
  // every upload. That reads as a broken lane rather than a missing variable,
  // and the deploy that caused it is already green.
  //
  // This is where it differs from the Meta secrets, which use the same empty
  // default: an unset META_APP_SECRET rejects a webhook Meta may never send to
  // that environment anyway. UPLOAD_URL_SECRET gates the whole web-upload lane,
  // so a boot failure is the cheaper and louder outcome (found by review of #76).
  if (env.NODE_ENV === 'production' && env.UPLOAD_URL_SECRET === '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['UPLOAD_URL_SECRET'],
      message: 'UPLOAD_URL_SECRET must be set in production — an empty secret cannot sign or verify upload intents, so every upload would 500 (#76)',
    });
  }

  // The SES receipt prefix is REAL client mail, and the poller DELETES an email
  // from it once processed. Handing real mail to a fixture queue (in-memory,
  // gone on restart) or a fixture store (the sanitised bytes live in one
  // process's memory) and then deleting the source is destruction dressed as a
  // clean drain. MailHog is exempt: it is a dev tool holding dev mail, and the
  // fixture combination is exactly how it is used on a laptop (#78, review of
  // #97).
  if (env.EMAIL_SOURCE === 's3' && (env.INGEST_QUEUE === 'fixture' || env.OBJECT_STORE === 'fixture')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EMAIL_SOURCE'],
      message:
        'EMAIL_SOURCE=s3 polls real SES mail and deletes it after processing — it needs INGEST_QUEUE=bullmq and OBJECT_STORE=s3, or a restart destroys everything in flight',
    });
  }

  // `BILLING=stripe` is an operator saying "take real money". Every one of these
  // is unreachable-at-boot rather than 500-at-checkout for the UPLOAD_URL_SECRET
  // reason: an empty value fails closed at REQUEST time, which means the process
  // boots, passes its health check, reports steady state, and then breaks the one
  // screen that turns a trial into a customer — while the deploy that caused it
  // is already green. This cannot crash-loop staging, because staging stays on
  // `BILLING=demo` until the secrets are actually in Secrets Manager (S4).
  if (env.BILLING === 'stripe') {
    if (env.STRIPE_SECRET_KEY === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STRIPE_SECRET_KEY'],
        message: 'BILLING=stripe needs STRIPE_SECRET_KEY — prefer a restricted key (rk_…) scoped to customers, checkout sessions and billing portal sessions',
      });
    }
    if (env.STRIPE_WEBHOOK_SECRET === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STRIPE_WEBHOOK_SECRET'],
        message: 'BILLING=stripe needs STRIPE_WEBHOOK_SECRET — without it every Stripe event 401s and no subscription ever becomes ACTIVE, which reads as "the card was declined"',
      });
    }
    if (env.STRIPE_PRICE_ID === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STRIPE_PRICE_ID'],
        message: 'BILLING=stripe needs STRIPE_PRICE_ID — the one GBP 8.50/month tax-EXCLUSIVE price (D48)',
      });
    }
    if (env.BILLING_RETURN_ORIGINS === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BILLING_RETURN_ORIGINS'],
        message: 'BILLING=stripe needs BILLING_RETURN_ORIGINS — the allowlist successUrl/cancelUrl/returnUrl are checked against; empty admits no origin and refuses every checkout',
      });
    }
    // ⚠ The VAT trap, made structural. `STRIPE_TAX=rate` with no rate id does
    // not fail — it charges 8.50 with no VAT line, which HMRC treats as
    // VAT-INCLUSIVE, so we would absorb the VAT and receive £7.08 per client
    // per month. There is no error and no alert; the only symptom is a smaller
    // number on a Stripe invoice nobody re-reads.
    if (env.STRIPE_TAX === 'rate' && env.STRIPE_TAX_RATE_ID === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STRIPE_TAX_RATE_ID'],
        message: 'STRIPE_TAX=rate needs STRIPE_TAX_RATE_ID (the 20% GB VAT txr_… id) — without it the net price is charged with no VAT added, which means absorbing the VAT',
      });
    }
  }
});

export type Env = Readonly<z.infer<typeof EnvSchema>>;

/**
 * Derive `REDIS_URL` from the parts ECS actually injects.
 *
 * ⚠ THIS IS NOT A CONVENIENCE. Without it the deployed workers service is
 * broken in the quietest possible way: the task definitions supply
 * `REDIS_HOST` / `REDIS_PORT` / `REDIS_TLS` and a `REDIS_AUTH_TOKEN` secret,
 * none of which the schema above reads, so `REDIS_URL` falls back to its
 * `redis://localhost:6379` default and a worker container reconnect-loops
 * against itself. It never crashes, so nothing alarms; the queue simply grows.
 * That is why `workers` sat at desired_count = 0.
 *
 * An ECS `secrets` entry cannot be interpolated into another environment
 * variable, so the join has to happen in the process that reads them — here.
 *
 * An explicitly-set `REDIS_URL` always wins. That keeps `.env` and
 * docker-compose working unchanged, and gives anyone debugging an escape hatch
 * that does not involve editing a task definition.
 */
function withDerivedRedisUrl(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (source.REDIS_URL || !source.REDIS_HOST) return source;

  return {
    ...source,
    REDIS_URL: composeRedisUrl({
      host: source.REDIS_HOST,
      port: source.REDIS_PORT ?? '6379',
      // The string 'true', not truthiness — 'false' is a non-empty string and
      // would otherwise enable TLS against a cluster that does not speak it.
      tls: source.REDIS_TLS === 'true',
      password: source.REDIS_AUTH_TOKEN,
    }),
  };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(withDerivedRedisUrl(source));
  if (!parsed.success) {
    // Fail fast and loud — but never print the values, they may be secret.
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return Object.freeze(parsed.data);
}
