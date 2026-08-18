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
   * without touching a call site. That column is `prisma/`, so G7 — raised on #79.
   *
   * Fails CLOSED: an unmapped number yields no anchor, the worker refuses to
   * persist and the job lands in the DLQ. It is never a quiet success that wrote
   * nothing.
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
  // forgeable session. Deliberately NO production boot-refusal (unlike
  // UPLOAD_URL_SECRET): staging already runs AUTH_MODE=session without this
  // variable, and a boot gate added here would crash-loop the next staging
  // deploy — taking /healthz down — instead of leaving session endpoints
  // failing closed exactly as they do today. The staging value lands with the
  // Stage 15 env change, not with this code.
  SESSION_SECRET: z.string().default(''),

  // TOTP verification mode (METH Stage 1). `demo` accepts the literal fixed
  // code and nothing else — the only value until Twilio Verify replaces it
  // post-demo. // DEMO-MOCK: Twilio Verify (real TOTP/OTP) replaces this.
  OTP_MODE: z.enum(['demo']).default('demo'),

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
  // not be handed to a real decoder that correctly rejects it.
  IMAGE_NORMALISER: z.enum(['fixture', 'sharp']).default('fixture'),

  // The PDF guard (#22). `fixture` = the dependency-free /Encrypt grep, which
  // has a known false-negative on incrementally-updated PDFs; `qpdf` = the real
  // one. Defaults to fixture so a machine without the binary still runs tests.
  DOCUMENT_GUARD: z.enum(['fixture', 'qpdf']).default('fixture'),

  // The document extractor (METH Stage 4). `demo` = the deterministic fixture
  // engine that moves documents out of RECEIVED; Textract + the vision ladder
  // lands behind the same seam later. Default `demo` so a document actually gets
  // extracted — that is the whole point of the step. Selected by config, not import.
  EXTRACTOR: z.enum(['demo']).default('demo'),

  // The SMS sender (METH Stage 8). `demo` = `DemoSmsSender`, which "sends" by
  // writing the outbox rows the SMS-outbox screen reads — no Twilio, ever, in
  // this push. The only value until Twilio Messaging lands behind the same seam
  // post-demo. Selected by config, not import, exactly like EXTRACTOR / MEDIA_FETCH.
  // DEMO-MOCK: Twilio Messaging replaces `DemoSmsSender`.
  SMS_SENDER: z.enum(['demo']).default('demo'),

  // Signs the chase portal-link token (METH Stage 8, SoT §4 Stage 8.3) — the
  // same HMAC pattern as UPLOAD_URL_SECRET / SESSION_SECRET. Stage 8 mints the
  // link; Stage 9's OTP portal verifies it. Empty default fails CLOSED: signing
  // or verifying with an empty secret is refused (`portal-link.ts`), so an unset
  // secret cannot mint a forgeable link. No production boot-refusal, matching
  // SESSION_SECRET's stance (the portal endpoints simply fail closed until the
  // Stage 15 env change sets it, rather than crash-looping /healthz).
  PORTAL_LINK_SECRET: z.string().default(''),
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
