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

  // The request-context resolver (#75). `fixture` = trust `X-NT-*` dev headers
  // (default — lets endpoints exercise scopedDb before auth exists); `session` =
  // the real S1 resolver (not yet implemented). Selected by config, not import,
  // like the others. ⚠ `fixture` is REFUSED under `NODE_ENV=production` below.
  AUTH_MODE: z.enum(['fixture', 'session']).default('fixture'),

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
